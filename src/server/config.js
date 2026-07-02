import fs from "node:fs";
import path from "node:path";
import { fileURLToPath } from "node:url";
const projectRoot = path.resolve(path.dirname(fileURLToPath(import.meta.url)), "../..");
function parseEnvFile(filePath) {
    if (!fs.existsSync(filePath)) {
        return {};
    }
    const result = {};
    const lines = fs.readFileSync(filePath, "utf8").split(/\r?\n/);
    for (const rawLine of lines) {
        const line = rawLine.trim();
        if (!line || line.startsWith("#")) {
            continue;
        }
        const equalsIndex = line.indexOf("=");
        if (equalsIndex <= 0) {
            continue;
        }
        const key = line.slice(0, equalsIndex).trim();
        let value = line.slice(equalsIndex + 1).trim();
        if ((value.startsWith('"') && value.endsWith('"')) ||
            (value.startsWith("'") && value.endsWith("'"))) {
            value = value.slice(1, -1);
        }
        result[key] = value;
    }
    return result;
}
const envFileValues = {
    ...parseEnvFile(path.join(projectRoot, ".env")),
    ...parseEnvFile(path.join(projectRoot, ".env.local"))
};
function readPositiveNumber(value, fallback) {
    const parsed = Number(value);
    return Number.isFinite(parsed) && parsed > 0 ? parsed : fallback;
}
function readBoolean(value, fallback) {
    if (value === undefined) {
        return fallback;
    }
    return value.toLowerCase() !== "false" && value !== "0";
}
for (const [key, value] of Object.entries(envFileValues)) {
    if (process.env[key] === undefined) {
        process.env[key] = value;
    }
}
// Centraliza caminhos e portas para facilitar Docker, ZimaOS e execução local.
export const config = {
    port: Number(process.env.PORT ?? 8099),
    sessionSecret: process.env.SESSION_SECRET ?? "pugotiread-dev-secret",
    publicUrl: process.env.PUBLIC_URL ?? `http://localhost:${Number(process.env.PORT ?? 8099)}`,
    dataFile: process.env.DATA_FILE ?? path.join(projectRoot, "data/store.json"),
    dbFile: process.env.DB_FILE ?? path.join(projectRoot, "data/store.db"),
    publicDir: process.env.PUBLIC_DIR ?? path.join(projectRoot, "public"),
    iconsDir: process.env.ICONS_DIR ?? path.join(projectRoot, "icons"),
    clientDir: process.env.CLIENT_DIR ?? path.join(projectRoot, "dist/client"),
    mediaRoot: process.env.MEDIA_ROOT ?? path.join(projectRoot, "media"),
    vaultMediaRoot: process.env.VAULT_MEDIA_ROOT ?? path.join(projectRoot, "media/cofre"),
    pugotilabProfileUrl: process.env.PUGOTILAB_PROFILE_URL ?? "http://pugotilab-auth:8080/auth/api/profile",
    pugotilabAuthUrl: process.env.PUGOTILAB_AUTH_URL ?? "https://pugotilab.com/auth",
    pugotilabLogoutUrl: process.env.PUGOTILAB_LOGOUT_URL ?? "https://pugotilab.com/auth/logout",
    googleClientId: process.env.GOOGLE_CLIENT_ID ?? "",
    cacheDir: process.env.CACHE_DIR ?? path.join(projectRoot, "data/cache"),
    smtpHost: process.env.SMTP_HOST ?? "",
    smtpPort: Number(process.env.SMTP_PORT ?? 587),
    smtpSecure: process.env.SMTP_SECURE === "true",
    smtpUser: process.env.SMTP_USER ?? "",
    smtpPass: process.env.SMTP_PASS ?? "",
    smtpFrom: process.env.SMTP_FROM ?? "Pugotiread <no-reply@localhost>",
    pugotiCommand: process.env.PUGOTI_COMMAND ?? process.env.MANGASEK_COMMAND ?? "pugoti",
    pugotiTimeoutMs: readPositiveNumber(process.env.PUGOTI_TIMEOUT_MS ?? process.env.MANGASEK_TIMEOUT_MS, 30 * 60 * 1000),
    pugotiIoLockPath: process.env.PUGOTI_IO_LOCK_PATH?.trim() ?? "",
    pugotiIoLockWaitSeconds: readPositiveNumber(process.env.PUGOTI_IO_LOCK_WAIT_SECONDS, 6 * 60 * 60),
    pugotiAutoSyncEnabled: readBoolean(process.env.PUGOTI_AUTO_SYNC_ENABLED, true),
    pugotiSyncIntervalMs: readPositiveNumber(process.env.PUGOTI_SYNC_INTERVAL_MS, 2 * 60 * 60 * 1000)
};
