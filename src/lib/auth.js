import crypto from "node:crypto";

const SCRYPT_KEYLEN = 64;

export function normalizeEmail(value) {
  return String(value || "").trim().toLowerCase();
}

export function hashPassword(password) {
  const salt = crypto.randomBytes(16).toString("hex");
  const derived = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  return `${salt}:${derived}`;
}

export function verifyPassword(password, passwordHash) {
  const [salt, expected] = String(passwordHash || "").split(":");

  if (!salt || !expected) {
    return false;
  }

  const actual = crypto.scryptSync(password, salt, SCRYPT_KEYLEN).toString("hex");
  const left = Buffer.from(actual, "hex");
  const right = Buffer.from(expected, "hex");

  if (left.length !== right.length) {
    return false;
  }

  return crypto.timingSafeEqual(left, right);
}

export function generateSessionToken() {
  return crypto.randomBytes(24).toString("hex");
}

export function sessionExpiryDate(days = 7) {
  const expiresAt = new Date();
  expiresAt.setDate(expiresAt.getDate() + days);
  return expiresAt;
}

export function serializeSessionCookie(token, expiresAt) {
  return [
    `tongpin_session=${encodeURIComponent(token)}`,
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    `Expires=${expiresAt.toUTCString()}`
  ].join("; ");
}

export function serializeExpiredSessionCookie() {
  return [
    "tongpin_session=",
    "Path=/",
    "HttpOnly",
    "SameSite=Lax",
    "Expires=Thu, 01 Jan 1970 00:00:00 GMT"
  ].join("; ");
}

export function parseCookies(cookieHeader) {
  const result = {};

  for (const pair of String(cookieHeader || "").split(";")) {
    const [rawName, ...rest] = pair.trim().split("=");

    if (!rawName) {
      continue;
    }

    result[rawName] = decodeURIComponent(rest.join("="));
  }

  return result;
}
