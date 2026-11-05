import { randomBytes } from "node:crypto";
import pg from "pg";
import { getDatabaseSsl } from "./lib/database.mjs";
import {
  createOpaqueToken,
  getSessionCookie,
  hashPassword,
  hashToken,
  isValidEmail,
  normalizeClient,
  normalizeEmail,
  parseCookies,
  validateCheckIn,
  validateProfile,
  validateProgress,
  verifyPassword,
} from "./lib/accounts.mjs";

const SESSION_COOKIE = "fitness_session";
const SESSION_LIFETIME_MS = 14 * 24 * 60 * 60 * 1000;
const MAX_BODY_BYTES = 4 * 1024 * 1024;
const MIN_PASSWORD_LENGTH = 12;

const pool = globalThis.__fitnessPgPool || new pg.Pool({
  connectionString: process.env.DATABASE_URL,
  max: 5,
  idleTimeoutMillis: 10_000,
  connectionTimeoutMillis: 5_000,
  ssl: getDatabaseSsl(process.env.DATABASE_URL),
});
globalThis.__fitnessPgPool = pool;

function send(response, status, payload, headers = {}) {
  response.statusCode = status;
  response.setHeader("Content-Type", "application/json; charset=utf-8");
  response.setHeader("Cache-Control", "no-store");
  response.setHeader("X-Content-Type-Options", "nosniff");
  response.setHeader("X-Frame-Options", "DENY");
  response.setHeader("Referrer-Policy", "strict-origin-when-cross-origin");
  for (const [name, value] of Object.entries(headers)) response.setHeader(name, value);
  response.end(JSON.stringify(payload));
}

async function readJson(request) {
  if (request.body && typeof request.body === "object") {
    if (Buffer.byteLength(JSON.stringify(request.body), "utf8") > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    if (Array.isArray(request.body)) {
      const error = new Error("Request body must be a JSON object.");
      error.status = 400;
      throw error;
    }
    return request.body;
  }
  let size = 0;
  const chunks = [];
  for await (const chunk of request) {
    size += chunk.length;
    if (size > MAX_BODY_BYTES) {
      const error = new Error("Request body is too large.");
      error.status = 413;
      throw error;
    }
    chunks.push(chunk);
  }
  let body;
  try {
    body = JSON.parse(Buffer.concat(chunks).toString("utf8") || "{}");
  } catch {
    const error = new Error("Request body must be valid JSON.");
    error.status = 400;
    throw error;
  }
  if (!body || typeof body !== "object" || Array.isArray(body)) {
    const error = new Error("Request body must be a JSON object.");
    error.status = 400;
    throw error;
  }
  return body;
}

function accountView(account) {
  return { id: account.id, email: account.email, role: account.role };
}

function getClientAddress(request) {
  for (const headerName of ["x-real-ip", "x-vercel-forwarded-for"]) {
    const value = request.headers[headerName];
    if (typeof value === "string" && value.trim()) return value.split(",")[0].trim();
  }
  if (request.socket?.remoteAddress) return request.socket.remoteAddress;
  const forwarded = request.headers["x-forwarded-for"];
  return typeof forwarded === "string" && forwarded.trim() ? forwarded.split(",")[0].trim() : "unknown";
}

function requestIsSecure(request) {
  const forwardedProtocol = String(request.headers["x-forwarded-proto"] || "").split(",")[0].trim();
  return forwardedProtocol === "https" || new URL(request.url, "http://localhost").protocol === "https:";
}

function isSameOrigin(request) {
  const origin = request.headers.origin;
  if (!origin) return false;
  try {
    const requestUrl = /^https?:\/\//i.test(request.url || "") ? new URL(request.url) : null;
    const requestOrigin = requestUrl?.origin
      || `${requestIsSecure(request) ? "https" : "http"}://${request.headers.host}`;
    const expectedOrigin = process.env.APP_URL ? new URL(process.env.APP_URL).origin : requestOrigin;
    return new URL(origin).origin === expectedOrigin;
  } catch {
    return false;
  }
}

async function requireSession(request) {
  const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
  if (!token || token.length > 128) return null;
  const result = await pool.query(
    `SELECT accounts.id, accounts.email, accounts.role
       FROM psf_sessions AS sessions JOIN psf_accounts AS accounts ON accounts.id = sessions.account_id
      WHERE sessions.token_hash = $1 AND sessions.expires_at > NOW()`,
    [hashToken(token)],
  );
  return result.rows[0] || null;
}

async function withTransaction(callback) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");
    const result = await callback(client);
    await client.query("COMMIT");
    return result;
  } catch (error) {
    await client.query("ROLLBACK");
    throw error;
  } finally {
    client.release();
  }
}

