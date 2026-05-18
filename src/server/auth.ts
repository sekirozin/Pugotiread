import crypto from "node:crypto";
import type { IncomingMessage, ServerResponse } from "node:http";
import { config } from "./config.js";
import { store } from "./store.js";
import type { PublicUser, User } from "../shared/types.js";

const sessionMaxAgeSeconds = 60 * 60 * 24 * 7;

export function toPublicUser(user: User): PublicUser {
  return {
    id: user.id,
    username: user.username,
    displayName: user.displayName,
    email: user.email,
    avatarUrl: user.avatarUrl,
    nickname: user.nickname,
    biography: user.biography,
    location: user.location,
    favoriteContentIds: user.favoriteContentIds,
    canLogin: user.canLogin,
    canDownload: user.canDownload,
    canChangePassword: user.canChangePassword,
    lastActiveAt: user.lastActiveAt,
    allowedLibraryIds: user.allowedLibraryIds,
    role: user.role
  };
}

export function hashPassword(password: string): string {
  const iterations = 120_000;
  const salt = crypto.randomBytes(16).toString("hex");
  const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
  return `pbkdf2$${iterations}$${salt}$${hash}`;
}

export function verifyPassword(user: User, password: string): boolean {
  if (user.passwordHash === "demo-only-change-me") {
    return user.username === password;
  }

  const parts = user.passwordHash.split("$");
  if (parts[0] !== "pbkdf2" || parts.length !== 4) {
    return false;
  }

  const iterations = Number(parts[1]);
  const salt = parts[2];
  const expected = parts[3];
  if (!Number.isFinite(iterations) || !salt || !expected) {
    return false;
  }

  const actual = crypto.pbkdf2Sync(password, salt, iterations, Buffer.from(expected, "hex").length, "sha256").toString("hex");
  return crypto.timingSafeEqual(Buffer.from(actual, "hex"), Buffer.from(expected, "hex"));
}

export function createSessionToken(userId: string): string {
  const payload = `${userId}.${Date.now() + sessionMaxAgeSeconds * 1000}`;
  const signature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return `${Buffer.from(payload).toString("base64url")}.${signature}`;
}

export function getCookie(req: IncomingMessage, name: string): string | null {
  const cookieHeader = req.headers.cookie;
  if (!cookieHeader) {
    return null;
  }

  for (const pair of cookieHeader.split(";")) {
    const [key, ...valueParts] = pair.trim().split("=");
    if (key === name) {
      return decodeURIComponent(valueParts.join("="));
    }
  }

  return null;
}

export async function getCurrentUser(req: IncomingMessage): Promise<User | null> {
  const token = getCookie(req, "pugotiread_session");
  if (!token) {
    return null;
  }

  const [encodedPayload, signature] = token.split(".");
  if (!encodedPayload || !signature) {
    return null;
  }

  const payload = Buffer.from(encodedPayload, "base64url").toString("utf8");
  const expectedSignature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  if (signature.length !== expectedSignature.length) {
    return null;
  }

  if (!crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature))) {
    return null;
  }

  const [userId, expiresAtRaw] = payload.split(".");
  if (Number(expiresAtRaw) < Date.now()) {
    return null;
  }

  const data = await store.read();
  return data.users.find((user) => user.id === userId) ?? null;
}

export function setSessionCookie(res: ServerResponse, token: string): void {
  res.setHeader(
    "Set-Cookie",
    `pugotiread_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionMaxAgeSeconds}`
  );
}

export function clearSessionCookie(res: ServerResponse): void {
  res.setHeader("Set-Cookie", [
    "pugotiread_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
    "pugotiread_vault=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
  ]);
}
