import { createHash, randomBytes, scrypt, timingSafeEqual } from "node:crypto";
import { promisify } from "node:util";

const scryptAsync = promisify(scrypt);
const EMAIL_PATTERN = /^[^\s@]+@[^\s@]+\.[^\s@]+$/;
const CLIENT_PROFILE_FIELDS = new Set([
  "name",
  "age",
  "currentWeight",
  "targetWeight",
  "height",
  "goal",
  "workoutLevel",
  "sex",
  "dietType",
  "workoutTime",
  "timeline",
  "monthlyBudget",
  "calorieTarget",
  "mealSwaps",
]);

export function normalizeEmail(value) {
  return typeof value === "string" ? value.trim().toLowerCase() : "";
}

export function isValidEmail(value) {
  return value.length <= 254 && EMAIL_PATTERN.test(value);
}

export function hashToken(token) {
  return createHash("sha256").update(token).digest("hex");
}

export function createOpaqueToken() {
  return randomBytes(32).toString("base64url");
}

export async function hashPassword(password) {
  if (typeof password !== "string" || password.length < 12 || password.length > 128) {
    throw new Error("Password must be between 12 and 128 characters.");
  }
  const salt = randomBytes(16);
  const hash = await scryptAsync(password, salt, 64);
  return `scrypt$${salt.toString("hex")}$${Buffer.from(hash).toString("hex")}`;
}

export async function verifyPassword(password, storedHash) {
  if (typeof password !== "string" || typeof storedHash !== "string") return false;
  const [algorithm, saltHex, expectedHex] = storedHash.split("$");
  if (algorithm !== "scrypt" || !/^[0-9a-f]{32}$/i.test(saltHex || "") || !/^[0-9a-f]{128}$/i.test(expectedHex || "")) {
    return false;
  }
  const derived = Buffer.from(await scryptAsync(password, Buffer.from(saltHex, "hex"), 64));
  const expected = Buffer.from(expectedHex, "hex");
  return timingSafeEqual(derived, expected);
}

export function parseCookies(header = "") {
  return Object.fromEntries(header.split(";").map((part) => {
    const separator = part.indexOf("=");
    if (separator < 0) return ["", ""];
    return [part.slice(0, separator).trim(), part.slice(separator + 1).trim()];
  }).filter(([key]) => key));
}

export function validateProfile(profile) {
  if (!profile || typeof profile !== "object" || Array.isArray(profile)) {
    return { valid: false, error: "Profile must be an object." };
  }
  const sanitized = {};
  for (const [key, value] of Object.entries(profile)) {
    if (!CLIENT_PROFILE_FIELDS.has(key)) continue;
    if (key === "mealSwaps") {
      if (!value || typeof value !== "object" || Array.isArray(value) || Object.keys(value).length > 500) {
        return { valid: false, error: "Meal substitutions must be a map of up to 500 choices." };
      }
      const swaps = {};
      for (const [swapKey, foodId] of Object.entries(value)) {
        if (!/^\d+-(?:first|second)-\d+-\d+$/.test(swapKey) ||
            typeof foodId !== "string" || !/^[a-z0-9-]{1,80}$/.test(foodId)) {
          return { valid: false, error: "A meal substitution is invalid." };
        }
        swaps[swapKey] = foodId;
      }
      sanitized[key] = swaps;
      continue;
    }
    if (typeof value !== "string" && typeof value !== "number" && value !== null) {
      return { valid: false, error: "Profile fields must contain plain values." };
    }
    if (typeof value === "string" && value.length > 500) {
      return { valid: false, error: "Profile fields are too long." };
    }
    sanitized[key] = value;
  }
  return { valid: true, value: sanitized };
}

export function validateCheckIn(input) {
  if (!input || typeof input !== "object" || Array.isArray(input)) {
    return { valid: false, error: "Check-in must be an object." };
  }
  const { weekStart, adherence, workoutsCompleted, energy, notes } = input;
  if (typeof weekStart !== "string" || !/^\d{4}-\d{2}-\d{2}$/.test(weekStart)) {
    return { valid: false, error: "Choose the Monday that starts this check-in week." };
  }
  const monday = new Date(`${weekStart}T00:00:00.000Z`);
  if (!Number.isFinite(monday.getTime()) || monday.toISOString().slice(0, 10) !== weekStart || monday.getUTCDay() !== 1) {
    return { valid: false, error: "Choose the Monday that starts this check-in week." };
  }
  if (!Number.isInteger(adherence) || adherence < 0 || adherence > 100) {
    return { valid: false, error: "Plan adherence must be a whole number from 0 to 100." };
  }
  if (!Number.isInteger(workoutsCompleted) || workoutsCompleted < 0 || workoutsCompleted > 14) {
    return { valid: false, error: "Completed workouts must be a whole number from 0 to 14." };
  }
  if (!Number.isInteger(energy) || energy < 1 || energy > 5) {
    return { valid: false, error: "Energy must be rated from 1 to 5." };
  }
  if (typeof notes !== "string" || notes.length > 1000) {
    return { valid: false, error: "Check-in notes must be 1,000 characters or fewer." };
  }
  return {
    valid: true,
    value: { weekStart, adherence, workoutsCompleted, energy, notes: notes.trim() },
  };
}

export function validateProgress(progress) {
  if (!Array.isArray(progress) || progress.length > 500) {
    return { valid: false, error: "Progress must be a list of up to 500 entries." };
  }
  if (progress.some((entry) => !entry || typeof entry !== "object" || Array.isArray(entry))) {
    return { valid: false, error: "Progress entries must be objects." };
  }
  return { valid: true, value: progress };
}

export function normalizeClient(client) {
  if (!client || typeof client !== "object" || Array.isArray(client)) {
    return { valid: false, error: "Each client must be an object." };
  }
  const id = typeof client.id === "string" ? client.id.trim() : "";
  const name = typeof client.name === "string" ? client.name.trim() : "";
  const email = normalizeEmail(client.email || "");
  const profile = validateProfile(client.profile);
  const progress = validateProgress(client.progress);
  if (!id || id.length > 100 || !name || name.length > 80) {
    return { valid: false, error: "Client ID or name is invalid." };
  }
  if (email && !isValidEmail(email)) return { valid: false, error: "Client email is invalid." };
  if (!profile.valid) return profile;
  if (!progress.valid) return progress;
  return {
    valid: true,
    value: { id, name, email, profile: profile.value, progress: progress.value },
  };
}

export function getSessionCookie(token, { secure = true, maxAgeSeconds = 60 * 60 * 24 * 14 } = {}) {
  const parts = [`fitness_session=${token}`, "Path=/", "HttpOnly", "SameSite=Strict", `Max-Age=${maxAgeSeconds}`];
  if (secure) parts.push("Secure");
  return parts.join("; ");
}