async function createSession(accountId, request) {
  const token = createOpaqueToken();
  const expiresAt = new Date(Date.now() + SESSION_LIFETIME_MS);
  await pool.query(
    "INSERT INTO psf_sessions (token_hash, account_id, expires_at) VALUES ($1, $2, $3)",
    [hashToken(token), accountId, expiresAt],
  );
  return getSessionCookie(token, { secure: requestIsSecure(request) });
}

async function signUp(body, request, response) {
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return send(response, 400, { error: "Enter a valid email address." });
  if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD_LENGTH || body.password.length > 128) {
    return send(response, 400, { error: `Use a password between ${MIN_PASSWORD_LENGTH} and 128 characters.` });
  }
  if (await isRateLimited(`signup|${getClientAddress(request)}`, 5, "1 hour")) {
    return send(response, 429, { error: "Too many account creation attempts. Wait an hour and try again." });
  }
  const passwordHash = await hashPassword(body.password);
  try {
    const account = await withTransaction(async (client) => {
      const inserted = await client.query(
        "INSERT INTO psf_accounts (email, password_hash, role) VALUES ($1, $2, 'coach') RETURNING id, email, role",
        [email, passwordHash],
      );
      await client.query("INSERT INTO psf_coach_workspaces (coach_id) VALUES ($1)", [inserted.rows[0].id]);
      await client.query("INSERT INTO psf_workspace_versions (coach_id) VALUES ($1)", [inserted.rows[0].id]);
      return inserted.rows[0];
    });
    const cookie = await createSession(account.id, request);
    return send(response, 201, { user: accountView(account) }, { "Set-Cookie": cookie });
  } catch (error) {
    if (error.code === "23505") return send(response, 409, { error: "An account with that email already exists." });
    throw error;
  }
}

async function isRateLimited(value, limit, window) {
  const identifier = hashToken(value);
  await pool.query("DELETE FROM psf_auth_attempts WHERE created_at < NOW() - INTERVAL '1 day'");
  const result = await pool.query(
    `WITH recent AS (
       SELECT COUNT(*)::int AS count
         FROM psf_auth_attempts
        WHERE identifier_hash = $1 AND created_at > NOW() - $3::interval
     ), recorded AS (
       INSERT INTO psf_auth_attempts (identifier_hash)
       SELECT $1 WHERE (SELECT count FROM recent) < $2
       RETURNING identifier_hash
     )
     SELECT (SELECT count FROM recent) >= $2 AS limited,
            (SELECT COUNT(*) FROM recorded)::int AS recorded`,
    [identifier, limit, window],
  );
  return Boolean(result.rows[0]?.limited);
}

async function login(body, request, response) {
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email) || typeof body.password !== "string") {
    return send(response, 400, { error: "Enter a valid email address and password." });
  }
  const result = await pool.query(
    "SELECT id, email, password_hash, role FROM psf_accounts WHERE email = $1",
    [email],
  );
  const account = result.rows[0];
  const storedHash = account?.password_hash || "scrypt$00000000000000000000000000000000$" + "0".repeat(128);
  const passwordMatches = await verifyPassword(body.password, storedHash);
  if (!account || !passwordMatches) {
    const limited = await isRateLimited(`${email}|${getClientAddress(request)}`, 10, "15 minutes");
    return send(response, limited ? 429 : 401, {
      error: limited ? "Too many sign-in attempts. Wait 15 minutes and try again." : "Email or password is incorrect.",
    });
  }
  const cookie = await createSession(account.id, request);
  return send(response, 200, { user: accountView(account) }, { "Set-Cookie": cookie });
}

