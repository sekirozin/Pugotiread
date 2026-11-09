import { pageImageVariant } from "./reader-resources.js";
import crypto from "node:crypto";
import { rpgSheetCopyFolder } from '../shared/rpg-folders.js';
import { handleRpg } from './rpg.js';
import { reconcilePdfLocation, pdfLocationMissing } from './pdf-locations.js';
import { describeForm, fillCopyBytes, copyName, publishCopy, FormError, formRevision, fullFormName, withFormLock, updateForm, previewPdf } from "./pdf-forms.js";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { clearSessionCookie, createSessionToken, getCookie, getCurrentUser, hashPassword, isPasswordHashReady, setSessionCookie, toPublicUser, verifyGoogleIdToken, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { cacheService } from "./cache.js";
import { readJson, sendBuffer, sendFile, sendHtml, sendJson, sendNoContent, serveStatic } from "./http.js";
import { sendPasswordResetEmail } from "./mailer.js";
import { canDownloadToLibrary, canSyncLibrary, getPugotiSyncStatus, isPugotiSyncBusy, startPugotiSync } from "./pugoti-sync.js";
import { getContentCoverPath, getContentCoverThumbnail, getContentEpubAsset, getContentEpubChapterHtml, getContentEpubTextLengths, getContentPagePath, scanLibrary as scanMediaLibrary, searchEpubText, startLibraryWatchers } from "./media.js";
import { normalizeReadingDefaults, normalizeVaultTimeoutMinutes, store } from "./store.js";
import type { ContentCollection, ContentItem, ContentReview, Invitation, Library, LibraryKind, PasswordResetToken, PublicContentReview, ServerSettings, User } from "../shared/types.js";

function isPersonalLibrary(library: Library): boolean {
  return Boolean(library.isPersonal);
}

async function scanLibrary(library:Library,options:{refresh?:boolean}={}):Promise<ContentItem[]> {
  const contents=await scanMediaLibrary(library,options);
  if(!['other','book','lightNovel'].includes(library.kind))return contents;
  const result:ContentItem[]=[];
  for(const content of contents){
    if(!content.pageTypes.includes('pdf') || await reconcilePdfLocation(library,content.id)===content.id)result.push(content);
  }
  return result;
}

function getVisibleLibraries(user: User, libraries: Library[]): Library[] {
  const regularLibraries = libraries.filter((library) => !isPersonalLibrary(library));
  return user.role === "admin"
    ? regularLibraries
    : regularLibraries.filter((library) => user.allowedLibraryIds.includes(library.id));
}

function getPersonalLibraries(user: User, libraries: Library[]): Library[] {
  return libraries.filter((library) => isPersonalLibrary(library) && library.ownerUserId === user.id);
}

function findDownloadLibrary(libraries: Library[], kind: "manga" | "manhwa"): Library | undefined {
  const directMatch = libraries.find((library) => !library.isPersonal && library.kind === kind);
  if (directMatch) {
    return directMatch;
  }

  // Bibliotecas antigas de manhwa podem ter sido cadastradas como "manga".
  // Não alteramos seu schema aqui; apenas identificamos corretamente a pasta
  // de destino para o download individual.
  const normalizedKind = kind === "manhwa" ? "manhwa" : "manga";
  return libraries.find((library) =>
    !library.isPersonal
    && canSyncLibrary(library)
    && `${library.name} ${library.path}`.normalize("NFD").replaceAll(/\p{Diacritic}/gu, "").toLowerCase().includes(normalizedKind)
  );
}

function createVaultToken(userId: string, timeoutMinutes: number): string {
  const payload = `${userId}.${Date.now() + timeoutMinutes * 60 * 1000}`;
  const signature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
  return `${payload}.${signature}`;
}

function hasValidVaultToken(req: http.IncomingMessage, user: User): boolean {
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

function getRequestLibrary(user: User, libraries: Library[], libraryId: string, req: http.IncomingMessage): Library | null {
  const library = libraries.find((item) => item.id === libraryId) ?? null;
  if (!library) {
    return null;
  }

  if (isPersonalLibrary(library)) {
    return library.ownerUserId === user.id && hasValidVaultToken(req, user) ? library : null;
  }

  return user.role === "admin" || user.allowedLibraryIds.includes(library.id) ? library : null;
}

function findVisibleLibraryForContentId(user: User, libraries: Library[], contentId: string): Library | null {
  return getVisibleLibraries(user, libraries).find((item) => contentId.startsWith(`${item.id}:`)) ?? null;
}

function visibleContents(user: User, contents: ContentItem[]): ContentItem[] {
  const copies = new Map(store.pdfFormCopies().map(copy => [copy.contentId, copy]));
  const roles = new Map(store.rpgDocuments().map(item => [item.contentId,item.role]));
  return contents.filter((content) => store.canAccessPdfContent(content.id, user)).map(content => {
    const copy = copies.get(content.id);
    return { ...content, rpgRole: roles.get(content.id), ...(copy ? {system:copy.system || content.system,formOwnerUserId:copy.ownerUserId || null,formVisibility:copy.visibility} : {}) };
  });
}

async function findVisibleContent(user: User, contentId: string): Promise<{ library: Library; pageCount: number } | null> {
  if (!store.canAccessPdfContent(contentId, user)) return null;
  const data = await store.read();
  const library = findVisibleLibraryForContentId(user, data.libraries, contentId);
  if (!library) {
    return null;
  }

  const contents = await scanLibrary(library);
  const content = contents.find((item) => item.id === contentId);
  return content ? { library, pageCount: content.pageCount } : null;
}

async function findRequestContent(user: User, contentId: string, req: http.IncomingMessage): Promise<{ library: Library; pageCount: number } | null> {
  if (!store.canAccessPdfContent(contentId, user)) return null;
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

function parseContentPagePath(pathname: string): { contentId: string; pageIndex: number } | null {
  const match = pathname.match(/^\/api\/contents\/(.+)\/pages\/(\d+)$/);
  if (!match) {
    return null;
  }

  return {
    contentId: decodeURIComponent(match[1] ?? ""),
    pageIndex: Number(match[2])
  };
}

function parseContentEpubAssetPath(pathname: string): { contentId: string; assetPath: string } | null {
  const match = pathname.match(/^\/api\/contents\/(.+)\/epub-assets\/(.+)$/);
  if (!match) {
    return null;
  }

  return {
    contentId: decodeURIComponent(match[1] ?? ""),
    assetPath: (match[2] ?? "").split("/").map((part) => decodeURIComponent(part)).join("/")
  };
}

function waitForSyncCompletion(): Promise<void> {
  return new Promise((resolve) => {
    const timer = setInterval(() => {
      if (!isPugotiSyncBusy()) {
        clearInterval(timer);
        resolve();
      }
    }, 1000);
  });
}

let automaticSyncCycleRunning = false;

async function runAutomaticSyncCycle(): Promise<void> {
  if (automaticSyncCycleRunning || isPugotiSyncBusy()) {
    console.log("[SYNC] Ciclo automático ignorado: já existe uma sincronização em andamento.");
    return;
  }

  automaticSyncCycleRunning = true;
  try {
    const data = await store.read();
    const libraries = data.libraries.filter(canSyncLibrary);
    console.log(`[SYNC] Iniciando ciclo automático de ${libraries.length} biblioteca(s).`);

    for (const library of libraries) {
      try {
        await startPugotiSync(library, null, async () => {
          await invalidateLibraryScanCache(library.id);
          await scanLibrary(library, { refresh: true });
          await store.markLibraryScanned(library.id, new Date().toISOString());
        }, "automatic");
        await waitForSyncCompletion();

        const status = getPugotiSyncStatus();
        console.log(`[SYNC] ${library.name}: ${status.state} - ${status.message}`);
      } catch (error) {
        console.error(`[SYNC] ${library.name}:`, error);
      }
    }

    console.log("[SYNC] Ciclo automático finalizado.");
  } finally {
    automaticSyncCycleRunning = false;
  }
}

function parseContentCoverPath(pathname: string): { contentId: string } | null {
  const match = pathname.match(/^\/api\/contents\/(.+)\/cover$/);
  if (!match) {
    return null;
  }

  return { contentId: decodeURIComponent(match[1] ?? "") };
}

function slugify(value: string): string {
  return value
    .normalize("NFD")
    .replaceAll(/\p{Diacritic}/gu, "")
    .toLowerCase()
    .replace(/[^a-z0-9]+/g, "-")
    .replace(/(^-|-$)/g, "");
}

function makeLibraryId(name: string, existing: Library[]): string {
  const base = slugify(name) || "biblioteca";
  let next = base;
  let counter = 2;

  while (existing.some((library) => library.id === next)) {
    next = `${base}-${counter}`;
    counter += 1;
  }

  return next;
}

function makeUserId(base: string, existing: User[]): string {
  const normalized = slugify(base) || "user";
  let next = normalized;
  let counter = 2;
  while (existing.some((user) => user.id === next)) {
    next = `${normalized}-${counter}`;
    counter += 1;
  }
  return next;
}

function makeInviteToken(): string {
  return crypto.randomBytes(18).toString("hex");
}

function makePasswordResetTokenValue(): string {
  return crypto.randomBytes(18).toString("hex");
}

function hashPasswordResetToken(token: string): string {
  return crypto.createHash("sha256").update(token).digest("hex");
}

function makePasswordResetLink(token: string): string {
  return `${config.publicUrl.replace(/\/$/, "")}/reset-password/${encodeURIComponent(token)}`;
}

async function issuePasswordResetToken(user: User): Promise<PasswordResetToken> {
  const token = makePasswordResetTokenValue();
  const tokenHash = hashPasswordResetToken(token);
  const now = Date.now();
  const createdAt = new Date(now).toISOString();
  const expiresAt = new Date(now + 30 * 60 * 1000).toISOString();
  const resetToken: PasswordResetToken = {
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

function normalizeEmail(email: string): string {
  return email.trim().toLowerCase();
}

function sanitizeLibraryIds(libraryIds: string[], libraries: Library[]): string[] {
  const allowed = new Set(libraries.map((library) => library.id));
  return Array.from(new Set(libraryIds.filter((id) => allowed.has(id))));
}

function sanitizeUserRole(role: unknown): User["role"] {
  if (role === "admin" || role === "superuser") return role as User["role"];
  return "user";
}

function hasConfiguredAdmin(users: User[]): boolean {
  return users.some((item) => item.role === "admin" && isPasswordHashReady(item.passwordHash));
}

function buildUserFromInput(body: {
  email?: string;
  displayName?: string;
  username?: string;
  password?: string;
  role?: User["role"];
  allowedLibraryIds?: string[];
  canLogin?: boolean;
  canDownload?: boolean;
  canChangePassword?: boolean;
  passwordChangeRequiresEmailConfirmation?: boolean;
  passwordHash?: string;
}, existingUsers: User[], libraries: Library[]): User {
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

function makeCollectionId(name: string, userId: string, existing: ContentCollection[]): string {
  const base = slugify(name) || "colecao";
  let next = base;
  let counter = 2;

  while (existing.some((collection) => collection.userId === userId && collection.id === next)) {
    next = `${base}-${counter}`;
    counter += 1;
  }

  return next;
}

function makePublicReview(review: ContentReview, user: User): PublicContentReview {
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

function getVisibleReviewCountForUser(viewer: User, data: { libraries: Library[]; reviews: ContentReview[] }, userId: string): number {
  return data.reviews.filter(
    (review) => review.userId === userId && Boolean(findVisibleLibraryForContentId(viewer, data.libraries, review.contentId))
  ).length;
}

function makePublicCollection(collection: ContentCollection, owner?: User): Pick<ContentCollection, "id" | "userId" | "name" | "description" | "sharedWithUserIds" | "contentIds"> & { ownerDisplayName: string } {
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

function isLibraryKind(value: string): value is LibraryKind {
  return value === "manga" || value === "manhwa" || value === "book" || value === "comic" || value === "lightNovel" || value === "other";
}

function isSyncSkippedLibraryKind(kind: LibraryKind): boolean {
  return kind === "book" || kind === "lightNovel";
}

async function invalidateLibraryScanCache(libraryId: string): Promise<void> {
  cacheService.invalidateScan(libraryId);
  await cacheService.invalidateLibraryCovers(libraryId);
}

function getNoDetectedContentMessage(kind: LibraryKind): string {
  if (kind === "book" || kind === "lightNovel") {
    return "Nenhuma obra detectada. Para livros, coloque arquivos .epub ou .pdf na pasta da biblioteca ou dentro de pastas de obras.";
  }

  if (kind === "other") {
    return "Nenhuma obra detectada. A pasta deve conter PDFs diretamente ou pastas de obras com imagens ou PDFs.";
  }

  return "Nenhuma obra detectada. A pasta deve conter pastas de obras com imagens ou PDFs.";
}

function isInsideMediaRoot(candidatePath: string): boolean {
  const relative = path.relative(path.resolve(config.mediaRoot), path.resolve(candidatePath));
  return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}

async function readMediaDirectory(requestedPath: string): Promise<{ path: string; parent: string | null; directories: Array<{ name: string; path: string }> }> {
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

async function handleApi(req: http.IncomingMessage, res: http.ServerResponse): Promise<void> {
  const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
  const user = await getCurrentUser(req, res);

  if (url.pathname === "/api/setup/status" && req.method === "GET") {
    const data = await store.read();
    sendJson(res, 200, { setupRequired: !hasConfiguredAdmin(data.users) });
    return;
  }

  if (url.pathname === "/api/setup/admin" && req.method === "POST") {
    const body = await readJson<{
      username: string;
      displayName: string;
      email: string;
      password: string;
    }>(req);
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
    const userRecord: User = {
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
    } else {
      data.users.push(userRecord);
    }

    await store.write(data);
    setSessionCookie(res, createSessionToken(userRecord.id));
    sendJson(res, 201, { user: toPublicUser(userRecord) });
    return;
  }

  if (url.pathname === "/api/login" && req.method === "POST") {
    const body = await readJson<{ username: string; password: string }>(req);
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

  if (url.pathname === "/api/auth/pugotilab/config" && req.method === "GET") {
    sendJson(res, 200, {
      authUrl: config.pugotilabAuthUrl,
      logoutUrl: config.pugotilabLogoutUrl
    });
    return;
  }

  if (url.pathname === "/api/auth/google" && req.method === "POST") {
    const body = await readJson<{ credential: string; inviteToken?: string }>(req);

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
    } catch (error) {
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
    const body = await readJson<{ email: string; nickname: string; password: string }>(req);
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
    const body = await readJson<{ email: string }>(req);
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
    const body = await readJson<{ newPassword: string }>(req);
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

  const directContent = url.pathname.match(/^\/api\/contents\/([^/]+)/);
  if (directContent) {
    const id=decodeURIComponent(directContent[1]);
    const library=getRequestLibrary(user,(await store.read()).libraries,id.split(':')[0],req);
    if(library) {
      const canonical=await reconcilePdfLocation(library,id);
      if(canonical!==id){sendJson(res,404,{error:'Use o material original da biblioteca.'});return;}
    }
  }

  if (url.pathname === "/api/me/reading-settings" && req.method === "GET") {
    const data = await store.read();
    sendJson(res, 200, { readingDefaults: data.settings.readingDefaults });
    return;
  }

  if (url.pathname === "/api/me/startup" && req.method === "GET") {
    const data = await store.read();
    const selected = data.settings.startupLibraries?.[user.id];
    const libraryId = getVisibleLibraries(user, data.libraries).find(item => item.id === selected)?.id ?? null;
    sendJson(res, 200, { libraryId });
    return;
  }

  if (url.pathname === "/api/me" && req.method === "GET") {
    sendJson(res, 200, { user: toPublicUser(user) });
    return;
  }

  if (url.pathname === "/api/me/password" && req.method === "PATCH") {
    const body = await readJson<{ currentPassword: string; newPassword: string }>(req);
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

    const body = await readJson<{ password: string }>(req);
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
    const body = await readJson<{
      avatarUrl?: string;
      nickname?: string;
      biography?: string;
      location?: string;
      favoriteContentIds?: string[];
    }>(req);
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

    const body = await readJson<Partial<ServerSettings>>(req);
    if (body.vaultTimeoutMinutes !== undefined && (!Number.isInteger(Number(body.vaultTimeoutMinutes)) || Number(body.vaultTimeoutMinutes) < 1)) {
      sendJson(res, 400, { error: "O tempo do cofre deve ser um número inteiro maior que zero." });
      return;
    }

    if (body.startupLibraries !== undefined) {
      const data = await store.read();
      if (!body.startupLibraries || typeof body.startupLibraries !== "object" || Array.isArray(body.startupLibraries) || Object.entries(body.startupLibraries).some(([id, libraryId]) => {
        const target = data.users.find(item => item.id === id);
        return !target || typeof libraryId !== "string" || (libraryId !== "" && !getVisibleLibraries(target, data.libraries).some(item => item.id === libraryId));
      })) {
        sendJson(res, 400, { error: "Selecione uma biblioteca acessível ao usuário." });
        return;
      }
    }
    const settings = await store.updateSettings({
      startupLibraries: body.startupLibraries,
      vaultTimeoutMinutes: body.vaultTimeoutMinutes === undefined ? undefined : Number(body.vaultTimeoutMinutes),
      readingDefaults: body.readingDefaults === undefined ? undefined : normalizeReadingDefaults(body.readingDefaults)
    });
    sendJson(res, 200, { settings });
    return;
  }

  if (url.pathname === "/api/admin/sync/status" && req.method === "GET") {
    if (user.role !== "admin") {
      sendJson(res, 403, { error: "Apenas administradores podem acompanhar sincronizações." });
      return;
    }
    sendJson(res, 200, { sync: getPugotiSyncStatus() });
    return;
  }

  if (url.pathname === "/api/admin/sync" && req.method === "POST") {
    if (user.role !== "admin") {
      sendJson(res, 403, { error: "Apenas administradores podem sincronizar bibliotecas." });
      return;
    }

    const body = await readJson<{ libraryId?: string; contentId?: string | null }>(req);
    const data = await store.read();
    const library = data.libraries.find((item) => item.id === body.libraryId && !item.isPersonal);
    if (!library) {
      sendJson(res, 404, { error: "Biblioteca não encontrada." });
      return;
    }
    if (!canSyncLibrary(library)) {
      sendJson(res, 400, { error: "Este tipo de biblioteca não participa da sincronização." });
      return;
    }

    await invalidateLibraryScanCache(library.id);
    const currentContents = await scanLibrary(library, { refresh: true });
    const content = body.contentId
      ? currentContents.find((item) => item.id === body.contentId) ?? null
      : null;
    if (body.contentId && !content) {
      sendJson(res, 404, { error: "Obra não encontrada na biblioteca selecionada." });
      return;
    }

    try {
      const sync = await startPugotiSync(library, content, async () => {
        await invalidateLibraryScanCache(library.id);
        await scanLibrary(library, { refresh: true });
        await store.markLibraryScanned(library.id, new Date().toISOString());
      });
      sendJson(res, 202, { sync });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível sincronizar a biblioteca.";
      sendJson(res, message === "Já existe uma sincronização em andamento." ? 409 : 500, { error: message });
    }
    return;
  }

  if (url.pathname === "/api/admin/download" && req.method === "POST") {
    if (user.role !== "admin" && user.role !== "superuser") {
      sendJson(res, 403, { error: "Apenas administradores e superusers podem iniciar downloads." });
      return;
    }

    const body = await readJson<{ kind?: string; url?: string }>(req);
    const requestedKind = body.kind === "manga" || body.kind === "manhwa" || body.kind === "vault" ? body.kind : null;
    const link = String(body.url ?? "").trim();
    if (!requestedKind) {
      sendJson(res, 400, { error: "Selecione Mangá, Manhwa ou Cofre." });
      return;
    }

    let parsedLink: URL;
    try {
      parsedLink = new URL(link);
    } catch {
      sendJson(res, 400, { error: "Informe um link válido." });
      return;
    }
    if (!/^https?:$/.test(parsedLink.protocol) || !parsedLink.hostname || !parsedLink.pathname || parsedLink.username || parsedLink.password) {
      sendJson(res, 400, { error: "Informe um link HTTP ou HTTPS válido." });
      return;
    }

    const data = await store.read();
    const vaultLibrary = requestedKind === "vault"
      ? getPersonalLibraries(user, data.libraries).find(canDownloadToLibrary)
      : undefined;
    if (requestedKind === "vault" && !hasValidVaultToken(req, user)) {
      sendJson(res, 403, { error: "Desbloqueie o cofre antes de adicionar uma obra a ele." });
      return;
    }

    const library = vaultLibrary ?? (requestedKind === "vault" ? undefined : findDownloadLibrary(data.libraries, requestedKind));
    if (!library) {
      const label = requestedKind === "vault" ? "cofre pessoal" : requestedKind === "manga" ? "mangás" : "manhwas";
      sendJson(res, 404, { error: `Nenhuma biblioteca de ${label} está configurada.` });
      return;
    }

    const downloadKind = requestedKind === "vault"
      ? (library.kind === "manhwa" ? "manhwa" : "manga")
      : requestedKind;

    try {
      const sync = await startPugotiSync(
        library,
        null,
        async () => {
          await invalidateLibraryScanCache(library.id);
          await scanLibrary(library, { refresh: true });
          await store.markLibraryScanned(library.id, new Date().toISOString());
        },
        "manual",
        { kind: downloadKind, url: parsedLink.toString() }
      );
      const queuePosition = sync.queuedDownloads.length;
      sendJson(res, 202, { sync, queued: queuePosition > 0, queuePosition });
    } catch (error) {
      const message = error instanceof Error ? error.message : "Não foi possível iniciar o download.";
      sendJson(res, message === "Já existe uma sincronização em andamento." ? 409 : 500, { error: message });
    }
    return;
  }

  if (url.pathname === "/api/admin/users" && req.method === "POST") {
    if (user.role !== "admin") {
      sendJson(res, 403, { error: "Apenas administradores podem criar usuários." });
      return;
    }

    const body = await readJson<{
      email: string;
      displayName: string;
      username: string;
      password: string;
      role: User["role"];
      allowedLibraryIds: string[];
      canLogin: boolean;
      canDownload: boolean;
      canChangePassword: boolean;
    }>(req);
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
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Não foi possível criar o usuário." });
    }
    return;
  }

  if (url.pathname === "/api/admin/invites" && req.method === "POST") {
    if (user.role !== "admin") {
      sendJson(res, 403, { error: "Apenas administradores podem criar convites." });
      return;
    }

    const body = await readJson<{
      email: string;
      displayName: string;
      username: string;
      linkOnly?: boolean;
      role: User["role"];
      allowedLibraryIds: string[];
      canLogin: boolean;
      canDownload: boolean;
      canChangePassword: boolean;
    }>(req);
    const data = await store.read();

    try {
      const token = makeInviteToken();
      const linkOnly = Boolean(body.linkOnly);
      const invitation: Invitation = {
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
    } catch (error) {
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
    const body = await readJson<{
      email?: string;
      displayName?: string;
      username?: string;
      password?: string;
      role?: User["role"];
      allowedLibraryIds?: string[];
      canLogin?: boolean;
      canDownload?: boolean;
      canChangePassword?: boolean;
    }>(req);
    const data = await store.read();
    const existing = data.users.find((item) => item.id === userId);
    if (!existing) {
      sendJson(res, 404, { error: "Usuário não encontrado." });
      return;
    }

    const updates: Partial<User> = {};
    if (body.email !== undefined) updates.email = body.email.trim();
    if (body.displayName !== undefined) updates.displayName = body.displayName.trim();
    if (body.username !== undefined) updates.username = body.username.trim();
    if (body.role !== undefined) updates.role = sanitizeUserRole(body.role);
    if (body.allowedLibraryIds !== undefined) updates.allowedLibraryIds = sanitizeLibraryIds(body.allowedLibraryIds, data.libraries);
    if (body.canLogin !== undefined) updates.canLogin = Boolean(body.canLogin);
    if (body.canDownload !== undefined) updates.canDownload = Boolean(body.canDownload);
    if (body.canChangePassword !== undefined) updates.canChangePassword = Boolean(body.canChangePassword);
    if (body.password?.trim()) updates.passwordHash = hashPassword(body.password.trim());

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
    const body = await readJson<{ name: string; kind: string; path: string; isPersonal?: boolean }>(req);
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
    const candidateLibrary: Library = {
      id: makeLibraryId(name, data.libraries),
      name,
      kind: body.kind,
      path: libraryPath,
      isPersonal,
      ownerUserId: isPersonal ? user.id : null
    };
    const detectedContents = await scanLibrary(candidateLibrary, { refresh: true });
    if (detectedContents.length === 0) {
      sendJson(res, 400, { error: getNoDetectedContentMessage(body.kind) });
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

    startLibraryWatchers([...data.libraries, library]);
    sendJson(res, 201, { library });
    return;
  }

  if (url.pathname.startsWith("/api/libraries/") && req.method === "PATCH") {
    if (user.role !== "admin") {
      sendJson(res, 403, { error: "Apenas administradores podem editar bibliotecas." });
      return;
    }

    const libraryId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
    const body = await readJson<{ name: string; kind: string; path: string }>(req);
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

    const candidateLibrary: Library = {
      ...library,
      name,
      kind: body.kind,
      path: libraryPath
    };
    const detectedContents = await scanLibrary(candidateLibrary, { refresh: true });
    if (detectedContents.length === 0) {
      sendJson(res, 400, { error: getNoDetectedContentMessage(body.kind) });
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

    startLibraryWatchers(data.libraries.map((item) => item.id === updated.id ? updated : item));
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

    startLibraryWatchers(data.libraries.filter((item) => item.id !== library.id));
    sendNoContent(res);
    return;
  }

  if (url.pathname === "/api/admin/folders" && req.method === "GET") {
    try {
      const requestedPath = url.searchParams.get("path") ?? (url.searchParams.get("scope") === "vault" ? config.vaultMediaRoot : config.mediaRoot);
      sendJson(res, 200, await readMediaDirectory(requestedPath));
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Não foi possível ler a pasta." });
    }
    return;
  }

  if (url.pathname === "/api/admin/pdf-form-copies" && req.method === "GET") {
    if (user.role !== "admin") { sendJson(res, 403, { error: "Apenas administradores podem gerenciar fichas." }); return; }
    const data = await store.read();
    const contents = (await Promise.all(data.libraries.map(library => scanLibrary(library)))).flat();
    const contentById = new Map(contents.map(content => [content.id, content]));
    sendJson(res, 200, { copies: store.pdfFormCopies().map(copy => ({
      ...copy,
      title: contentById.get(copy.contentId)?.title,
      system: copy.system || contentById.get(copy.contentId)?.system || ""
    })) });
    return;
  }

  if (url.pathname.startsWith("/api/admin/pdf-form-copies/") && req.method === "PATCH") {
    if (user.role !== "admin") { sendJson(res, 403, { error: "Apenas administradores podem gerenciar fichas." }); return; }
    const contentId = decodeURIComponent(url.pathname.slice("/api/admin/pdf-form-copies/".length));
    const body = await readJson<{ ownerUserId?: string; visibility?: string; sharedWithUserIds?: string[]; system?: string }>(req);
    try {
      const copy = store.updatePdfFormCopy(contentId, {
        ownerUserId: body.ownerUserId ?? "",
        visibility: body.visibility ?? "private",
        sharedWithUserIds: Array.isArray(body.sharedWithUserIds) ? body.sharedWithUserIds : [],
        system: body.system ?? ""
      });
      if (!copy) { sendJson(res, 404, { error: "Ficha não encontrada." }); return; }
      sendJson(res, 200, { copy });
    } catch (error) {
      sendJson(res, 400, { error: error instanceof Error ? error.message : "Não foi possível atualizar a ficha." });
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

    const contents = visibleContents(user, await scanLibrary(library));
    const limitValue = Number(url.searchParams.get("limit"));
    const offsetValue = Number(url.searchParams.get("offset"));
    const hasPagination = Number.isInteger(limitValue) && limitValue > 0;
    if (!hasPagination) {
      sendJson(res, 200, { contents });
      return;
    }

    const offset = Number.isInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
    const limit = Math.min(limitValue, 100);
    sendJson(res, 200, {
      contents: contents.slice(offset, offset + limit),
      pagination: {
        offset,
        limit,
        total: contents.length,
        hasMore: offset + limit < contents.length
      }
    });
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

    await invalidateLibraryScanCache(library.id);

    if (isSyncSkippedLibraryKind(library.kind)) {
      const contents = await scanLibrary(library, { refresh: true });
      sendJson(res, 200, {
        contents,
        scannedAt: library.lastScannedAt ?? null,
        skipped: true,
        reason: "Livros não participam da sincronização de novos capítulos."
      });
      return;
    }

    const contents = await scanLibrary(library, { refresh: true });
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

    await invalidateLibraryScanCache(visible.library.id);

    if (isSyncSkippedLibraryKind(visible.library.kind)) {
      const contents = await scanLibrary(visible.library, { refresh: true });
      const content = contents.find((item) => item.id === contentId);
      sendJson(res, 200, {
        content,
        scannedAt: visible.library.lastScannedAt ?? null,
        skipped: true,
        reason: "Livros não participam da sincronização de novos capítulos."
      });
      return;
    }

    const contents = await scanLibrary(visible.library, { refresh: true });
    const content = contents.find((item) => item.id === contentId);
    const scannedAt = new Date().toISOString();
    await store.markLibraryScanned(visible.library.id, scannedAt);
    sendJson(res, 200, { content, scannedAt });
    return;
  }

  const rpgMatch = url.pathname.match(/^\/api\/contents\/([^/]+)\/rpg$/);
  if (rpgMatch) {
    const contentId = decodeURIComponent(rpgMatch[1]);
    const data = await store.read();
    const library = getRequestLibrary(user,data.libraries,contentId.split(':')[0],req);
    if (!library || library.kind !== 'other' || !store.canAccessPdfContent(contentId,user)) { sendJson(res,404,{error:'Material não encontrado.'}); return; }
    let contents = visibleContents(user,await scanLibrary(library));
    if(!contents.some(item=>item.id===contentId))contents=visibleContents(user,await scanLibrary(library,{refresh:true}));
    const content = contents.find(item => item.id === contentId && item.pageTypes.includes('pdf'));
    if (!content) { sendJson(res,404,{error:'PDF não encontrado.'}); return; }
    await handleRpg(req,res,user,library,content,contents);
    return;
  }

  const formMatch = url.pathname.match(/^\/api\/contents\/([^/]+)\/pdf-form(?:\/(copies|save|rename|preview))?$/);
  if (formMatch && (req.method === "GET" || req.method === "POST")) {
    const contentId = decodeURIComponent(formMatch[1]);
    const data = await store.read();
    const library = getRequestLibrary(user, data.libraries, contentId.split(":")[0], req);
    if (!library || !store.canAccessPdfContent(contentId, user)) { sendJson(res, 404, { error: "Conteúdo não encontrado." }); return; }
    const isTemplate = store.rpgDocuments().some(item => item.contentId === contentId && item.role === 'template');
    const canEdit = store.canEditPdfContent(contentId,user);
    const permissions = {canSave:canEdit,canEdit,saveCreatesCopy:isTemplate};
    if (req.method === 'POST' && !canEdit) { sendJson(res,403,{error:'Esta ficha foi compartilhada apenas para leitura.'}); return; }
    if (formMatch[2] === 'rename' && isTemplate) { sendJson(res,403,{error:'O modelo original é preservado. Salve uma cópia pessoal.'}); return; }
    if (!["other", "book", "lightNovel"].includes(library.kind)) {
      sendJson(res, 400, { error: "Preenchimento disponível nas bibliotecas de livros e RPG." }); return;
    }
    const source = await getContentPagePath(library, contentId, 0);
    if (!source) { sendJson(res, 404, { error: "PDF não encontrado." }); return; }
    try {
      const root = await fs.realpath(library.path);
      const realSource = await fs.realpath(source);
      if (!realSource.startsWith(root + path.sep)) { sendJson(res, 403, { error: "Arquivo fora da biblioteca." }); return; }
      if (req.method === "GET" && !formMatch[2]) {
        const revision=await formRevision(realSource), schema=await describeForm(realSource);
        if(revision!==await formRevision(realSource)) throw new FormError('A ficha mudou enquanto era aberta. Tente novamente.');
        sendJson(res, 200, { ...schema, ...permissions, revision }); return;
      }
      if (req.method !== "POST" || !formMatch[2]) { sendJson(res, 405, { error: "Método inválido." }); return; }
      if (req.headers["sec-fetch-site"] === "cross-site") { sendJson(res, 403, { error: "Origem inválida." }); return; }
      const chunks: Buffer[] = [];
      let size = 0;
      for await (const chunk of req) {
        size += Buffer.byteLength(chunk);
        if (size > 256 * 1024) { sendJson(res, 413, { error: "Formulário grande demais." }); return; }
        chunks.push(Buffer.from(chunk));
      }
      const body = JSON.parse(Buffer.concat(chunks).toString()) as { name?: unknown; values?: unknown; styles?: unknown; edits?: unknown; revision?: unknown; originalName?: unknown; moduleId?: unknown };
      if (formMatch[2] === 'preview') {
        const revision = await formRevision(realSource);
        if (revision !== body.revision) throw new FormError('O PDF mudou. Reabra antes de continuar.');
        const preview = await previewPdf(realSource, body.values, body.styles, body.edits);
        if (revision !== await formRevision(realSource)) throw new FormError('O PDF mudou durante a prévia. Reabra antes de continuar.');
        sendJson(res, 200, { ...preview, schema: { ...preview.schema, revision, ...permissions } }); return;
      }
      if(formMatch[2] !== 'copies' && !isTemplate){
        await withFormLock(realSource, async()=>{
          if(await formRevision(realSource)!==body.revision) throw new FormError('A ficha mudou. Reabra antes de salvar ou renomear.');
          let filename=path.relative(root,realSource), id=contentId;
          const target=path.join(path.dirname(realSource),body.name===undefined||body.name===''?path.basename(realSource):fullFormName(body.name));
          const bytes=formMatch[2]==='save'?await fillCopyBytes(realSource,body.values,body.styles,body.edits):null;
          if(target===realSource){
            if(bytes)await updateForm(realSource,bytes,body.revision);
          }else{
            try{await fs.link(realSource,target);}catch(error){if((error as NodeJS.ErrnoException).code==='EEXIST')throw new FormError('Já existe uma ficha com esse nome.');throw error;}
            filename=path.relative(root,target);id=`${library.id}:${Buffer.from(filename).toString('base64url')}`;
            try{
              if(bytes)await updateForm(target,bytes,body.revision);
              if(await formRevision(realSource)!==body.revision)throw new FormError('A ficha mudou. Reabra antes de salvar.');
              store.renamePdfReferences(contentId,id);
            }catch(error){await fs.unlink(target);throw error;}
            try{await fs.unlink(realSource);}catch(error){store.renamePdfReferences(id,contentId);await fs.unlink(target);throw error;}
          }
          store.updatePdfCopyRevision(id,await formRevision(target));
          const contents=await scanLibrary(library,{refresh:true});
          sendJson(res,200,{filename,previousId:contentId,content:contents.find(item=>item.id===id)??null,revision:await formRevision(path.join(root,filename)),...await describeForm(path.join(root,filename))});
        });return;
      }
      const parentCopy = store.pdfFormCopies().find(item => item.contentId === contentId);
      const template = store.rpgDocuments().find(item => item.contentId === contentId && item.role === 'template');
      const links = store.rpgLinks().filter(link => link.templateId === template?.id);
      const moduleId = body.moduleId ?? parentCopy?.moduleId ?? (links.length === 1 ? links[0].moduleId : null);
      if (moduleId && !store.rpgDocuments().some(item => item.id === moduleId && item.role === 'module' && item.contentId.startsWith(library.id + ':') && (parentCopy?.moduleId === moduleId || links.some(link => link.moduleId === moduleId)))) throw new FormError('Módulo inválido para este modelo.');
      const base = body.name===undefined||body.name===''?copyName(source,undefined):fullFormName(body.name).slice(0,-4);
      if (body.revision !== undefined && body.revision !== await formRevision(realSource)) throw new FormError('O PDF mudou. Reabra antes de salvar.');
      const bytes = await fillCopyBytes(realSource, body.values, body.styles, body.edits);
      const destination = library.kind === 'other' ? path.join(root,rpgSheetCopyFolder(path.relative(root,realSource))) : path.dirname(realSource);
      await fs.mkdir(destination,{recursive:true});
      const destinationPath=await fs.realpath(destination);
      if(destinationPath!==root && !destinationPath.startsWith(root+path.sep))throw new FormError('A pasta Fichas deve estar dentro da biblioteca.');
      const publishedName = await publishCopy(destination, base, bytes, name => {
        const relative=path.relative(root,path.join(destination,name));
        const newId=`${library.id}:${Buffer.from(relative).toString('base64url')}`;
        const folder=path.dirname(relative)==='.'?'':path.dirname(relative).split(path.sep).join('/');
        store.registerPdfCopy(newId,parentCopy?.sourceId ?? contentId,crypto.createHash('sha256').update(bytes).digest('hex'),user.id,folder);
        store.setPdfCopyModule(newId,moduleId as string | null);
      });
      const filename = path.relative(root, path.join(destination, publishedName));
      const id = `${library.id}:${Buffer.from(filename).toString("base64url")}`;
      // Force a completed scan (including a scan already running) so the new
      // item is immediately available through normal library navigation.
      let contents = await scanLibrary(library, { refresh: true });
      if (!contents.some(item => item.id === id)) contents = await scanLibrary(library, { refresh: true });
      sendJson(res, 201, { filename, content: visibleContents(user,contents).find(item => item.id === id) ?? null });
    } catch (error) {
      console.error("Falha no formulário PDF", error);
      sendJson(res, 400, { error: error instanceof FormError ? error.message : "Não foi possível salvar a cópia. Verifique o arquivo e a permissão de escrita da biblioteca." });
    }
    return;
  }

  const epubMetricsMatch = url.pathname.match(/^\/api\/contents\/(.+)\/epub-metrics$/);
  if (epubMetricsMatch && req.method === "GET") {
    const contentId = decodeURIComponent(epubMetricsMatch[1]);
    const data = await store.read();
    const library = getRequestLibrary(user, data.libraries, contentId.split(":")[0] ?? "", req);
    if (!library || !store.canAccessPdfContent(contentId, user)) {
      sendJson(res, 404, { error: "Conteúdo não encontrado." });
      return;
    }
    const lengths = await getContentEpubTextLengths(library, contentId);
    if (!lengths) sendJson(res, 404, { error: "EPUB não encontrado." });
    else sendJson(res, 200, { lengths });
    return;
  }

  const epubSearchMatch = url.pathname.match(/^\/api\/contents\/(.+)\/epub-search$/);
  if (epubSearchMatch && req.method === "GET") {
    const contentId = decodeURIComponent(epubSearchMatch[1]);
    const termo = (url.searchParams.get("q") ?? "").trim();
    const data = await store.read();
    const libraryId = contentId.split(":")[0] ?? "";
    const library = getRequestLibrary(user, data.libraries, libraryId, req);
    if (!library || !store.canAccessPdfContent(contentId, user)) {
      sendJson(res, 404, { error: "Conteúdo não encontrado." });
      return;
    }
    const resultado = await searchEpubText(library, contentId, termo);
    sendJson(res, 200, resultado);
    return;
  }

  if (url.pathname.startsWith("/api/contents/") && (req.method === "GET" || req.method === "HEAD")) {
    const epubAssetRequest = parseContentEpubAssetPath(url.pathname);
    if (epubAssetRequest) {
      const data = await store.read();
      const libraryId = epubAssetRequest.contentId.split(":")[0] ?? "";
      const library = getRequestLibrary(user, data.libraries, libraryId, req);
      if (!library || !store.canAccessPdfContent(epubAssetRequest.contentId, user)) {
        sendJson(res, 404, { error: "Conteúdo não encontrado." });
        return;
      }

      const asset = await getContentEpubAsset(library, epubAssetRequest.contentId, epubAssetRequest.assetPath);
      if (!asset) {
        sendJson(res, 404, { error: "Arquivo do EPUB não encontrado." });
        return;
      }

      sendBuffer(req, res, asset.path, asset.data);
      return;
    }

    const coverRequest = parseContentCoverPath(url.pathname);
    if (coverRequest) {
      const data = await store.read();
      const libraryId = coverRequest.contentId.split(":")[0] ?? "";
      const library = getRequestLibrary(user, data.libraries, libraryId, req);
      if (!library || !store.canAccessPdfContent(coverRequest.contentId, user)) {
        sendJson(res, 404, { error: "Conteúdo não encontrado." });
        return;
      }

      const thumbPath = await getContentCoverThumbnail(library, coverRequest.contentId);
      if (thumbPath) {
        await sendFile(req, res, thumbPath, url.searchParams.has("v") ? "private, max-age=31536000, immutable" : "private, no-cache, must-revalidate");
        return;
      }

      const coverPath = await getContentCoverPath(library, coverRequest.contentId);
      if (!coverPath) {
        sendJson(res, 404, { error: "Capa não encontrada." });
        return;
      }

      await sendFile(req, res, coverPath, url.searchParams.has("v") ? "private, max-age=31536000, immutable" : "private, no-cache, must-revalidate");
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
    if (!library || !store.canAccessPdfContent(pageRequest.contentId, user)) {
      sendJson(res, 404, { error: "Conteúdo não encontrado." });
      return;
    }

    const bookTheme = url.searchParams.get("theme") === "dark" ? "dark" : url.searchParams.get("theme") === "sepia" ? "sepia" : "light";
    const readDirection = url.searchParams.get("direction") === "rtl" ? "rtl" : "ltr";
    const epubHtml = await getContentEpubChapterHtml(library, pageRequest.contentId, pageRequest.pageIndex, bookTheme, readDirection);
    if (epubHtml) {
      sendHtml(req, res, epubHtml);
      return;
    }

    const pagePath = await getContentPagePath(library, pageRequest.contentId, pageRequest.pageIndex);
    if (!pagePath) {
      sendJson(res, 404, { error: "Página não encontrada." });
      return;
    }

    // Access checks above run for every request, including cached variants.
    // Range requests always address the original file's byte representation.
    if (!req.headers.range) {
      const variant = await pageImageVariant(pagePath, url.searchParams.get("width")).catch(() => null);
      if (variant) {
        const headers = { "Content-Type": "image/webp", "Cache-Control": "private, max-age=3600", "ETag": variant.etag };
        if (req.headers["if-none-match"] === variant.etag) { res.writeHead(304, headers); res.end(); return; }
        res.writeHead(200, { ...headers, "Content-Length": String(variant.data.length) });
        res.end(req.method === "HEAD" ? undefined : variant.data);
        return;
      }
    }
    await sendFile(req, res, pagePath, path.extname(pagePath).toLowerCase()==='.pdf' ? 'no-cache, private, must-revalidate' : undefined);
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
    const body = await readJson<{ name: string; description?: string }>(req);
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
    const body = await readJson<{ userIds: string[] }>(req);
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
    const body = await readJson<{ name: string; description?: string }>(req);
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
    if (url.searchParams.get("includeContents") === "1") {
      const libraryIds = new Set(bookmarks.map((item) => item.contentId.split(":")[0]));
      const libraries = data.libraries.filter((library) => libraryIds.has(library.id) && getRequestLibrary(user, data.libraries, library.id, req));
      const scanned = (await Promise.all(libraries.map(async (library) => {
        const libraryMarks=bookmarks.filter(item=>item.contentId.startsWith(library.id+':'));
        const missing=await Promise.all(libraryMarks.map(item=>pdfLocationMissing(library,item.contentId)));
        return scanLibrary(library,{refresh:missing.some(Boolean)});
      }))).flat();
      // Scanning can migrate IDs after a file move. Read marks AFTER reconciliation.
      const currentBookmarks = (await store.read()).bookmarks.filter((item) => item.userId === user.id);
      const ids = new Set(currentBookmarks.map((item) => item.contentId));
      const contents = scanned.filter((content) => ids.has(content.id) && store.canAccessPdfContent(content.id, user));
      const accessible = new Set(contents.map((content) => content.id));
      sendJson(res, 200, { bookmarks: currentBookmarks.filter((item) => accessible.has(item.contentId)), contents });
      return;
    }
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
    if (!await findVisibleContent(user, contentId)) {
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
      .filter((item): item is PublicContentReview => Boolean(item))
      .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));

    sendJson(res, 200, { reviews: visibleReviews });
    return;
  }

  if (url.pathname === "/api/progress" && req.method === "PUT") {
    const body = await readJson<{ contentId: string; currentPage: number; epubOffset?: number }>(req);
    const visible = await findRequestContent(user, body.contentId, req);
    if (!visible) {
      sendJson(res, 404, { error: "Conteúdo não encontrado." });
      return;
    }

    await store.upsertProgress({
      userId: user.id,
      contentId: body.contentId,
      currentPage: Math.min(Math.max(Number(body.currentPage), 0), Math.max(visible.pageCount - 1, 0)),
      epubOffset: Number.isFinite(body.epubOffset)
        ? Math.min(Math.max(Number(body.epubOffset), 0), 1) : 0,
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

  if (url.pathname === "/api/bookmarks" && (req.method === "POST" || req.method === "PATCH")) {
    const body = await readJson<{ contentId?: unknown; page?: unknown; name?: unknown }>(req);
    if (!body || typeof body.contentId !== "string" || !body.contentId ||
        typeof body.page !== "number" || !Number.isSafeInteger(body.page) || body.page < 0) {
      sendJson(res, 400, { error: "Informe uma obra e uma página válida." });
      return;
    }
    if (req.method === "PATCH" && (typeof body.name !== "string" || body.name.trim().length > 120)) {
      sendJson(res, 400, { error: "O nome deve ter até 120 caracteres." });
      return;
    }
    if (!await findRequestContent(user, body.contentId, req)) {
      sendJson(res, 404, { error: "Conteúdo não encontrado." });
      return;
    }
    if (req.method === "PATCH") {
      const bookmark = await store.renameBookmark(user.id, body.contentId, body.page, (body.name as string).trim());
      if (!bookmark) { sendJson(res, 404, { error: "Página marcada não encontrada." }); return; }
      sendJson(res, 200, { bookmark });
      return;
    }
    const result = await store.toggleBookmark({
      userId: user.id, contentId: body.contentId, page: body.page,
      createdAt: new Date().toISOString()
    });
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/reviews" && req.method === "POST") {
    const body = await readJson<{ contentId: string; rating: number; comment: string }>(req);
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

    const review: ContentReview = {
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
    const body = await readJson<{ contentId: string }>(req);
    const result = await store.toggleSeriesMark({
      userId: user.id,
      contentId: body.contentId,
      createdAt: new Date().toISOString()
    });
    sendJson(res, 200, result);
    return;
  }

  if (url.pathname === "/api/want-to-read" && req.method === "POST") {
    const body = await readJson<{ contentId: string }>(req);
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
    const body = await readJson<{ contentId: string }>(req);
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
    const body = await readJson<{ contentId: string }>(req);
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
    if (req.url === "/health") {
      sendJson(res, 200, {
        status: "ok",
        uptimeSeconds: Math.round(process.uptime()),
        timestamp: new Date().toISOString()
      });
      return;
    }

    if (req.url?.startsWith("/api/")) {
      await handleApi(req, res);
      return;
    }

    await serveStatic(req, res);
  } catch (error) {
    console.error(error);
    sendJson(res, 500, { error: "Erro interno do Pugotiread." });
  }
});

// Backfill filesystem identities before accepting requests, including pre-existing sheets.
const initialLibraries=(await store.read()).libraries;
for(const item of [...store.rpgDocuments(),...store.pdfFormCopies()]) {
  const library=initialLibraries.find(library=>item.contentId.startsWith(library.id+':'));
  if(library)await reconcilePdfLocation(library,item.contentId);
}

server.listen(config.port, () => {
  if (!config.smtpHost) {
    console.warn("[SMTP] SMTP_HOST nao configurado. Recuperacao de senha vai cair no console.");
  }
  console.log(`Pugotiread rodando em http://localhost:${config.port}`);

  void store.read().then((data) => startLibraryWatchers(data.libraries)).catch((error) => {
    console.error("[MEDIA] Não foi possível iniciar os observadores de bibliotecas:", error);
  });

  if (config.pugotiAutoSyncEnabled) {
    console.log(`[SYNC] Sincronização automática ativa a cada ${Math.round(config.pugotiSyncIntervalMs / 60000)} minutos.`);
    const initialTimer = setTimeout(() => {
      void runAutomaticSyncCycle();
    }, 60 * 1000);
    initialTimer.unref();

    const interval = setInterval(() => {
      void runAutomaticSyncCycle();
    }, config.pugotiSyncIntervalMs);
    interval.unref();
  } else {
    console.log("[SYNC] Sincronização automática desativada.");
  }
});
