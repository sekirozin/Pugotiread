import crypto from "node:crypto";
import { config } from "./config.js";
import { store } from "./store.js";
const sessionMaxAgeSeconds = 60 * 60 * 24 * 7;
export function toPublicUser(user) {
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
        passwordChangeRequiresEmailConfirmation: user.passwordChangeRequiresEmailConfirmation,
        lastActiveAt: user.lastActiveAt,
        needsNickname: Boolean(user.googleSub && !user.nickname),
        allowedLibraryIds: user.allowedLibraryIds,
        role: user.role
    };
}
let googleKeyCache = null;
function decodeBase64UrlJson(value) {
    return JSON.parse(Buffer.from(value, "base64url").toString("utf8"));
}
async function getGoogleKeys() {
    if (googleKeyCache && googleKeyCache.expiresAt > Date.now()) {
        return googleKeyCache.keys;
    }
    const response = await fetch("https://www.googleapis.com/oauth2/v3/certs");
    if (!response.ok) {
        throw new Error("Não foi possível validar o login do Google.");
    }
    const payload = (await response.json());
    const cacheControl = response.headers.get("cache-control") ?? "";
    const maxAgeMatch = cacheControl.match(/max-age=(\d+)/);
    const maxAgeSeconds = maxAgeMatch ? Number(maxAgeMatch[1]) : 3600;
    googleKeyCache = {
        expiresAt: Date.now() + Math.max(60, maxAgeSeconds) * 1000,
        keys: payload.keys ?? []
    };
    return googleKeyCache.keys;
}
export async function verifyGoogleIdToken(credential) {
    if (!config.googleClientId) {
        throw new Error("Login com Google não configurado.");
    }
    const [encodedHeader, encodedPayload, encodedSignature] = credential.split(".");
    if (!encodedHeader || !encodedPayload || !encodedSignature) {
        throw new Error("Credencial do Google inválida.");
    }
    const header = decodeBase64UrlJson(encodedHeader);
    if (header.alg !== "RS256" || !header.kid) {
        throw new Error("Credencial do Google inválida.");
    }
    const keys = await getGoogleKeys();
    const key = keys.find((item) => item.kid === header.kid);
    if (!key) {
        throw new Error("Não foi possível validar o login do Google.");
    }
    const verifier = crypto.createVerify("RSA-SHA256");
    verifier.update(`${encodedHeader}.${encodedPayload}`);
    verifier.end();
    const validSignature = verifier.verify(crypto.createPublicKey({ key, format: "jwk" }), Buffer.from(encodedSignature, "base64url"));
    if (!validSignature) {
        throw new Error("Credencial do Google inválida.");
    }
    const payload = decodeBase64UrlJson(encodedPayload);
    const verifiedEmail = payload.email_verified === true || payload.email_verified === "true";
    if (payload.aud !== config.googleClientId ||
        !["accounts.google.com", "https://accounts.google.com"].includes(payload.iss) ||
        payload.exp * 1000 < Date.now() ||
        !payload.sub ||
        !payload.email ||
        !verifiedEmail) {
        throw new Error("Credencial do Google inválida.");
    }
    return payload;
}
export function hashPassword(password) {
    const iterations = 120_000;
    const salt = crypto.randomBytes(16).toString("hex");
    const hash = crypto.pbkdf2Sync(password, salt, iterations, 32, "sha256").toString("hex");
    return `pbkdf2$${iterations}$${salt}$${hash}`;
}
export function verifyPassword(user, password) {
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
export function isPasswordHashReady(passwordHash) {
    const parts = passwordHash.split("$");
    if (parts[0] !== "pbkdf2" || parts.length !== 4) {
        return false;
    }
    return Number.isFinite(Number(parts[1])) && Boolean(parts[2]) && Boolean(parts[3]);
}
export function createSessionToken(userId) {
    const payload = `${userId}.${Date.now() + sessionMaxAgeSeconds * 1000}`;
    const signature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
    return `${Buffer.from(payload).toString("base64url")}.${signature}`;
}
export function getCookie(req, name) {
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
export async function getCurrentUser(req) {
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
    const found = data.users.find((user) => user.id === userId) ?? null;
    if (!found) {
        return null;
    }
    if (found.role === "admin" && !isPasswordHashReady(found.passwordHash)) {
        return null;
    }
    return found;
}
export function setSessionCookie(res, token) {
    res.setHeader("Set-Cookie", `pugotiread_session=${encodeURIComponent(token)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${sessionMaxAgeSeconds}`);
}
export function clearSessionCookie(res) {
    res.setHeader("Set-Cookie", [
        "pugotiread_session=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0",
        "pugotiread_vault=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0"
    ]);
}
//# sourceMappingURL=auth.js.map