async function requestPasswordReset(body, request, response) {
  const email = normalizeEmail(body.email);
  if (!isValidEmail(email)) return send(response, 400, { error: "Enter a valid email address." });
  if (!process.env.RESEND_API_KEY || !process.env.EMAIL_FROM || !process.env.APP_URL) {
    return send(response, 503, { error: "Password recovery is not configured. Set RESEND_API_KEY, EMAIL_FROM, and APP_URL." });
  }
  if (await isRateLimited(`password-reset|${email}|${getClientAddress(request)}`, 5, "1 hour")) {
    return send(response, 429, { error: "Too many recovery requests. Wait an hour and try again." });
  }
  const accountResult = await pool.query("SELECT id, email FROM psf_accounts WHERE email = $1", [email]);
  if (!accountResult.rows[0]) {
    return send(response, 200, { ok: true, message: "If an account exists for that email, a recovery link has been sent." });
  }

  const token = createOpaqueToken();
  await pool.query("DELETE FROM psf_password_resets WHERE expires_at <= NOW() OR used_at IS NOT NULL");
  await pool.query("DELETE FROM psf_password_resets WHERE account_id = $1", [accountResult.rows[0].id]);
  await pool.query(
    `INSERT INTO psf_password_resets (token_hash, account_id, expires_at)
     VALUES ($1, $2, NOW() + INTERVAL '30 minutes')`,
    [hashToken(token), accountResult.rows[0].id],
  );
  const resetUrl = new URL("/", process.env.APP_URL);
  resetUrl.searchParams.set("reset", token);
  let delivery;
  try {
    delivery = await fetch("https://api.resend.com/emails", {
      method: "POST",
      headers: {
        Authorization: `Bearer ${process.env.RESEND_API_KEY}`,
        "Content-Type": "application/json",
      },
      body: JSON.stringify({
        from: process.env.EMAIL_FROM,
        to: [email],
        subject: "Reset your Prakhar Singh Fitness password",
        text: `Use this one-time link within 30 minutes to reset your password:\n\n${resetUrl}\n\nIf you did not request this, you can ignore this email.`,
      }),
    });
  } catch (error) {
    await pool.query("DELETE FROM psf_password_resets WHERE token_hash = $1", [hashToken(token)]);
    console.error("Password recovery email delivery failed:", error.message);
    return send(response, 503, { error: "The recovery email could not be sent. Check the email provider configuration and try again." });
  }
  if (!delivery.ok) {
    await pool.query("DELETE FROM psf_password_resets WHERE token_hash = $1", [hashToken(token)]);
    console.error("Password recovery email provider rejected the request:", delivery.status);
    return send(response, 503, { error: "The recovery email could not be sent. Check the email provider configuration and try again." });
  }
  return send(response, 200, { ok: true, message: "If an account exists for that email, a recovery link has been sent." });
}

async function resetPassword(body, response) {
  const token = typeof body.token === "string" ? body.token : "";
  if (!token || token.length > 128) return send(response, 400, { error: "This recovery link is invalid or expired." });
  if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD_LENGTH || body.password.length > 128) {
    return send(response, 400, { error: `Use a password between ${MIN_PASSWORD_LENGTH} and 128 characters.` });
  }
  const passwordHash = await hashPassword(body.password);
  const result = await withTransaction(async (database) => {
    const reset = await database.query(
      `SELECT account_id FROM psf_password_resets
        WHERE token_hash = $1 AND used_at IS NULL AND expires_at > NOW()
        FOR UPDATE`,
      [hashToken(token)],
    );
    if (!reset.rows[0]) return false;
    await database.query(
      "UPDATE psf_accounts SET password_hash = $1 WHERE id = $2",
      [passwordHash, reset.rows[0].account_id],
    );
    await database.query(
      "UPDATE psf_password_resets SET used_at = NOW() WHERE token_hash = $1",
      [hashToken(token)],
    );
    await database.query(
      "DELETE FROM psf_sessions WHERE account_id = $1",
      [reset.rows[0].account_id],
    );
    await database.query(
      "DELETE FROM psf_password_resets WHERE account_id = $1 AND token_hash <> $2",
      [reset.rows[0].account_id, hashToken(token)],
    );
    return true;
  });
  if (!result) return send(response, 400, { error: "This recovery link is invalid, expired, or already used." });
  return send(response, 200, { ok: true, message: "Password updated. Sign in with your new password." });
}

