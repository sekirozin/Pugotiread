import crypto from "node:crypto";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { clearSessionCookie, createSessionToken, getCookie, getCurrentUser, hashPassword, isPasswordHashReady, setSessionCookie, toPublicUser, verifyGoogleIdToken, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { readJson, sendFile, sendJson, sendNoContent, serveStatic } from "./http.js";
import { sendPasswordResetEmail } from "./mailer.js";
import { getContentCoverPath, getContentCoverThumbnail, getContentPagePath, scanLibrary } from "./media.js";
import { normalizeVaultTimeoutMinutes, store } from "./store.js";
function isPersonalLibrary(library) {
    return Boolean(library.isPersonal);
}
function getVisibleLibraries(user, libraries) {
    const regularLibraries = libraries.filter((library) => !isPersonalLibrary(library));
    return user.role === "admin"
        ? regularLibraries
        : regularLibraries.filter((library) => user.allowedLibraryIds.includes(library.id));
}
function getPersonalLibraries(user, libraries) {
    return libraries.filter((library) => isPersonalLibrary(library) && library.ownerUserId === user.id);
}
function createVaultToken(userId, timeoutMinutes) {
    const payload = `${userId}.${Date.now() + timeoutMinutes * 60 * 1000}`;
    const signature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}
function hasValidVaultToken(req, user) {
    const token = req.headers["x-vault-token"] ?? getCookie(req, "pugotiread_vault");
    if (typeof token !== "string") {
        return false;
    }
    const [userId, expiresAt, signature] = token.split(".");
    if (userId !== user.id || !expiresAt || !signature || Number(expiresAt) < Date.now()) {
        return false;
    }
    const payload = `${userId}.${expiresAt}`;
    const expectedSignature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
    if (signature.length !== expectedSignature.length) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}
function getRequestLibrary(user, libraries, libraryId, req) {
    const library = libraries.find((item) => item.id === libraryId) ?? null;
    if (!library) {
        return null;
    }
    if (isPersonalLibrary(library)) {
        return library.ownerUserId === user.id && hasValidVaultToken(req, user) ? library : null;
    }
    return user.role === "admin" || user.allowedLibraryIds.includes(library.id) ? library : null;
}
function findVisibleLibraryForContentId(user, libraries, contentId) {
    return getVisibleLibraries(user, libraries).find((item) => contentId.startsWith(`${item.id}:`)) ?? null;
}
async function findVisibleContent(user, contentId) {
    const data = await store.read();
    const library = findVisibleLibraryForContentId(user, data.libraries, contentId);
    if (!library) {
        return null;
    }
    const contents = await scanLibrary(library);
    const content = contents.find((item) => item.id === contentId);
    return content ? { library, pageCount: content.pageCount } : null;
}
async function findRequestContent(user, contentId, req) {
    const data = await store.read();
    const libraryId = contentId.split(":")[0] ?? "";
    const library = getRequestLibrary(user, data.libraries, libraryId, req);
    if (!library) {
        return null;
    }
    const contents = await scanLibrary(library);
    const content = contents.find((item) => item.id === contentId);
    return content ? { library, pageCount: content.pageCount } : null;
}
function parseContentPagePath(pathname) {
    const match = pathname.match(/^\/api\/contents\/(.+)\/pages\/(\d+)$/);
    if (!match) {
        return null;
    }
    return {
        contentId: decodeURIComponent(match[1] ?? ""),
        pageIndex: Number(match[2])
    };
}
function parseContentCoverPath(pathname) {
    const match = pathname.match(/^\/api\/contents\/(.+)\/cover$/);
    if (!match) {
        return null;
    }
    return { contentId: decodeURIComponent(match[1] ?? "") };
}
function slugify(value) {
    return value
        .normalize("NFD")
        .replaceAll(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
}
function makeLibraryId(name, existing) {
    const base = slugify(name) || "biblioteca";
    let next = base;
    let counter = 2;
    while (existing.some((library) => library.id === next)) {
        next = `${base}-${counter}`;
        counter += 1;
    }
    return next;
}
function makeUserId(base, existing) {
    const normalized = slugify(base) || "user";
    let next = normalized;
    let counter = 2;
    while (existing.some((user) => user.id === next)) {
        next = `${normalized}-${counter}`;
        counter += 1;
    }
    return next;
}
function makeInviteToken() {
    return crypto.randomBytes(18).toString("hex");
}
function makePasswordResetTokenValue() {
    return crypto.randomBytes(18).toString("hex");
}
function hashPasswordResetToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}
function makePasswordResetLink(token) {
    return `${config.publicUrl.replace(/\/$/, "")}/reset-password/${encodeURIComponent(token)}`;
}
async function issuePasswordResetToken(user) {
    const token = makePasswordResetTokenValue();
    const tokenHash = hashPasswordResetToken(token);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 30 * 60 * 1000).toISOString();
    const resetToken = {
        token: tokenHash,
        userId: user.id,
        email: user.email,
        purpose: "password-reset",
        createdAt,
        expiresAt,
        usedAt: null
    };
    await store.createPasswordResetToken(resetToken);
    await sendPasswordResetEmail(user.email, makePasswordResetLink(token));
    return resetToken;
}
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
function sanitizeLibraryIds(libraryIds, libraries) {
    const allowed = new Set(libraries.map((library) => library.id));
    return Array.from(new Set(libraryIds.filter((id) => allowed.has(id))));
}
function sanitizeUserRole(role) {
    return role === "admin" ? "admin" : "user";
}
function hasConfiguredAdmin(users) {
    return users.some((item) => item.role === "admin" && isPasswordHashReady(item.passwordHash));
}
function buildUserFromInput(body, existingUsers, libraries) {
    const username = body.username?.trim() ?? "";
    const displayName = body.displayName?.trim() || username;
    const email = body.email?.trim() ?? "";
    const allowedLibraryIds = sanitizeLibraryIds(body.allowedLibraryIds ?? [], libraries);
    if (!username) {
        throw new Error("Informe o usuário.");
    }
    if (!email) {
        throw new Error("Informe o e-mail.");
    }
    return {
        id: makeUserId(username, existingUsers),
        username,
        displayName,
        email,
        avatarUrl: "",
        nickname: "",
        biography: "",
        location: "",
        favoriteContentIds: [],
        canLogin: body.canLogin ?? true,
        canDownload: body.canDownload ?? true,
        canChangePassword: body.canChangePassword ?? true,
        passwordChangeRequiresEmailConfirmation: body.passwordChangeRequiresEmailConfirmation ?? true,
        lastActiveAt: null,
        role: body.role ?? "user",
        passwordHash: body.passwordHash ?? hashPassword(body.password ?? ""),
        allowedLibraryIds
    };
}
function makeCollectionId(name, userId, existing) {
    const base = slugify(name) || "colecao";
    let next = base;
    let counter = 2;
    while (existing.some((collection) => collection.userId === userId && collection.id === next)) {
        next = `${base}-${counter}`;
        counter += 1;
    }
    return next;
}
function makePublicReview(review, user) {
    return {
        userId: review.userId,
        contentId: review.contentId,
        displayName: user.displayName,
        role: user.role,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt
    };
}
function getVisibleReviewCountForUser(viewer, data, userId) {
    return data.reviews.filter((review) => review.userId === userId && Boolean(findVisibleLibraryForContentId(viewer, data.libraries, review.contentId))).length;
}
function makePublicCollection(collection, owner) {
    return {
        id: collection.id,
        userId: collection.userId,
        name: collection.name,
        description: collection.description,
        sharedWithUserIds: collection.sharedWithUserIds,
        ownerDisplayName: owner?.displayName ?? "Usuário",
        contentIds: collection.contentIds
    };
}
function isLibraryKind(value) {
    return value === "manga" || value === "manhwa" || value === "book";
}
function isInsideMediaRoot(candidatePath) {
    const relative = path.relative(path.resolve(config.mediaRoot), path.resolve(candidatePath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
async function readMediaDirectory(requestedPath) {
    const safePath = path.resolve(requestedPath || config.mediaRoot);
    if (!isInsideMediaRoot(safePath)) {
        throw new Error("Pasta fora da raiz de mídia.");
    }
    const entries = await fs.readdir(safePath, { withFileTypes: true });
    const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
        name: entry.name,
        path: path.join(safePath, entry.name)
    }))
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
    const parent = path.resolve(safePath) === path.resolve(config.mediaRoot) ? null : path.dirname(safePath);
    return { path: safePath, parent, directories };
}
async function handleApi(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const user = await getCurrentUser(req);
    if (url.pathname === "/api/setup/status" && req.method === "GET") {
        const data = await store.read();
        sendJson(res, 200, { setupRequired: !hasConfiguredAdmin(data.users) });
        return;
    }
    if (url.pathname === "/api/setup/admin" && req.method === "POST") {
        const body = await readJson(req);
        const username = body.username?.trim() ?? "";
        const displayName = body.displayName?.trim() ?? "";
        const email = normalizeEmail(body.email ?? "");
        const password = body.password?.trim() ?? "";
        if (!username || !displayName || !email || !password) {
            sendJson(res, 400, { error: "Preencha usuário, nome, e-mail e senha." });
            return;
        }
        if (password.length < 12) {
            sendJson(res, 400, { error: "A senha inicial deve ter pelo menos 12 caracteres." });
            return;
        }
        const data = await store.read();
        if (hasConfiguredAdmin(data.users)) {
            sendJson(res, 409, { error: "Já existe um administrador configurado." });
            return;
        }
        const now = new Date().toISOString();
        const existingAdminIndex = data.users.findIndex((item) => item.role === "admin");
        const userRecord = {
            id: existingAdminIndex >= 0 ? data.users[existingAdminIndex].id : makeUserId(username, data.users),
            username,
            displayName,
            email,
            avatarUrl: "",
            nickname: "",
            biography: "",
            location: "",
            favoriteContentIds: [],
            canLogin: true,
            canDownload: true,
            canChangePassword: true,
            passwordChangeRequiresEmailConfirmation: false,
            lastActiveAt: now,
            role: "admin",
            passwordHash: hashPassword(password),
            allowedLibraryIds: []
        };
        if (existingAdminIndex >= 0) {
            data.users[existingAdminIndex] = userRecord;
        }
        else {
            data.users.push(userRecord);
        }
        await store.write(data);
        setSessionCookie(res, createSessionToken(userRecord.id));
        sendJson(res, 201, { user: toPublicUser(userRecord) });
        return;
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
        const body = await readJson(req);
        const data = await store.read();
        const found = data.users.find((item) => item.username === body.username);
        if (!found || !verifyPassword(found, body.password)) {
            sendJson(res, 401, { error: "Usuário ou senha inválidos." });
            return;
        }
        if (!found.canLogin) {
            sendJson(res, 403, { error: "Esta conta está bloqueada para login." });
            return;
        }
        found.lastActiveAt = new Date().toISOString();
        await store.write(data);
        setSessionCookie(res, createSessionToken(found.id));
        sendJson(res, 200, { user: toPublicUser(found) });
        return;
    }
    if (url.pathname === "/api/auth/google/config" && req.method === "GET") {
        sendJson(res, 200, {
            enabled: Boolean(config.googleClientId),
            clientId: config.googleClientId
        });
        return;
    }
    if (url.pathname === "/api/auth/google" && req.method === "POST") {
        const body = await readJson(req);
        try {
            const inviteToken = body.inviteToken?.trim() ?? "";
            if (!inviteToken) {
                sendJson(res, 403, { error: "Login com Google disponível apenas por convite." });
                return;
            }
            const googleProfile = await verifyGoogleIdToken(body.credential ?? "");
            const email = normalizeEmail(googleProfile.email);
            const data = await store.read();
            const now = new Date().toISOString();
            const invitation = data.invitations.find((item) => item.token === inviteToken && !item.usedAt);
            if (!invitation) {
                sendJson(res, 404, { error: "Convite não encontrado ou já utilizado." });
                return;
            }
            if (invitation.email && normalizeEmail(invitation.email) !== email) {
                sendJson(res, 403, { error: "Use a conta Google do e-mail convidado." });
                return;
            }
            let found = data.users.find((item) => item.googleSub === googleProfile.sub) ?? data.users.find((item) => normalizeEmail(item.email) === email);
            if (!found) {
                const usernameBase = invitation.username.trim() || googleProfile.email.split("@")[0]?.trim() || googleProfile.name?.trim() || "user";
                const username = data.users.some((item) => item.username === usernameBase) ? makeUserId(usernameBase, data.users) : usernameBase;
                found = {
                    id: makeUserId(username, data.users),
                    username,
                    displayName: googleProfile.name?.trim() || invitation.displayName || email,
                    email,
                    avatarUrl: googleProfile.picture ?? "",
                    googleSub: googleProfile.sub,
                    nickname: "",
                    biography: "",
                    location: "",
                    favoriteContentIds: [],
                    canLogin: invitation.canLogin,
                    canDownload: invitation.canDownload,
                    canChangePassword: false,
                    passwordChangeRequiresEmailConfirmation: true,
                    lastActiveAt: now,
                    role: "user",
                    passwordHash: "google-only",
                    allowedLibraryIds: invitation.allowedLibraryIds
                };
                data.users.push(found);
            }
            if (!found.canLogin) {
                sendJson(res, 403, { error: "Esta conta está bloqueada para login." });
                return;
            }
            found.googleSub = googleProfile.sub;
            found.email = email;
            found.avatarUrl = googleProfile.picture ?? found.avatarUrl;
            found.displayName = googleProfile.name?.trim() || found.displayName;
            found.lastActiveAt = now;
            invitation.usedAt = now;
            await store.write(data);
            setSessionCookie(res, createSessionToken(found.id));
            sendJson(res, 200, { user: toPublicUser(found) });
        }
        catch (error) {
            sendJson(res, 401, { error: error instanceof Error ? error.message : "Falha no login com Google." });
        }
        return;
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
        clearSessionCookie(res);
        sendNoContent(res);
        return;
    }
    if (url.pathname.startsWith("/api/invites/") && req.method === "GET") {
        const token = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const data = await store.read();
        const invitation = data.invitations.find((item) => item.token === token && !item.usedAt);
        if (!invitation) {
            sendJson(res, 404, { error: "Convite não encontrado." });
            return;
        }
        sendJson(res, 200, { invitation });
        return;
    }
    if (url.pathname.startsWith("/api/invites/") && req.method === "POST") {
        const token = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        const data = await store.read();
        const invitation = data.invitations.find((item) => item.token === token && !item.usedAt);
        if (!invitation) {
            sendJson(res, 404, { error: "Convite não encontrado." });
            return;
        }
        const email = normalizeEmail(body.email ?? "");
        const nickname = body.nickname?.trim() ?? "";
        const password = body.password?.trim() ?? "";
        if (!email || !nickname || !password) {
            sendJson(res, 400, { error: "Preencha nickname, e-mail e senha." });
            return;
        }
        if (nickname.length > 40) {
            sendJson(res, 400, { error: "O nickname deve ter até 40 caracteres." });
            return;
        }
        if (invitation.email && normalizeEmail(invitation.email) !== email) {
            sendJson(res, 403, { error: "Use o e-mail convidado." });
            return;
        }
        if (data.users.some((item) => normalizeEmail(item.email) === email)) {
            sendJson(res, 400, { error: "Já existe uma conta com este e-mail." });
            return;
        }
        const usernameBase = invitation.username.trim() || email.split("@")[0] || nickname || "user";
        const username = data.users.some((item) => item.username === usernameBase) ? makeUserId(usernameBase, data.users) : usernameBase;
        const now = new Date().toISOString();
        const user = {
            id: makeUserId(username, data.users),
            username,
            displayName: invitation.displayName || nickname,
            email,
            avatarUrl: "",
            nickname,
            biography: "",
            location: "",
            favoriteContentIds: [],
            canLogin: invitation.canLogin,
            canDownload: invitation.canDownload,
            canChangePassword: true,
            passwordChangeRequiresEmailConfirmation: true,
            lastActiveAt: now,
            role: sanitizeUserRole(invitation.role),
            passwordHash: hashPassword(password),
            allowedLibraryIds: invitation.allowedLibraryIds
        };
        data.users.push(user);
        invitation.usedAt = now;
        await store.write(data);
        setSessionCookie(res, createSessionToken(user.id));
        sendJson(res, 201, { user: toPublicUser(user) });
        return;
    }
    if (url.pathname === "/api/password-reset/request" && req.method === "POST") {
        const body = await readJson(req);
        const email = normalizeEmail(body.email ?? "");
        if (!email) {
            sendJson(res, 400, { error: "Informe o e-mail cadastrado." });
            return;
        }
        const data = await store.read();
        const target = data.users.find((item) => normalizeEmail(item.email) === email);
        if (target && target.email) {
            await issuePasswordResetToken(target);
        }
        sendJson(res, 200, { message: "Se o e-mail estiver cadastrado, você receberá um link para trocar a senha." });
        return;
    }
    if (url.pathname.startsWith("/api/password-reset/") && req.method === "POST") {
        const token = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        const newPassword = body.newPassword?.trim() ?? "";
        if (!token || !newPassword) {
            sendJson(res, 400, { error: "Token ou nova senha inválidos." });
            return;
        }
        if (newPassword.length < 12) {
            sendJson(res, 400, { error: "A senha deve ter pelo menos 12 caracteres." });
            return;
        }
        const resetToken = await store.consumePasswordResetToken(token);
        if (!resetToken || resetToken.purpose !== "password-reset" || Number(new Date(resetToken.expiresAt)) < Date.now()) {
            sendJson(res, 404, { error: "Link de confirmação inválido ou expirado." });
            return;
        }
        const data = await store.read();
        const target = data.users.find((item) => item.id === resetToken.userId && normalizeEmail(item.email) === normalizeEmail(resetToken.email));
        if (!target) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        const updated = await store.updateUser(target.id, {
            passwordHash: hashPassword(newPassword),
            passwordChangeRequiresEmailConfirmation: target.passwordChangeRequiresEmailConfirmation
        });
        if (!updated) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        sendNoContent(res);
        return;
    }
    if (!user) {
        sendJson(res, 401, { error: "Login necessário." });
        return;
    }
    if (url.pathname === "/api/me" && req.method === "GET") {
        sendJson(res, 200, { user: toPublicUser(user) });
        return;
    }
    if (url.pathname === "/api/me/password" && req.method === "PATCH") {
        const body = await readJson(req);
        if (!user.canChangePassword) {
            sendJson(res, 403, { error: "Esta conta não pode alterar a própria senha." });
            return;
        }
        if (user.passwordChangeRequiresEmailConfirmation) {
            sendJson(res, 403, { error: "Esta conta precisa confirmar a troca por e-mail." });
            return;
        }
        if (!verifyPassword(user, body.currentPassword ?? "") || !body.newPassword?.trim()) {
            sendJson(res, 400, { error: "Senha atual inválida." });
            return;
        }
        await store.updateUser(user.id, { passwordHash: hashPassword(body.newPassword.trim()) });
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/me/password/request" && req.method === "POST") {
        if (!user.canChangePassword) {
            sendJson(res, 403, { error: "Esta conta não pode alterar a própria senha." });
            return;
        }
        if (!user.passwordChangeRequiresEmailConfirmation) {
            sendJson(res, 400, { error: "Esta conta pode trocar a senha diretamente." });
            return;
        }
        if (!user.email) {
            sendJson(res, 400, { error: "Esta conta não possui e-mail cadastrado." });
            return;
        }
        await issuePasswordResetToken(user);
        sendJson(res, 200, { message: "Enviamos um link para confirmar a troca da senha." });
        return;
    }
    if (url.pathname === "/api/personal-vault/unlock" && req.method === "POST") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem acessar o cofre pessoal." });
            return;
        }
        const body = await readJson(req);
        if (!verifyPassword(user, body.password ?? "")) {
            sendJson(res, 400, { error: "Senha inválida." });
            return;
        }
        const data = await store.read();
        const vaultTimeoutMinutes = normalizeVaultTimeoutMinutes(data.settings.vaultTimeoutMinutes);
        const vaultToken = createVaultToken(user.id, vaultTimeoutMinutes);
        res.setHeader("Set-Cookie", `pugotiread_vault=${encodeURIComponent(vaultToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${vaultTimeoutMinutes * 60}`);
        sendJson(res, 200, {
            libraries: getPersonalLibraries(user, data.libraries),
            vaultToken,
            vaultTimeoutMinutes
        });
        return;
    }
    if (url.pathname === "/api/personal-vault/lock" && req.method === "POST") {
        res.setHeader("Set-Cookie", "pugotiread_vault=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/personal-vault/touch" && req.method === "POST") {
        if (user.role !== "admin" || !hasValidVaultToken(req, user)) {
            sendJson(res, 403, { error: "Cofre bloqueado." });
            return;
        }
        const data = await store.read();
        const vaultTimeoutMinutes = normalizeVaultTimeoutMinutes(data.settings.vaultTimeoutMinutes);
        const vaultToken = createVaultToken(user.id, vaultTimeoutMinutes);
        res.setHeader("Set-Cookie", `pugotiread_vault=${encodeURIComponent(vaultToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${vaultTimeoutMinutes * 60}`);
        sendJson(res, 200, { vaultToken, vaultTimeoutMinutes });
        return;
    }
    if (url.pathname === "/api/me/profile" && req.method === "PATCH") {
        const body = await readJson(req);
        const avatarUrl = body.avatarUrl?.trim() ?? "";
        const nickname = body.nickname?.trim() ?? "";
        const biography = body.biography?.trim() ?? "";
        const location = body.location?.trim() ?? "";
        const favoriteContentIds = Array.from(new Set(body.favoriteContentIds ?? [])).slice(0, 3);
        if (avatarUrl.length > 500_000) {
            sendJson(res, 400, { error: "A imagem do avatar é muito grande." });
            return;
        }
        if (nickname.length > 40 || biography.length > 280 || location.length > 80) {
            sendJson(res, 400, { error: "Confira os limites dos campos do perfil." });
            return;
        }
        const data = await store.read();
        const visibleLibraryIds = new Set(getVisibleLibraries(user, data.libraries).map((library) => library.id));
        if (favoriteContentIds.some((contentId) => !visibleLibraryIds.has(contentId.split(":")[0] ?? ""))) {
            sendJson(res, 400, { error: "Uma das obras favoritas não está disponível para este usuário." });
            return;
        }
        const updated = await store.updateUserProfile(user.id, {
            avatarUrl,
            nickname,
            biography,
            location,
            favoriteContentIds
        });
        if (!updated) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        sendJson(res, 200, { user: toPublicUser(updated) });
        return;
    }
    if (url.pathname === "/api/me/reviews" && req.method === "GET") {
        const data = await store.read();
        const reviews = data.reviews
            .filter((review) => review.userId === user.id)
            .filter((review) => Boolean(findVisibleLibraryForContentId(user, data.libraries, review.contentId)))
            .map((review) => makePublicReview(review, user))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        sendJson(res, 200, { reviews });
        return;
    }
    if (url.pathname === "/api/users" && req.method === "GET") {
        const data = await store.read();
        sendJson(res, 200, {
            users: data.users.map((item) => ({
                id: item.id,
                username: item.username,
                displayName: item.displayName,
                avatarUrl: item.avatarUrl,
                nickname: item.nickname,
                biography: item.biography,
                location: item.location,
                favoriteContentIds: item.favoriteContentIds,
                lastActiveAt: item.lastActiveAt,
                role: item.role,
                reviewCount: getVisibleReviewCountForUser(user, data, item.id)
            }))
        });
        return;
    }
    if (url.pathname === "/api/admin/users" && req.method === "GET") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem ver usuários." });
            return;
        }
        const data = await store.read();
        sendJson(res, 200, { users: data.users.map(toPublicUser), libraries: getVisibleLibraries(user, data.libraries) });
        return;
    }
    if (url.pathname === "/api/admin/settings" && req.method === "GET") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem ver configurações do servidor." });
            return;
        }
        const data = await store.read();
        sendJson(res, 200, { settings: data.settings });
        return;
    }
    if (url.pathname === "/api/admin/settings" && req.method === "PATCH") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem editar configurações do servidor." });
            return;
        }
        const body = await readJson(req);
        if (!Number.isInteger(Number(body.vaultTimeoutMinutes)) || Number(body.vaultTimeoutMinutes) < 1) {
            sendJson(res, 400, { error: "O tempo do cofre deve ser um número inteiro maior que zero." });
            return;
        }
        const settings = await store.updateSettings({
            vaultTimeoutMinutes: Number(body.vaultTimeoutMinutes)
        });
        sendJson(res, 200, { settings });
        return;
    }
    if (url.pathname === "/api/admin/users" && req.method === "POST") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem criar usuários." });
            return;
        }
        const body = await readJson(req);
        const data = await store.read();
        if (data.users.some((item) => item.username === body.username?.trim())) {
            sendJson(res, 400, { error: "Usuário já existe." });
            return;
        }
        try {
            const created = await store.createUser(buildUserFromInput({
                email: body.email,
                displayName: body.displayName,
                username: body.username,
                password: body.password,
                role: sanitizeUserRole(body.role),
                allowedLibraryIds: body.allowedLibraryIds,
                canLogin: body.canLogin,
                canDownload: body.canDownload,
                canChangePassword: body.canChangePassword,
                passwordChangeRequiresEmailConfirmation: false
            }, data.users, data.libraries));
            sendJson(res, 201, { user: toPublicUser(created) });
        }
        catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Não foi possível criar o usuário." });
        }
        return;
    }
    if (url.pathname === "/api/admin/invites" && req.method === "POST") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem criar convites." });
            return;
        }
        const body = await readJson(req);
        const data = await store.read();
        try {
            const token = makeInviteToken();
            const linkOnly = Boolean(body.linkOnly);
            const invitation = {
                token,
                email: linkOnly ? "" : body.email?.trim() ?? "",
                displayName: linkOnly ? "" : body.displayName?.trim() ?? body.username?.trim() ?? "",
                username: linkOnly ? "" : body.username?.trim() ?? "",
                role: sanitizeUserRole(body.role),
                allowedLibraryIds: sanitizeLibraryIds(body.allowedLibraryIds ?? [], data.libraries),
                canLogin: body.canLogin ?? true,
                canDownload: body.canDownload ?? true,
                canChangePassword: body.canChangePassword ?? true,
                createdAt: new Date().toISOString(),
                usedAt: null
            };
            if (!linkOnly && (!invitation.email || !invitation.displayName || !invitation.username)) {
                sendJson(res, 400, { error: "Preencha e-mail, nome e usuário." });
                return;
            }
            await store.createInvitation(invitation);
            sendJson(res, 201, { invitation, inviteUrl: `${new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).origin}/invite/${token}` });
        }
        catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Não foi possível gerar o convite." });
        }
        return;
    }
    if (url.pathname.startsWith("/api/admin/users/") && req.method === "PATCH") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem editar usuários." });
            return;
        }
        const userId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
        const body = await readJson(req);
        const data = await store.read();
        const existing = data.users.find((item) => item.id === userId);
        if (!existing) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        const updates = {};
        if (body.email !== undefined)
            updates.email = body.email.trim();
        if (body.displayName !== undefined)
            updates.displayName = body.displayName.trim();
        if (body.username !== undefined)
            updates.username = body.username.trim();
        if (body.role !== undefined)
            updates.role = sanitizeUserRole(body.role);
        if (body.allowedLibraryIds !== undefined)
            updates.allowedLibraryIds = sanitizeLibraryIds(body.allowedLibraryIds, data.libraries);
        if (body.canLogin !== undefined)
            updates.canLogin = Boolean(body.canLogin);
        if (body.canDownload !== undefined)
            updates.canDownload = Boolean(body.canDownload);
        if (body.canChangePassword !== undefined)
            updates.canChangePassword = Boolean(body.canChangePassword);
        if (body.password?.trim())
            updates.passwordHash = hashPassword(body.password.trim());
        const updated = await store.updateUser(userId, updates);
        if (!updated) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        sendJson(res, 200, { user: toPublicUser(updated) });
        return;
    }
    if (url.pathname.startsWith("/api/admin/users/") && req.method === "DELETE") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem remover usuários." });
            return;
        }
        const userId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
        if (userId === user.id) {
            sendJson(res, 400, { error: "Você não pode remover sua própria conta." });
            return;
        }
        const deleted = await store.deleteUser(userId);
        if (!deleted) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/libraries" && req.method === "GET") {
        const data = await store.read();
        const libraries = getVisibleLibraries(user, data.libraries);
        sendJson(res, 200, { libraries });
        return;
    }
    if (url.pathname === "/api/libraries" && req.method === "POST") {
        const body = await readJson(req);
        const isPersonal = Boolean(body.isPersonal);
        if (isPersonal && user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem criar bibliotecas pessoais." });
            return;
        }
        if (user.role !== "admin" && !isPersonal) {
            sendJson(res, 403, { error: "Apenas administradores podem criar bibliotecas públicas." });
            return;
        }
        const name = body.name?.trim();
        const libraryPath = body.path?.trim();
        if (!name || !libraryPath || !isLibraryKind(body.kind)) {
            sendJson(res, 400, { error: "Nome, tipo e pasta são obrigatórios." });
            return;
        }
        if (!isInsideMediaRoot(libraryPath)) {
            sendJson(res, 400, { error: `A pasta deve estar dentro de ${config.mediaRoot}.` });
            return;
        }
        const stat = await fs.stat(libraryPath).catch(() => null);
        if (!stat?.isDirectory()) {
            sendJson(res, 400, { error: "A pasta selecionada não existe ou não é um diretório." });
            return;
        }
        const data = await store.read();
        const candidateLibrary = {
            id: makeLibraryId(name, data.libraries),
            name,
            kind: body.kind,
            path: libraryPath,
            isPersonal,
            ownerUserId: isPersonal ? user.id : null
        };
        const detectedContents = await scanLibrary(candidateLibrary);
        if (detectedContents.length === 0) {
            sendJson(res, 400, { error: "Nenhuma obra detectada. A pasta deve conter pastas de obras com capítulos, capa e metadata.json." });
            return;
        }
        const library = await store.createLibrary({
            id: candidateLibrary.id,
            name,
            kind: body.kind,
            path: libraryPath,
            isPersonal,
            ownerUserId: isPersonal ? user.id : null
        });
        sendJson(res, 201, { library });
        return;
    }
    if (url.pathname.startsWith("/api/libraries/") && req.method === "PATCH") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem editar bibliotecas." });
            return;
        }
        const libraryId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, libraryId, req);
        if (!library) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        const name = body.name?.trim();
        const libraryPath = body.path?.trim();
        if (!name || !libraryPath || !isLibraryKind(body.kind)) {
            sendJson(res, 400, { error: "Nome, tipo e pasta são obrigatórios." });
            return;
        }
        if (!isInsideMediaRoot(libraryPath)) {
            sendJson(res, 400, { error: `A pasta deve estar dentro de ${config.mediaRoot}.` });
            return;
        }
        const stat = await fs.stat(libraryPath).catch(() => null);
        if (!stat?.isDirectory()) {
            sendJson(res, 400, { error: "A pasta selecionada não existe ou não é um diretório." });
            return;
        }
        const candidateLibrary = {
            ...library,
            name,
            kind: body.kind,
            path: libraryPath
        };
        const detectedContents = await scanLibrary(candidateLibrary);
        if (detectedContents.length === 0) {
            sendJson(res, 400, { error: "Nenhuma obra detectada. A pasta deve conter pastas de obras com capítulos, capa e metadata.json." });
            return;
        }
        const updated = await store.updateLibrary(library.id, {
            name,
            kind: body.kind,
            path: libraryPath
        });
        if (!updated) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        sendJson(res, 200, { library: updated });
        return;
    }
    if (url.pathname.startsWith("/api/libraries/") && req.method === "DELETE") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem apagar bibliotecas." });
            return;
        }
        const libraryId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, libraryId, req);
        if (!library) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        const deleted = await store.deleteLibrary(library.id);
        if (!deleted) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/admin/folders" && req.method === "GET") {
        try {
            const requestedPath = url.searchParams.get("path") ?? (url.searchParams.get("scope") === "vault" ? config.vaultMediaRoot : config.mediaRoot);
            sendJson(res, 200, await readMediaDirectory(requestedPath));
        }
        catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Não foi possível ler a pasta." });
        }
        return;
    }
    if (url.pathname.startsWith("/api/libraries/") && url.pathname.endsWith("/contents") && req.method === "GET") {
        const libraryId = url.pathname.split("/")[3];
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, libraryId, req);
        if (!library) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        const contents = await scanLibrary(library);
        sendJson(res, 200, { contents });
        return;
    }
    if (url.pathname.startsWith("/api/libraries/") && url.pathname.endsWith("/scan") && req.method === "POST") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem escanear bibliotecas." });
            return;
        }
        const libraryId = url.pathname.split("/")[3];
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, libraryId, req);
        if (!library) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        const contents = await scanLibrary(library);
        const scannedAt = new Date().toISOString();
        await store.markLibraryScanned(library.id, scannedAt);
        sendJson(res, 200, { contents, scannedAt });
        return;
    }
    if (url.pathname.startsWith("/api/contents/") && url.pathname.endsWith("/scan") && req.method === "POST") {
        const contentId = decodeURIComponent(url.pathname.replace(/^\/api\/contents\//, "").replace(/\/scan$/, ""));
        const visible = await findVisibleContent(user, contentId);
        if (!visible) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const contents = await scanLibrary(visible.library);
        const content = contents.find((item) => item.id === contentId);
        const scannedAt = new Date().toISOString();
        await store.markLibraryScanned(visible.library.id, scannedAt);
        sendJson(res, 200, { content, scannedAt });
        return;
    }
    if (url.pathname.startsWith("/api/contents/") && req.method === "GET") {
        const coverRequest = parseContentCoverPath(url.pathname);
        if (coverRequest) {
            const data = await store.read();
            const libraryId = coverRequest.contentId.split(":")[0] ?? "";
            const library = getRequestLibrary(user, data.libraries, libraryId, req);
            if (!library) {
                sendJson(res, 404, { error: "Conteúdo não encontrado." });
                return;
            }
            const thumbPath = await getContentCoverThumbnail(library, coverRequest.contentId);
            if (thumbPath) {
                await sendFile(res, thumbPath);
                return;
            }
            const coverPath = await getContentCoverPath(library, coverRequest.contentId);
            if (!coverPath) {
                sendJson(res, 404, { error: "Capa não encontrada." });
                return;
            }
            await sendFile(res, coverPath);
            return;
        }
        const pageRequest = parseContentPagePath(url.pathname);
        if (!pageRequest) {
            sendJson(res, 404, { error: "Página não encontrada." });
            return;
        }
        const data = await store.read();
        const libraryId = pageRequest.contentId.split(":")[0] ?? "";
        const library = getRequestLibrary(user, data.libraries, libraryId, req);
        if (!library) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const pagePath = await getContentPagePath(library, pageRequest.contentId, pageRequest.pageIndex);
        if (!pagePath) {
            sendJson(res, 404, { error: "Página não encontrada." });
            return;
        }
        await sendFile(res, pagePath);
        return;
    }
    if (url.pathname === "/api/continue" && req.method === "GET") {
        const data = await store.read();
        const progress = data.progress.filter((item) => item.userId === user.id);
        sendJson(res, 200, { progress });
        return;
    }
    if (url.pathname === "/api/user-lists" && req.method === "GET") {
        const data = await store.read();
        const wantToRead = data.wantToRead.filter((item) => item.userId === user.id).map((item) => item.contentId);
        const readingList = data.readingList.filter((item) => item.userId === user.id).map((item) => item.contentId);
        const collections = data.collections
            .filter((item) => item.userId === user.id || item.sharedWithUserIds.includes(user.id))
            .map((collection) => makePublicCollection(collection, data.users.find((item) => item.id === collection.userId)));
        sendJson(res, 200, { wantToRead, readingList, collections });
        return;
    }
    if (url.pathname === "/api/collections" && req.method === "POST") {
        const body = await readJson(req);
        const name = body.name?.trim();
        const description = body.description?.trim() ?? "";
        if (!name) {
            sendJson(res, 400, { error: "Informe o nome da coleção." });
            return;
        }
        if (name.length > 80) {
            sendJson(res, 400, { error: "O nome da coleção deve ter até 80 caracteres." });
            return;
        }
        if (description.length > 240) {
            sendJson(res, 400, { error: "A descrição deve ter até 240 caracteres." });
            return;
        }
        const data = await store.read();
        const collection = await store.createCollection({
            id: makeCollectionId(name, user.id, data.collections),
            userId: user.id,
            name,
            description,
            sharedWithUserIds: [],
            contentIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        sendJson(res, 201, { collection: makePublicCollection(collection, user) });
        return;
    }
    if (url.pathname.startsWith("/api/collections/") && url.pathname.endsWith("/sharing") && req.method === "PUT") {
        const collectionId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        const data = await store.read();
        const allowedUserIds = new Set(data.users.map((item) => item.id));
        const sharedWithUserIds = Array.from(new Set((body.userIds ?? []).filter((userId) => userId !== user.id && allowedUserIds.has(userId))));
        const collection = await store.updateCollectionSharing(user.id, collectionId, sharedWithUserIds);
        if (!collection) {
            sendJson(res, 404, { error: "Coleção não encontrada." });
            return;
        }
        sendJson(res, 200, { collection: makePublicCollection(collection, user) });
        return;
    }
    if (url.pathname.startsWith("/api/collections/") && !url.pathname.endsWith("/contents") && req.method === "PATCH") {
        const collectionId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        const name = body.name?.trim();
        const description = body.description?.trim() ?? "";
        if (!collectionId) {
            sendJson(res, 400, { error: "Coleção não informada." });
            return;
        }
        if (!name) {
            sendJson(res, 400, { error: "Informe o nome da coleção." });
            return;
        }
        if (name.length > 80) {
            sendJson(res, 400, { error: "O nome da coleção deve ter até 80 caracteres." });
            return;
        }
        if (description.length > 240) {
            sendJson(res, 400, { error: "A descrição deve ter até 240 caracteres." });
            return;
        }
        const collection = await store.updateCollection(user.id, collectionId, { name, description });
        if (!collection) {
            sendJson(res, 404, { error: "Coleção não encontrada." });
            return;
        }
        sendJson(res, 200, { collection: makePublicCollection(collection, user) });
        return;
    }
    if (url.pathname.startsWith("/api/collections/") && !url.pathname.endsWith("/contents") && !url.pathname.endsWith("/sharing") && req.method === "DELETE") {
        const collectionId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const deleted = await store.deleteCollection(user.id, collectionId);
        if (!deleted) {
            sendJson(res, 404, { error: "Coleção não encontrada." });
            return;
        }
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/bookmarks" && req.method === "GET") {
        const data = await store.read();
        const bookmarks = data.bookmarks.filter((item) => item.userId === user.id);
        sendJson(res, 200, { bookmarks });
        return;
    }
    if (url.pathname === "/api/reviews" && req.method === "GET") {
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId) {
            sendJson(res, 400, { error: "Conteúdo não informado." });
            return;
        }
        const data = await store.read();
        if (!findVisibleLibraryForContentId(user, data.libraries, contentId)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const visibleReviews = data.reviews
            .filter((item) => item.contentId === contentId)
            .map((review) => {
            const author = data.users.find((item) => item.id === review.userId);
            if (!author) {
                return null;
            }
            return makePublicReview(review, author);
        })
            .filter((item) => Boolean(item))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        sendJson(res, 200, { reviews: visibleReviews });
        return;
    }
    if (url.pathname === "/api/progress" && req.method === "PUT") {
        const body = await readJson(req);
        const visible = await findRequestContent(user, body.contentId, req);
        if (!visible) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.upsertProgress({
            userId: user.id,
            contentId: body.contentId,
            currentPage: Math.min(Math.max(Number(body.currentPage), 0), Math.max(visible.pageCount - 1, 0)),
            updatedAt: new Date().toISOString()
        });
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/progress" && req.method === "DELETE") {
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId) {
            sendJson(res, 400, { error: "Conteúdo não informado." });
            return;
        }
        const data = await store.read();
        if (!findVisibleLibraryForContentId(user, data.libraries, contentId)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.removeProgress(user.id, contentId);
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/bookmarks" && req.method === "POST") {
        const body = await readJson(req);
        const result = await store.toggleBookmark({
            userId: user.id,
            contentId: body.contentId,
            page: body.page,
            createdAt: new Date().toISOString()
        });
        sendJson(res, 200, result);
        return;
    }
    if (url.pathname === "/api/reviews" && req.method === "POST") {
        const body = await readJson(req);
        const contentId = body.contentId?.trim();
        const rating = Number(body.rating);
        const comment = body.comment?.trim();
        if (!contentId || !Number.isFinite(rating) || rating < 0 || rating > 10 || !comment) {
            sendJson(res, 400, { error: "Conteúdo, nota e comentário são obrigatórios." });
            return;
        }
        const data = await store.read();
        if (!findVisibleLibraryForContentId(user, data.libraries, contentId)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const review = {
            userId: user.id,
            contentId,
            rating,
            comment,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        await store.upsertReview(review);
        sendJson(res, 200, { review: makePublicReview(review, user) });
        return;
    }
    if (url.pathname === "/api/series-marks" && req.method === "GET") {
        const data = await store.read();
        const seriesMarks = data.seriesMarks.filter((item) => item.userId === user.id).map((item) => item.contentId);
        sendJson(res, 200, { seriesMarks });
        return;
    }
    if (url.pathname === "/api/series-marks" && req.method === "POST") {
        const body = await readJson(req);
        const result = await store.toggleSeriesMark({
            userId: user.id,
            contentId: body.contentId,
            createdAt: new Date().toISOString()
        });
        sendJson(res, 200, result);
        return;
    }
    if (url.pathname === "/api/want-to-read" && req.method === "POST") {
        const body = await readJson(req);
        if (!(await findVisibleContent(user, body.contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.addToWantToRead({
            userId: user.id,
            contentId: body.contentId,
            createdAt: new Date().toISOString()
        });
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/want-to-read" && req.method === "DELETE") {
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId || !(await findVisibleContent(user, contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.removeFromWantToRead(user.id, contentId);
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/reading-list" && req.method === "POST") {
        const body = await readJson(req);
        if (!(await findVisibleContent(user, body.contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.addToReadingList({
            userId: user.id,
            contentId: body.contentId,
            createdAt: new Date().toISOString()
        });
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/reading-list" && req.method === "DELETE") {
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId || !(await findVisibleContent(user, contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.removeFromReadingList(user.id, contentId);
        sendNoContent(res);
        return;
    }
    if (url.pathname.startsWith("/api/collections/") && url.pathname.endsWith("/contents") && req.method === "POST") {
        const collectionId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        if (!(await findVisibleContent(user, body.contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const collection = await store.addToCollection(user.id, collectionId, body.contentId);
        if (!collection) {
            sendJson(res, 404, { error: "Coleção não encontrada." });
            return;
        }
        sendJson(res, 200, { collection: makePublicCollection(collection, user) });
        return;
    }
    if (url.pathname.startsWith("/api/collections/") && url.pathname.endsWith("/contents") && req.method === "DELETE") {
        const collectionId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId || !(await findVisibleContent(user, contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const collection = await store.removeFromCollection(user.id, collectionId, contentId);
        if (!collection) {
            sendJson(res, 404, { error: "Coleção não encontrada." });
            return;
        }
        sendJson(res, 200, { collection: makePublicCollection(collection, user) });
        return;
    }
    if (url.pathname === "/api/content-state" && req.method === "DELETE") {
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId) {
            sendJson(res, 400, { error: "Conteúdo não informado." });
            return;
        }
        const data = await store.read();
        if (!findVisibleLibraryForContentId(user, data.libraries, contentId)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.removeContentForUser(user.id, contentId);
        sendNoContent(res);
        return;
    }
    sendJson(res, 404, { error: "Rota não encontrada." });
}
const server = http.createServer(async (req, res) => {
    try {
        if (req.url?.startsWith("/api/")) {
            await handleApi(req, res);
            return;
        }
        await serveStatic(req, res);
    }
    catch (error) {
        console.error(error);
        sendJson(res, 500, { error: "Erro interno do Pugotiread." });
    }
});
server.listen(config.port, () => {
    if (!config.smtpHost) {
        console.warn("[SMTP] SMTP_HOST nao configurado. Recuperacao de senha vai cair no console.");
    }
    console.log(`Pugotiread rodando em http://localhost:${config.port}`);
});
//# sourceMappingURL=index.js.map