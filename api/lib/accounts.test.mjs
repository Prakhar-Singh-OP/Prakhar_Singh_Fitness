import test from "node:test";
import assert from "node:assert/strict";
import { readFile } from "node:fs/promises";
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
} from "./accounts.mjs";

test("email normalization and validation are consistent", () => {
  assert.equal(normalizeEmail(" Coach@Example.COM "), "coach@example.com");
  assert.equal(isValidEmail("coach@example.com"), true);
  assert.equal(isValidEmail("not-an-email"), false);
  assert.equal(isValidEmail(`${"a".repeat(250)}@example.com`), false);
});

test("password hashes are salted and verify without timing-unsafe comparison", async () => {
  const first = await hashPassword("correct horse battery staple");
  const second = await hashPassword("correct horse battery staple");
  assert.notEqual(first, second);
  assert.equal(await verifyPassword("correct horse battery staple", first), true);
  assert.equal(await verifyPassword("incorrect password", first), false);
  assert.equal(await verifyPassword("anything", "invalid-hash"), false);
  await assert.rejects(() => hashPassword("short"), /12 and 128/);
});

test("opaque tokens are random and stored tokens can be compared by digest", () => {
  const first = createOpaqueToken();
  const second = createOpaqueToken();
  assert.equal(first.length, 43);
  assert.notEqual(first, second);
  assert.equal(hashToken(first), hashToken(first));
  assert.notEqual(hashToken(first), first);
});

test("session cookies are HttpOnly, SameSite strict, and secure in production", () => {
  const secure = getSessionCookie("opaque", { secure: true });
  assert.match(secure, /HttpOnly/);
  assert.match(secure, /SameSite=Strict/);
  assert.match(secure, /Secure/);
  assert.match(getSessionCookie("", { secure: false, maxAgeSeconds: 0 }), /Max-Age=0/);
});

test("profile validation retains only supported plain fields", () => {
  assert.deepEqual(validateProfile({ name: "Coach", age: "38", admin: true }), {
    valid: true,
    value: { name: "Coach", age: "38" },
  });
  assert.equal(validateProfile({ name: { nested: true } }).valid, false);
  assert.deepEqual(validateProfile({ mealSwaps: { "1-first-0-0": "tofu" } }), {
    valid: true,
    value: { mealSwaps: { "1-first-0-0": "tofu" } },
  });
  assert.equal(validateProfile({ mealSwaps: { "1-first-0-0": "chicken<script>" } }).valid, false);
  assert.equal(validateProfile({ mealSwaps: { malformed: "tofu" } }).valid, false);
  assert.equal(validateProfile([]).valid, false);
});

test("weekly check-ins validate week boundaries and bounded client input", () => {
  const valid = validateCheckIn({
    weekStart: "2026-03-02",
    adherence: 85,
    workoutsCompleted: 4,
    energy: 3,
    notes: "  Felt stronger this week.  ",
  });
  assert.equal(valid.valid, true);
  assert.equal(valid.value.notes, "Felt stronger this week.");
  assert.equal(validateCheckIn({ ...valid.value, weekStart: "2026-03-03" }).valid, false);
  assert.equal(validateCheckIn({ ...valid.value, adherence: 101 }).valid, false);
  assert.equal(validateCheckIn({ ...valid.value, workoutsCompleted: 15 }).valid, false);
  assert.equal(validateCheckIn({ ...valid.value, energy: 0 }).valid, false);
  assert.equal(validateCheckIn({ ...valid.value, notes: "x".repeat(1001) }).valid, false);
});

test("client and progress payloads enforce their basic shape and limits", () => {
  const client = normalizeClient({
    id: "client-1",
    name: "Ananya",
    email: "ANANYA@example.com",
    profile: { name: "Ananya", unsupported: "discarded" },
    progress: [{ date: "2026-03-01", weight: 60 }],
  });
  assert.equal(client.valid, true);
  assert.equal(client.value.email, "ananya@example.com");
  assert.deepEqual(client.value.profile, { name: "Ananya" });
  assert.equal(normalizeClient({ id: "id", name: " ", profile: {}, progress: [] }).valid, false);
  assert.equal(validateProgress([{ date: "2026-03-01" }]).valid, true);
  assert.equal(validateProgress([null]).valid, false);
  assert.equal(validateProgress(Array(501).fill({})).valid, false);
});

test("cookie parser handles multiple cookies and ignores malformed segments", () => {
  assert.deepEqual(parseCookies("theme=dark; fitness_session=abc; malformed"), {
    theme: "dark",
    fitness_session: "abc",
  });
});

test("Supabase migration enables row security and withholds direct client-role access", async () => {
  const migration = await readFile(
    new URL("../../supabase/migrations/20261103000000_accounts.sql", import.meta.url),
    "utf8",
  );
  for (const table of ["psf_accounts", "psf_sessions", "psf_coach_workspaces", "psf_workspace_versions", "psf_clients", "psf_client_invites", "psf_auth_attempts", "psf_checkins", "psf_password_resets"]) {
    assert.match(migration, new RegExp(`ALTER TABLE ${table} ENABLE ROW LEVEL SECURITY`));
  }
  assert.match(migration, /FROM anon, authenticated/);
  assert.doesNotMatch(migration, /CREATE POLICY/i);
});