async function acceptInvite(body, request, response) {
  const token = typeof body.token === "string" ? body.token : "";
  const email = normalizeEmail(body.email);
  if (!token || token.length > 128 || !isValidEmail(email)) {
    return send(response, 400, { error: "This invitation is invalid or incomplete." });
  }
  if (typeof body.password !== "string" || body.password.length < MIN_PASSWORD_LENGTH || body.password.length > 128) {
    return send(response, 400, { error: `Use a password between ${MIN_PASSWORD_LENGTH} and 128 characters.` });
  }
  const passwordHash = await hashPassword(body.password);
  try {
    const account = await withTransaction(async (client) => {
      const ownerResult = await client.query(
        "SELECT coach_id FROM psf_client_invites WHERE token_hash = $1 AND redeemed_at IS NULL AND expires_at > NOW()",
        [hashToken(token)],
      );
      if (!ownerResult.rows[0]) return null;
      const workspaceLock = await client.query(
        "SELECT version FROM psf_workspace_versions WHERE coach_id = $1 FOR UPDATE",
        [ownerResult.rows[0].coach_id],
      );
      if (!workspaceLock.rows[0]) return null;
      const inviteResult = await client.query(
        `SELECT invites.coach_id, invites.client_id, clients.email
           FROM psf_client_invites AS invites
           JOIN psf_clients AS clients ON clients.id = invites.client_id AND clients.coach_id = invites.coach_id
          WHERE invites.token_hash = $1 AND invites.redeemed_at IS NULL
            AND invites.expires_at > NOW() AND clients.linked_account_id IS NULL
          FOR UPDATE OF invites, clients`,
        [hashToken(token)],
      );
      const invite = inviteResult.rows[0];
      if (!invite || invite.email !== email) return null;
      const inserted = await client.query(
        "INSERT INTO psf_accounts (email, password_hash, role) VALUES ($1, $2, 'client') RETURNING id, email, role",
        [email, passwordHash],
      );
      const redeemed = await client.query(
        "UPDATE psf_client_invites SET redeemed_at = NOW() WHERE token_hash = $1 AND redeemed_at IS NULL",
        [hashToken(token)],
      );
      if (redeemed.rowCount !== 1) throw new Error("This invitation has already been used.");
      await client.query(
        "UPDATE psf_clients SET linked_account_id = $1, updated_at = NOW() WHERE id = $2 AND coach_id = $3",
        [inserted.rows[0].id, invite.client_id, invite.coach_id],
      );
      await client.query(
        "UPDATE psf_workspace_versions SET version = version + 1, updated_at = NOW() WHERE coach_id = $1",
        [invite.coach_id],
      );
      return inserted.rows[0];
    });
    if (!account) return send(response, 400, { error: "This invitation is expired, used, or belongs to a different email." });
    const cookie = await createSession(account.id, request);
    return send(response, 201, { user: accountView(account) }, { "Set-Cookie": cookie });
  } catch (error) {
    if (error.code === "23505") return send(response, 409, { error: "An account with that email already exists." });
    throw error;
  }
}

async function loadWorkspace(account) {
  if (account.role === "coach") {
    const [workspaceResult, clientsResult, versionResult, checkinsResult] = await Promise.all([
      pool.query("SELECT profile, progress FROM psf_coach_workspaces WHERE coach_id = $1", [account.id]),
      pool.query(
        `SELECT id, name, email, profile, progress, linked_account_id IS NOT NULL AS has_account
           FROM psf_clients WHERE coach_id = $1 ORDER BY created_at ASC`,
        [account.id],
      ),
      pool.query("SELECT version FROM psf_workspace_versions WHERE coach_id = $1", [account.id]),
      pool.query(
        `SELECT checkins.id, checkins.client_id AS "clientId", clients.name AS "clientName",
                checkins.week_start AS "weekStart", checkins.adherence,
                checkins.workouts_completed AS "workoutsCompleted", checkins.energy,
                checkins.notes, checkins.coach_response AS "coachResponse",
                checkins.submitted_at AS "submittedAt", checkins.coach_replied_at AS "coachRepliedAt"
           FROM psf_checkins AS checkins
           JOIN psf_clients AS clients ON clients.id = checkins.client_id
          WHERE checkins.coach_id = $1
          ORDER BY checkins.week_start DESC, checkins.submitted_at DESC`,
        [account.id],
      ),
    ]);
    const workspace = workspaceResult.rows[0] || { profile: {}, progress: [] };
    return {
      profile: workspace.profile,
      progress: workspace.progress,
      version: versionResult.rows[0]?.version || "0",
      checkIns: checkinsResult.rows,
      clients: clientsResult.rows.map(({ id, name, email, profile, progress, has_account }) => ({
        id, name, email, profile, progress, hasAccount: has_account,
      })),
    };
  }
  const [result, checkinsResult] = await Promise.all([
    pool.query(
      `SELECT clients.id, clients.coach_id, clients.profile, clients.progress, workspace_versions.version
         FROM psf_clients AS clients JOIN psf_workspace_versions AS workspace_versions ON workspace_versions.coach_id = clients.coach_id
        WHERE clients.linked_account_id = $1`,
      [account.id],
    ),
    pool.query(
      `SELECT checkins.id, checkins.week_start AS "weekStart", checkins.adherence,
              checkins.workouts_completed AS "workoutsCompleted", checkins.energy,
              checkins.notes, checkins.coach_response AS "coachResponse",
              checkins.submitted_at AS "submittedAt", checkins.coach_replied_at AS "coachRepliedAt"
         FROM psf_checkins AS checkins
         JOIN psf_clients AS clients ON clients.id = checkins.client_id
        WHERE clients.linked_account_id = $1
        ORDER BY checkins.week_start DESC`,
      [account.id],
    ),
  ]);
  if (!result.rows[0]) {
    const error = new Error("This client account is no longer linked to a client profile.");
    error.status = 403;
    throw error;
  }
  return {
    profile: result.rows[0].profile,
    progress: result.rows[0].progress,
    clients: [],
    checkIns: checkinsResult.rows,
    clientId: result.rows[0].id,
    version: result.rows[0].version,
  };
}

async function submitCheckIn(account, body) {
  if (account.role !== "client") return { status: 403, error: "Only a client account can submit a check-in." };
  const validation = validateCheckIn(body);
  if (!validation.valid) return { status: 400, error: validation.error };
  const { weekStart, adherence, workoutsCompleted, energy, notes } = validation.value;
  const weekDate = new Date(`${weekStart}T00:00:00.000Z`);
  const today = new Date();
  const monday = new Date(Date.UTC(today.getUTCFullYear(), today.getUTCMonth(), today.getUTCDate()));
  monday.setUTCDate(monday.getUTCDate() - ((monday.getUTCDay() + 6) % 7));
  const daysFromCurrentWeek = Math.round((weekDate.getTime() - monday.getTime()) / 86_400_000);
  if (daysFromCurrentWeek < -14 || daysFromCurrentWeek > 7) {
    return { status: 400, error: "Check-ins can be submitted for this week or either of the previous two weeks." };
  }

  return withTransaction(async (database) => {
    const linked = await database.query(
      "SELECT id, coach_id FROM psf_clients WHERE linked_account_id = $1",
      [account.id],
    );
    if (!linked.rows[0]) return { status: 403, error: "This client account is no longer linked to a profile." };
    const { id: clientId, coach_id: coachId } = linked.rows[0];
    await database.query("INSERT INTO psf_workspace_versions (coach_id) VALUES ($1) ON CONFLICT DO NOTHING", [coachId]);
    await database.query("SELECT version FROM psf_workspace_versions WHERE coach_id = $1 FOR UPDATE", [coachId]);
    const stillLinked = await database.query(
      "SELECT id FROM psf_clients WHERE id = $1 AND coach_id = $2 AND linked_account_id = $3 FOR UPDATE",
      [clientId, coachId, account.id],
    );
    if (!stillLinked.rows[0]) return { status: 403, error: "This client account is no longer linked to a profile." };
    const saved = await database.query(
      `INSERT INTO psf_checkins (coach_id, client_id, week_start, adherence, workouts_completed, energy, notes)
       VALUES ($1, $2, $3, $4, $5, $6, $7)
       ON CONFLICT (client_id, week_start) DO UPDATE SET
         adherence = EXCLUDED.adherence,
         workouts_completed = EXCLUDED.workouts_completed,
         energy = EXCLUDED.energy,
         notes = EXCLUDED.notes,
         coach_response = '',
         coach_replied_at = NULL,
         submitted_at = NOW()
       RETURNING id, week_start AS "weekStart", adherence,
                 workouts_completed AS "workoutsCompleted", energy, notes,
                 coach_response AS "coachResponse", submitted_at AS "submittedAt",
                 coach_replied_at AS "coachRepliedAt"`,
      [coachId, clientId, weekStart, adherence, workoutsCompleted, energy, notes.trim()],
    );
    const version = await database.query(
      "UPDATE psf_workspace_versions SET version = version + 1, updated_at = NOW() WHERE coach_id = $1 RETURNING version",
      [coachId],
    );
    return { status: 200, ok: true, checkIn: saved.rows[0], version: version.rows[0].version };
  });
}

async function saveCoachResponse(account, checkInId, body) {
  if (account.role !== "coach") return { status: 403, error: "Only the coach can respond to a check-in." };
  if (typeof body.response !== "string" || body.response.trim().length > 1000) {
    return { status: 400, error: "Coach responses must be 1,000 characters or fewer." };
  }
  return withTransaction(async (database) => {
    const owned = await database.query(
      "SELECT id FROM psf_checkins WHERE id = $1 AND coach_id = $2",
      [checkInId, account.id],
    );
    if (!owned.rows[0]) return { status: 404, error: "This check-in was not found in your workspace." };
    await database.query("SELECT version FROM psf_workspace_versions WHERE coach_id = $1 FOR UPDATE", [account.id]);
    const updated = await database.query(
      `UPDATE psf_checkins SET coach_response = $1, coach_replied_at = NOW()
        WHERE id = $2 AND coach_id = $3
        RETURNING id, coach_response AS "coachResponse", coach_replied_at AS "coachRepliedAt"`,
      [body.response.trim(), checkInId, account.id],
    );
    const version = await database.query(
      "UPDATE psf_workspace_versions SET version = version + 1, updated_at = NOW() WHERE coach_id = $1 RETURNING version",
      [account.id],
    );
    return { status: 200, ok: true, checkIn: updated.rows[0], version: version.rows[0].version };
  });
}

async function saveWorkspace(account, body) {
  if (body.version === undefined || !["string", "number"].includes(typeof body.version)) {
    return { status: 400, error: "Workspace version is required. Reload the workspace and try again." };
  }
  const profile = validateProfile(body.profile);
  const progress = validateProgress(body.progress);
  if (!profile.valid) return { status: 400, error: profile.error };
  if (!progress.valid) return { status: 400, error: progress.error };

  if (account.role === "client") {
    const result = await withTransaction(async (database) => {
      const linked = await database.query(
        "SELECT coach_id FROM psf_clients WHERE linked_account_id = $1",
        [account.id],
      );
      if (!linked.rows[0]) return { status: 403, error: "This client account is no longer linked to a profile." };
      await database.query("INSERT INTO psf_workspace_versions (coach_id) VALUES ($1) ON CONFLICT DO NOTHING", [linked.rows[0].coach_id]);
      const versionResult = await database.query(
        "SELECT version FROM psf_workspace_versions WHERE coach_id = $1 FOR UPDATE",
        [linked.rows[0].coach_id],
      );
      const version = versionResult.rows[0].version;
      if (!body.force && String(body.version) !== String(version)) {
        return { status: 409, error: "This workspace changed on another device. Load the latest version before saving.", version };
      }
      const updated = await database.query(
        `UPDATE psf_clients SET profile = $1::jsonb, progress = $2::jsonb, updated_at = NOW()
          WHERE linked_account_id = $3`,
        [JSON.stringify(profile.value), JSON.stringify(progress.value), account.id],
      );
      if (updated.rowCount !== 1) return { status: 403, error: "This client account is no longer linked to a profile." };
      const next = await database.query(
        "UPDATE psf_workspace_versions SET version = version + 1, updated_at = NOW() WHERE coach_id = $1 RETURNING version",
        [linked.rows[0].coach_id],
      );
      return { status: 200, ok: true, version: next.rows[0].version };
    });
    return result;
  }

  if (!Array.isArray(body.clients) || body.clients.length > 1000) {
    return { status: 400, error: "Client list must contain up to 1,000 profiles." };
  }
  const clients = [];
  const ids = new Set();
  for (const rawClient of body.clients) {
    const client = normalizeClient(rawClient);
    if (!client.valid) return { status: 400, error: client.error };
    if (ids.has(client.value.id)) return { status: 400, error: "Client IDs must be unique." };
    ids.add(client.value.id);
    clients.push(client.value);
  }

  const result = await withTransaction(async (client) => {
    await client.query("INSERT INTO psf_workspace_versions (coach_id) VALUES ($1) ON CONFLICT DO NOTHING", [account.id]);
    const currentVersion = await client.query(
      "SELECT version FROM psf_workspace_versions WHERE coach_id = $1 FOR UPDATE",
      [account.id],
    );
    const version = currentVersion.rows[0].version;
    if (!body.force && String(body.version) !== String(version)) {
      return { status: 409, error: "This workspace changed on another device. Load the latest version before saving.", version };
    }

    await client.query(
      `INSERT INTO psf_coach_workspaces (coach_id, profile, progress, updated_at)
       VALUES ($1, $2::jsonb, $3::jsonb, NOW())
       ON CONFLICT (coach_id) DO UPDATE
       SET profile = EXCLUDED.profile, progress = EXCLUDED.progress, updated_at = NOW()`,
      [account.id, JSON.stringify(profile.value), JSON.stringify(progress.value)],
    );
    for (const item of clients) {
      const upsert = await client.query(
        `INSERT INTO psf_clients (id, coach_id, name, email, profile, progress)
         VALUES ($1, $2, $3, $4, $5::jsonb, $6::jsonb)
         ON CONFLICT (id) DO UPDATE SET
           name = EXCLUDED.name,
           email = CASE WHEN psf_clients.linked_account_id IS NULL THEN EXCLUDED.email ELSE psf_clients.email END,
           profile = EXCLUDED.profile,
           progress = EXCLUDED.progress,
           updated_at = NOW()
         WHERE psf_clients.coach_id = EXCLUDED.coach_id`,
        [item.id, account.id, item.name, item.email, JSON.stringify(item.profile), JSON.stringify(item.progress)],
      );
      if (upsert.rowCount !== 1) {
        const error = new Error("A client profile could not be saved.");
        error.status = 409;
        throw error;
      }
    }

    const removed = await client.query(
      `DELETE FROM psf_clients WHERE coach_id = $1 AND NOT (id = ANY($2::text[]))
       RETURNING linked_account_id`,
      [account.id, [...ids]],
    );
    const removedAccountIds = removed.rows.map((row) => row.linked_account_id).filter(Boolean);
    if (removedAccountIds.length) {
      await client.query("DELETE FROM psf_accounts WHERE id = ANY($1::uuid[]) AND role = 'client'", [removedAccountIds]);
    }
    const nextVersion = await client.query(
      "UPDATE psf_workspace_versions SET version = version + 1, updated_at = NOW() WHERE coach_id = $1 RETURNING version",
      [account.id],
    );
    return { status: 200, ok: true, version: nextVersion.rows[0].version };
  });
  return result;
}

async function route(request, response, account) {
  const { pathname } = new URL(request.url, "http://localhost");
  const method = request.method || "GET";

  if (method === "GET" && pathname === "/api/health") {
    return send(response, 200, { configured: true });
  }
  if (method === "POST" && pathname === "/api/auth/signup") {
    if (!isSameOrigin(request)) return send(response, 403, { error: "Request origin was rejected." });
    return signUp(await readJson(request), request, response);
  }
  if (method === "POST" && pathname === "/api/auth/login") {
    if (!isSameOrigin(request)) return send(response, 403, { error: "Request origin was rejected." });
    return login(await readJson(request), request, response);
  }
  if (method === "POST" && pathname === "/api/auth/request-password-reset") {
    if (!isSameOrigin(request)) return send(response, 403, { error: "Request origin was rejected." });
    return requestPasswordReset(await readJson(request), request, response);
  }
  if (method === "POST" && pathname === "/api/auth/reset-password") {
    if (!isSameOrigin(request)) return send(response, 403, { error: "Request origin was rejected." });
    return resetPassword(await readJson(request), response);
  }
  if (method === "POST" && pathname === "/api/auth/accept-invite") {
    if (!isSameOrigin(request)) return send(response, 403, { error: "Request origin was rejected." });
    return acceptInvite(await readJson(request), request, response);
  }
  if (method === "GET" && pathname.startsWith("/api/invites/")) {
    const token = decodeURIComponent(pathname.slice("/api/invites/".length));
    const result = await pool.query(
      `SELECT clients.name, clients.email
         FROM psf_client_invites AS invites
         JOIN psf_clients AS clients ON clients.id = invites.client_id AND clients.coach_id = invites.coach_id
        WHERE invites.token_hash = $1 AND invites.redeemed_at IS NULL
          AND invites.expires_at > NOW() AND clients.linked_account_id IS NULL`,
      [hashToken(token)],
    );
    const invite = result.rows[0];
    return invite
      ? send(response, 200, { name: invite.name, email: invite.email })
      : send(response, 404, { error: "This invitation has expired or has already been used." });
  }
  if (method === "GET" && pathname === "/api/auth/me") {
    if (!account) return send(response, 200, { user: null });
    return send(response, 200, { user: accountView(account), workspace: await loadWorkspace(account) });
  }
  if (method === "POST" && pathname === "/api/auth/logout") {
    if (!isSameOrigin(request)) return send(response, 403, { error: "Request origin was rejected." });
    const token = parseCookies(request.headers.cookie)[SESSION_COOKIE];
    if (token) await pool.query("DELETE FROM psf_sessions WHERE token_hash = $1", [hashToken(token)]);
    return send(response, 200, { ok: true }, { "Set-Cookie": getSessionCookie("", { secure: requestIsSecure(request), maxAgeSeconds: 0 }) });
  }
  if (method === "GET" && pathname === "/api/workspace") {
    if (!account) return send(response, 401, { error: "Sign in to access your workspace." });
    return send(response, 200, { workspace: await loadWorkspace(account) });
  }
  if (method === "PUT" && pathname === "/api/workspace") {
    if (!isSameOrigin(request)) return send(response, 403, { error: "Request origin was rejected." });
    if (!account) return send(response, 401, { error: "Sign in to save your workspace." });
    const result = await saveWorkspace(account, await readJson(request));
    return send(response, result.status, result);
  }
  if (method === "POST" && pathname === "/api/checkins") {
    if (!isSameOrigin(request)) return send(response, 403, { error: "Request origin was rejected." });
    if (!account) return send(response, 401, { error: "Sign in to submit a check-in." });
    const result = await submitCheckIn(account, await readJson(request));
    return send(response, result.status, result);
  }
  const checkInResponseMatch = pathname.match(/^\/api\/checkins\/([0-9a-f-]{36})\/response$/i);
  if (method === "PUT" && checkInResponseMatch) {
    if (!isSameOrigin(request)) return send(response, 403, { error: "Request origin was rejected." });
    if (!account) return send(response, 401, { error: "Sign in to respond to a check-in." });
    const result = await saveCoachResponse(account, checkInResponseMatch[1], await readJson(request));
    return send(response, result.status, result);
  }
  const inviteMatch = pathname.match(/^\/api\/clients\/([^/]+)\/invite$/);
  if (method === "POST" && inviteMatch) {
    if (!isSameOrigin(request)) return send(response, 403, { error: "Request origin was rejected." });
    if (!account || account.role !== "coach") return send(response, 403, { error: "Only a coach can invite a client." });
    const clientId = decodeURIComponent(inviteMatch[1]);
    const token = randomBytes(32).toString("base64url");
    try {
      await withTransaction(async (database) => {
        const locked = await database.query(
          "SELECT email, linked_account_id FROM psf_clients WHERE id = $1 AND coach_id = $2 FOR UPDATE",
          [clientId, account.id],
        );
        const client = locked.rows[0];
        if (!client) {
          const error = new Error("Client profile was not found.");
          error.status = 404;
          throw error;
        }
        if (!isValidEmail(client.email)) {
          const error = new Error("Add a valid client email before creating an invitation.");
          error.status = 400;
          throw error;
        }
        if (client.linked_account_id) {
          const error = new Error("This client already has an account.");
          error.status = 409;
          throw error;
        }
        await database.query("DELETE FROM psf_client_invites WHERE client_id = $1 AND redeemed_at IS NULL", [clientId]);
        await database.query(
          `INSERT INTO psf_client_invites (token_hash, coach_id, client_id, expires_at)
           VALUES ($1, $2, $3, NOW() + INTERVAL '7 days')`,
          [hashToken(token), account.id, clientId],
        );
      });
    } catch (error) {
      if (error.status) return send(response, error.status, { error: error.message });
      throw error;
    }
    if (process.env.NODE_ENV === "production" && !process.env.APP_URL) {
      return send(response, 503, { error: "APP_URL must be configured before client invitations can be created." });
    }
    const appUrl = process.env.APP_URL || `${requestIsSecure(request) ? "https" : "http"}://${request.headers.host}`;
    const inviteUrl = new URL("/", appUrl);
    inviteUrl.searchParams.set("invite", token);
    return send(response, 201, { inviteUrl: inviteUrl.toString(), expiresInDays: 7 });
  }

  return send(response, 404, { error: "API route was not found." });
}

export default async function handler(request, response) {
  try {
    if (!process.env.DATABASE_URL) return send(response, 503, { error: "Account services are not configured. Set DATABASE_URL and run the database migration." });
    await pool.query("SELECT 1 FROM psf_accounts LIMIT 0");
    const account = await requireSession(request);
    return await route(request, response, account);
  } catch (error) {
    if (error.status) return send(response, error.status, { error: error.message });
    console.error("Fitness account API request failed:", error.message);
    if (error.code === "42P01") {
      return send(response, 503, { error: "Account database schema is not installed. Run npm run db:migrate." });
    }
    return send(response, 500, { error: "The request could not be completed. Try again shortly." });
  }
}
