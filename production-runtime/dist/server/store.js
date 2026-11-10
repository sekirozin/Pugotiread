import Database from "better-sqlite3";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import { config } from "./config.js";
const libraryKinds = ["manga", "manhwa", "book", "comic", "lightNovel", "other"];
const readerModes = ["horizontal", "paged-vertical", "vertical-scroll"];
const readerFittingModes = ["height", "width", "original"];
const readerDirections = ["ltr", "rtl"];
export const defaultReadingDefaults = {
    manga: { mode: "horizontal", fitting: "height", direction: "ltr", controlsVisible: false },
    manhwa: { mode: "vertical-scroll", fitting: "width", direction: "ltr", controlsVisible: false },
    book: { mode: "horizontal", fitting: "height", direction: "ltr", controlsVisible: true },
    comic: { mode: "horizontal", fitting: "height", direction: "ltr", controlsVisible: false },
    lightNovel: { mode: "horizontal", fitting: "height", direction: "ltr", controlsVisible: true },
    other: { mode: "vertical-scroll", fitting: "height", direction: "ltr", controlsVisible: false }
};
export const defaultServerSettings = {
    vaultTimeoutMinutes: 5,
    readingDefaults: defaultReadingDefaults
};
function makeInitialStore() {
    return {
        settings: defaultServerSettings,
        users: [],
        libraries: [],
        progress: [],
        bookmarks: [],
        seriesMarks: [],
        wantToRead: [],
        readingList: [],
        collections: [],
        reviews: [],
        invitations: [],
        passwordResetTokens: []
    };
}
function isImportedPasswordHashValid(passwordHash) {
    const parts = passwordHash.split("$");
    return parts[0] === "pbkdf2" && parts.length === 4 && Number.isFinite(Number(parts[1])) && Boolean(parts[2]) && Boolean(parts[3]);
}
export function normalizeVaultTimeoutMinutes(value) {
    const minutes = Number(value);
    if (!Number.isInteger(minutes) || minutes < 1) {
        return defaultServerSettings.vaultTimeoutMinutes;
    }
    return minutes;
}
export function normalizeReadingDefaults(value) {
    const raw = value && typeof value === "object" ? value : {};
    return Object.fromEntries(libraryKinds.map((kind) => {
        const item = raw[kind];
        const mode = item && readerModes.includes(item.mode) ? item.mode : defaultReadingDefaults[kind].mode;
        const fitting = item && readerFittingModes.includes(item.fitting) ? item.fitting : defaultReadingDefaults[kind].fitting;
        const direction = item && readerDirections.includes(item.direction) ? item.direction : defaultReadingDefaults[kind].direction;
        const controlsVisible = typeof item?.controlsVisible === "boolean" ? item.controlsVisible : defaultReadingDefaults[kind].controlsVisible;
        return [kind, { mode, fitting, direction, controlsVisible }];
    }));
}
function parseSettingJson(value) {
    if (!value) {
        return null;
    }
    try {
        return JSON.parse(value);
    }
    catch {
        return null;
    }
}
export class Store {
    db;
    pdfLocations() {
        return this.db.prepare('SELECT contentId,fileKey FROM pdf_locations').all();
    }
    pdfLocation(contentId) {
        return this.db.prepare('SELECT contentId,fileKey FROM pdf_locations WHERE contentId=?').get(contentId);
    }
    pdfLocationsByFileKey(fileKey) {
        return this.db.prepare('SELECT contentId,fileKey FROM pdf_locations WHERE fileKey=?').all(fileKey);
    }
    rememberPdfLocation(contentId, fileKey) {
        this.db.prepare('INSERT INTO pdf_locations(contentId,fileKey) VALUES(?,?) ON CONFLICT(contentId) DO UPDATE SET fileKey=excluded.fileKey WHERE pdf_locations.fileKey<>excluded.fileKey').run(contentId, fileKey);
    }
    rpgDocuments() {
        return this.db.prepare('SELECT id,contentId,role FROM rpg_documents').all();
    }
    rpgLinks() {
        return this.db.prepare('SELECT moduleId,templateId FROM rpg_templates').all();
    }
    setRpgDocument(contentId, role, templateIds) {
        this.db.transaction(() => {
            const old = this.rpgDocuments().find(item => item.contentId === contentId);
            // Keep the stable identifier, even when a document changes its role.
            if (!role) {
                if (old && this.pdfFormCopies().some(copy => copy.moduleId === old.id))
                    throw new Error('Este módulo possui fichas vinculadas. Reassocie as fichas antes de removê-lo.');
                this.db.prepare('DELETE FROM rpg_documents WHERE contentId=?').run(contentId);
                return;
            }
            const id = old?.id ?? crypto.randomUUID();
            if (old?.role === 'module' && role !== old.role && this.pdfFormCopies().some(copy => copy.moduleId === old.id))
                throw new Error('Este módulo possui fichas vinculadas.');
            this.db.prepare('INSERT INTO rpg_documents(id,contentId,role) VALUES(?,?,?) ON CONFLICT(contentId) DO UPDATE SET role=excluded.role').run(id, contentId, role);
            if (old && old.role !== role)
                this.db.prepare('DELETE FROM rpg_templates WHERE moduleId=? OR templateId=?').run(id, id);
            if (role === 'module') {
                this.db.prepare('DELETE FROM rpg_templates WHERE moduleId=?').run(id);
                for (const templateId of new Set(templateIds))
                    this.db.prepare('INSERT INTO rpg_templates(moduleId,templateId) VALUES(?,?)').run(id, templateId);
            }
        })();
    }
    setPdfCopyModule(contentId, moduleId) {
        this.db.prepare('UPDATE pdf_form_copies SET moduleId=? WHERE contentId=?').run(moduleId, contentId);
    }
    canEditPdfContent(contentId, user) {
        const copy = this.pdfFormCopies().find(item => item.contentId === contentId);
        return !copy || user.role === 'admin' || copy.ownerUserId === user.id;
    }
    isPdfCopy(contentId, revision) {
        const row = this.db.prepare("SELECT revision FROM pdf_form_copies WHERE contentId = ?").get(contentId);
        return !!row && (revision === undefined || row.revision === revision);
    }
    registerPdfCopy(contentId, sourceId, revision, ownerUserId, system = "") {
        this.db.prepare(`INSERT INTO pdf_form_copies
      (contentId,sourceId,revision,ownerUserId,authorUserId,visibility,sharedWithUserIds,system)
      VALUES (?, ?, ?, ?, ?, 'private', '[]', ?)
      ON CONFLICT(contentId) DO UPDATE SET revision=excluded.revision`)
            .run(contentId, sourceId, revision, ownerUserId, ownerUserId, system);
    }
    updatePdfCopyRevision(contentId, revision) {
        this.db.prepare('UPDATE pdf_form_copies SET revision=? WHERE contentId=?').run(revision, contentId);
    }
    canAccessPdfContent(contentId, user) {
        const row = this.db.prepare('SELECT ownerUserId,visibility,sharedWithUserIds FROM pdf_form_copies WHERE contentId=?').get(contentId);
        if (!row)
            return true;
        if (user.role === 'admin' || row.ownerUserId === user.id || row.visibility === 'public')
            return true;
        if (row.visibility !== 'shared')
            return false;
        try {
            return JSON.parse(row.sharedWithUserIds || '[]').includes(user.id);
        }
        catch {
            return false;
        }
    }
    pdfFormCopies() {
        return this.db.prepare(`SELECT p.contentId,p.sourceId,p.moduleId,p.ownerUserId,COALESCE(u.displayName,'Usuário removido') ownerDisplayName,p.authorUserId,CASE WHEN p.authorUserId='' THEN NULL ELSE COALESCE(a.displayName,'Usuário removido') END authorDisplayName,p.visibility,p.sharedWithUserIds,p.system FROM pdf_form_copies p LEFT JOIN users u ON u.id=p.ownerUserId LEFT JOIN users a ON a.id=p.authorUserId ORDER BY p.contentId`).all().map(row => ({ ...row, sharedWithUserIds: JSON.parse(row.sharedWithUserIds || '[]') }));
    }
    updatePdfFormCopy(contentId, input) {
        if (!['private', 'shared', 'public'].includes(input.visibility))
            throw new Error('Visibilidade inválida.');
        if (!this.db.prepare('SELECT 1 FROM users WHERE id=?').get(input.ownerUserId))
            throw new Error('Proprietário inválido.');
        const shared = [...new Set(input.sharedWithUserIds)].filter(id => this.db.prepare('SELECT 1 FROM users WHERE id=?').get(id));
        this.db.prepare('UPDATE pdf_form_copies SET ownerUserId=?,visibility=?,sharedWithUserIds=?,system=? WHERE contentId=?').run(input.ownerUserId, input.visibility, JSON.stringify(shared), input.system.trim().slice(0, 80), contentId);
        return this.pdfFormCopies().find(item => item.contentId === contentId) ?? null;
    }
    renamePdfReferences(oldId, newId) {
        if (oldId === newId)
            return;
        this.db.transaction(() => {
            const folder = (id) => {
                const relative = Buffer.from(id.slice(id.indexOf(':') + 1), 'base64url').toString('utf8');
                const parent = path.dirname(relative);
                return parent === '.' ? '' : parent.split(path.sep).join('/');
            };
            this.db.prepare("UPDATE pdf_form_copies SET system=? WHERE contentId=? AND (system=? OR system='')").run(folder(newId), oldId, folder(oldId));
            for (const table of ['progress', 'bookmarks', 'series_marks', 'user_want_to_read', 'user_reading_list', 'reviews', 'sync_runs', 'pdf_form_copies']) {
                this.db.prepare(`UPDATE ${table} SET contentId = ? WHERE contentId = ?`).run(newId, oldId);
            }
            this.db.prepare('UPDATE pdf_form_copies SET sourceId = ? WHERE sourceId = ?').run(newId, oldId);
            this.db.prepare('UPDATE rpg_documents SET contentId=? WHERE contentId=?').run(newId, oldId);
            this.db.prepare('UPDATE pdf_locations SET contentId=? WHERE contentId=?').run(newId, oldId);
            const users = this.db.prepare('SELECT id,favoriteContentIds FROM users').all();
            for (const user of users) {
                const ids = JSON.parse(user.favoriteContentIds);
                if (ids.includes(oldId))
                    this.db.prepare('UPDATE users SET favoriteContentIds=? WHERE id=?').run(JSON.stringify(ids.map(id => id === oldId ? newId : id)), user.id);
            }
            const rows = this.db.prepare('SELECT id, contentIds FROM collections').all();
            for (const row of rows) {
                const ids = JSON.parse(row.contentIds);
                if (ids.includes(oldId))
                    this.db.prepare('UPDATE collections SET contentIds = ? WHERE id = ?').run(JSON.stringify(ids.map(id => id === oldId ? newId : id)), row.id);
            }
        })();
    }
    constructor() {
        const dbDir = path.dirname(config.dbFile);
        fs.mkdirSync(dbDir, { recursive: true });
        this.db = new Database(config.dbFile);
        this.db.pragma("journal_mode = WAL");
        this.db.pragma("foreign_keys = ON");
        this.ensureTables();
        this.ensureCompatibility();
        this.db.prepare(`
      UPDATE sync_runs
      SET state = 'error',
          message = 'Sincronização interrompida pela reinicialização do servidor.',
          finishedAt = ?
      WHERE state = 'running'
    `).run(new Date().toISOString());
        if (!this.tryMigrateFromJson()) {
            this.seedIfEmpty();
        }
    }
    ensureTables() {
        this.db.exec("CREATE TABLE IF NOT EXISTS pdf_form_copies (contentId TEXT PRIMARY KEY, sourceId TEXT NOT NULL)");
        if (!this.db.prepare('PRAGMA table_info(pdf_form_copies)').all().some(column => column.name === 'revision'))
            this.db.exec("ALTER TABLE pdf_form_copies ADD COLUMN revision TEXT NOT NULL DEFAULT ''");
        const pdfColumns = this.db.prepare('PRAGMA table_info(pdf_form_copies)').all();
        if (!pdfColumns.some(column => column.name === 'ownerUserId'))
            this.db.exec("ALTER TABLE pdf_form_copies ADD COLUMN ownerUserId TEXT NOT NULL DEFAULT ''");
        if (!pdfColumns.some(column => column.name === 'visibility'))
            this.db.exec("ALTER TABLE pdf_form_copies ADD COLUMN visibility TEXT NOT NULL DEFAULT 'public'");
        if (!pdfColumns.some(column => column.name === 'sharedWithUserIds'))
            this.db.exec("ALTER TABLE pdf_form_copies ADD COLUMN sharedWithUserIds TEXT NOT NULL DEFAULT '[]'");
        if (!pdfColumns.some(column => column.name === 'system'))
            this.db.exec("ALTER TABLE pdf_form_copies ADD COLUMN system TEXT NOT NULL DEFAULT ''");
        if (!pdfColumns.some(column => column.name === 'moduleId'))
            this.db.exec("ALTER TABLE pdf_form_copies ADD COLUMN moduleId TEXT");
        if (!pdfColumns.some(column => column.name === 'authorUserId')) {
            this.db.exec("ALTER TABLE pdf_form_copies ADD COLUMN authorUserId TEXT NOT NULL DEFAULT ''");
            // Fichas anteriores não registraram quem as criou: o dono atual é a melhor informação disponível.
            this.db.exec("UPDATE pdf_form_copies SET authorUserId=ownerUserId");
        }
        this.db.exec(`CREATE TABLE IF NOT EXISTS rpg_documents (
      id TEXT PRIMARY KEY, contentId TEXT UNIQUE NOT NULL, role TEXT NOT NULL CHECK(role IN ('module','template'))
    );
    CREATE TABLE IF NOT EXISTS rpg_templates (
      moduleId TEXT NOT NULL REFERENCES rpg_documents(id) ON DELETE CASCADE,
      templateId TEXT NOT NULL REFERENCES rpg_documents(id) ON DELETE CASCADE,
      PRIMARY KEY(moduleId,templateId)
    );`);
        this.db.exec('CREATE TABLE IF NOT EXISTS pdf_locations(contentId TEXT PRIMARY KEY,fileKey TEXT NOT NULL)');
        this.db.exec('CREATE INDEX IF NOT EXISTS pdf_locations_file_key ON pdf_locations(fileKey)');
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS settings (
        key TEXT PRIMARY KEY,
        value TEXT NOT NULL
      );

      CREATE TABLE IF NOT EXISTS users (
        id TEXT PRIMARY KEY,
        username TEXT NOT NULL,
        displayName TEXT NOT NULL,
        email TEXT NOT NULL,
        avatarUrl TEXT NOT NULL DEFAULT '',
        googleSub TEXT,
        nickname TEXT NOT NULL DEFAULT '',
        biography TEXT NOT NULL DEFAULT '',
        location TEXT NOT NULL DEFAULT '',
        favoriteContentIds TEXT NOT NULL DEFAULT '[]',
        canLogin INTEGER NOT NULL DEFAULT 1,
        canDownload INTEGER NOT NULL DEFAULT 1,
        canChangePassword INTEGER NOT NULL DEFAULT 1,
        passwordChangeRequiresEmailConfirmation INTEGER NOT NULL DEFAULT 1,
        lastActiveAt TEXT,
        role TEXT NOT NULL DEFAULT 'user',
        passwordHash TEXT NOT NULL,
        allowedLibraryIds TEXT NOT NULL DEFAULT '[]'
      );

      CREATE TABLE IF NOT EXISTS libraries (
        id TEXT PRIMARY KEY,
        name TEXT NOT NULL,
        kind TEXT NOT NULL,
        path TEXT NOT NULL,
        isPersonal INTEGER NOT NULL DEFAULT 0,
        ownerUserId TEXT,
        lastScannedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS progress (
        userId TEXT NOT NULL,
        contentId TEXT NOT NULL,
        currentPage INTEGER NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (userId, contentId)
      );

      CREATE TABLE IF NOT EXISTS bookmarks (
        userId TEXT NOT NULL,
        contentId TEXT NOT NULL,
        page INTEGER NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (userId, contentId, page)
      );

      CREATE TABLE IF NOT EXISTS series_marks (
        userId TEXT NOT NULL,
        contentId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (userId, contentId)
      );

      CREATE TABLE IF NOT EXISTS user_want_to_read (
        userId TEXT NOT NULL,
        contentId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (userId, contentId)
      );

      CREATE TABLE IF NOT EXISTS user_reading_list (
        userId TEXT NOT NULL,
        contentId TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        PRIMARY KEY (userId, contentId)
      );

      CREATE TABLE IF NOT EXISTS collections (
        id TEXT NOT NULL,
        userId TEXT NOT NULL,
        name TEXT NOT NULL,
        description TEXT NOT NULL DEFAULT '',
        sharedWithUserIds TEXT NOT NULL DEFAULT '[]',
        contentIds TEXT NOT NULL DEFAULT '[]',
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (id, userId)
      );

      CREATE TABLE IF NOT EXISTS reviews (
        userId TEXT NOT NULL,
        contentId TEXT NOT NULL,
        rating REAL NOT NULL,
        comment TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        updatedAt TEXT NOT NULL,
        PRIMARY KEY (userId, contentId)
      );

      CREATE TABLE IF NOT EXISTS invitations (
        token TEXT PRIMARY KEY,
        email TEXT NOT NULL,
        displayName TEXT NOT NULL,
        username TEXT NOT NULL,
        role TEXT NOT NULL DEFAULT 'user',
        allowedLibraryIds TEXT NOT NULL DEFAULT '[]',
        canLogin INTEGER NOT NULL DEFAULT 1,
        canDownload INTEGER NOT NULL DEFAULT 1,
        canChangePassword INTEGER NOT NULL DEFAULT 1,
        createdAt TEXT NOT NULL,
        usedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        email TEXT NOT NULL,
        purpose TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        usedAt TEXT
      );

      CREATE TABLE IF NOT EXISTS sync_runs (
        id TEXT PRIMARY KEY,
        source TEXT NOT NULL,
        state TEXT NOT NULL,
        target TEXT NOT NULL,
        libraryId TEXT,
        contentId TEXT,
        message TEXT NOT NULL,
        output TEXT NOT NULL DEFAULT '',
        startedAt TEXT NOT NULL,
        finishedAt TEXT
      );

      CREATE INDEX IF NOT EXISTS idx_sync_runs_started_at
        ON sync_runs(startedAt DESC);
    `);
    }
    ensureColumn(table, column, definition) {
        const columns = this.db.prepare(`PRAGMA table_info(${table})`).all();
        if (!columns.some((item) => item.name === column)) {
            this.db.prepare(`ALTER TABLE ${table} ADD COLUMN ${definition}`).run();
        }
    }
    ensureCompatibility() {
        this.ensureColumn("progress", "epubOffset", "epubOffset REAL NOT NULL DEFAULT 0");
        this.ensureColumn("bookmarks", "name", "name TEXT NOT NULL DEFAULT ''");
        this.ensureColumn("users", "passwordChangeRequiresEmailConfirmation", "passwordChangeRequiresEmailConfirmation INTEGER NOT NULL DEFAULT 1");
        this.db.exec(`
      CREATE TABLE IF NOT EXISTS password_reset_tokens (
        token TEXT PRIMARY KEY,
        userId TEXT NOT NULL,
        email TEXT NOT NULL,
        purpose TEXT NOT NULL,
        createdAt TEXT NOT NULL,
        expiresAt TEXT NOT NULL,
        usedAt TEXT
      );
    `);
    }
    tryMigrateFromJson() {
        const jsonPath = config.dataFile;
        if (!fs.existsSync(jsonPath)) {
            return false;
        }
        const row = this.db.prepare("SELECT COUNT(*) as c FROM users").get();
        if (row.c > 0) {
            return false;
        }
        try {
            const raw = fs.readFileSync(jsonPath, "utf8");
            const data = JSON.parse(raw);
            if (!data.users?.length) {
                return false;
            }
            data.users = data.users.filter((user) => isImportedPasswordHashValid(user.passwordHash));
            this.writeAllSync(data);
            console.log("Migrated data from store.json to SQLite");
            return true;
        }
        catch (err) {
            console.error("Failed to migrate from store.json:", err);
            return false;
        }
    }
    seedIfEmpty() {
        const row = this.db.prepare("SELECT COUNT(*) as c FROM users").get();
        if (row.c === 0) {
            this.writeAllSync(makeInitialStore());
        }
    }
    usersToRows(u) {
        return [
            u.id, u.username, u.displayName, u.email, u.avatarUrl,
            u.googleSub ?? null, u.nickname, u.biography, u.location,
            JSON.stringify(u.favoriteContentIds),
            u.canLogin ? 1 : 0, u.canDownload ? 1 : 0, u.canChangePassword ? 1 : 0,
            u.passwordChangeRequiresEmailConfirmation ? 1 : 0, u.lastActiveAt, u.role, u.passwordHash,
            JSON.stringify(u.allowedLibraryIds)
        ];
    }
    rowToUser(row) {
        return {
            id: row.id,
            username: row.username,
            displayName: row.displayName,
            email: row.email,
            avatarUrl: row.avatarUrl,
            googleSub: row.googleSub ?? undefined,
            nickname: row.nickname,
            biography: row.biography,
            location: row.location,
            favoriteContentIds: JSON.parse(row.favoriteContentIds || "[]"),
            canLogin: Boolean(row.canLogin),
            canDownload: Boolean(row.canDownload),
            canChangePassword: Boolean(row.canChangePassword),
            passwordChangeRequiresEmailConfirmation: Boolean(row.passwordChangeRequiresEmailConfirmation ?? true),
            lastActiveAt: row.lastActiveAt ?? null,
            role: row.role,
            passwordHash: row.passwordHash,
            allowedLibraryIds: JSON.parse(row.allowedLibraryIds || "[]")
        };
    }
    writeAllSync(data) {
        this.db.transaction(() => {
            this.db.exec(`
        DELETE FROM settings; DELETE FROM users; DELETE FROM libraries;
        DELETE FROM progress; DELETE FROM bookmarks; DELETE FROM series_marks;
        DELETE FROM user_want_to_read; DELETE FROM user_reading_list;
        DELETE FROM collections; DELETE FROM reviews; DELETE FROM invitations;
        DELETE FROM password_reset_tokens
      `);
            const settings = {
                vaultTimeoutMinutes: normalizeVaultTimeoutMinutes(data.settings?.vaultTimeoutMinutes),
                startupLibraries: data.settings?.startupLibraries ?? {},
                readingDefaults: normalizeReadingDefaults(data.settings?.readingDefaults)
            };
            this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
                .run("vaultTimeoutMinutes", String(settings.vaultTimeoutMinutes));
            this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)")
                .run("readingDefaults", JSON.stringify(settings.readingDefaults));
            this.db.prepare("INSERT INTO settings (key, value) VALUES (?, ?)").run("startupLibraries", JSON.stringify(settings.startupLibraries));
            const insUser = this.db.prepare(`
        INSERT INTO users (id, username, displayName, email, avatarUrl, googleSub, nickname, biography, location, favoriteContentIds, canLogin, canDownload, canChangePassword, passwordChangeRequiresEmailConfirmation, lastActiveAt, role, passwordHash, allowedLibraryIds)
        VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
      `);
            for (const u of data.users)
                insUser.run(...this.usersToRows(u));
            const insLib = this.db.prepare("INSERT INTO libraries (id, name, kind, path, isPersonal, ownerUserId, lastScannedAt) VALUES (?, ?, ?, ?, ?, ?, ?)");
            for (const l of data.libraries) {
                insLib.run(l.id, l.name, l.kind, l.path, l.isPersonal ? 1 : 0, l.ownerUserId ?? null, l.lastScannedAt ?? null);
            }
            const insProg = this.db.prepare("INSERT INTO progress (userId, contentId, currentPage, updatedAt, epubOffset) VALUES (?, ?, ?, ?, ?)");
            for (const p of data.progress)
                insProg.run(p.userId, p.contentId, p.currentPage, p.updatedAt, p.epubOffset ?? 0);
            const insBm = this.db.prepare("INSERT INTO bookmarks (userId, contentId, page, createdAt, name) VALUES (?, ?, ?, ?, ?)");
            for (const b of data.bookmarks)
                insBm.run(b.userId, b.contentId, b.page, b.createdAt, b.name ?? "");
            const insSm = this.db.prepare("INSERT INTO series_marks (userId, contentId, createdAt) VALUES (?, ?, ?)");
            for (const s of data.seriesMarks)
                insSm.run(s.userId, s.contentId, s.createdAt);
            const insWtr = this.db.prepare("INSERT INTO user_want_to_read (userId, contentId, createdAt) VALUES (?, ?, ?)");
            for (const w of data.wantToRead)
                insWtr.run(w.userId, w.contentId, w.createdAt);
            const insRl = this.db.prepare("INSERT INTO user_reading_list (userId, contentId, createdAt) VALUES (?, ?, ?)");
            for (const r of data.readingList)
                insRl.run(r.userId, r.contentId, r.createdAt);
            const insCol = this.db.prepare("INSERT INTO collections (id, userId, name, description, sharedWithUserIds, contentIds, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?)");
            for (const c of data.collections) {
                insCol.run(c.id, c.userId, c.name, c.description, JSON.stringify(c.sharedWithUserIds), JSON.stringify(c.contentIds), c.createdAt, c.updatedAt);
            }
            const insRev = this.db.prepare("INSERT INTO reviews (userId, contentId, rating, comment, createdAt, updatedAt) VALUES (?, ?, ?, ?, ?, ?)");
            for (const r of data.reviews)
                insRev.run(r.userId, r.contentId, r.rating, r.comment, r.createdAt, r.updatedAt);
            const insInv = this.db.prepare("INSERT INTO invitations (token, email, displayName, username, role, allowedLibraryIds, canLogin, canDownload, canChangePassword, createdAt, usedAt) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)");
            for (const i of data.invitations) {
                insInv.run(i.token, i.email, i.displayName, i.username, i.role, JSON.stringify(i.allowedLibraryIds), i.canLogin ? 1 : 0, i.canDownload ? 1 : 0, i.canChangePassword ? 1 : 0, i.createdAt, i.usedAt);
            }
            const insReset = this.db.prepare("INSERT INTO password_reset_tokens (token, userId, email, purpose, createdAt, expiresAt, usedAt) VALUES (?, ?, ?, ?, ?, ?, ?)");
            for (const token of data.passwordResetTokens ?? []) {
                insReset.run(token.token, token.userId, token.email, token.purpose, token.createdAt, token.expiresAt, token.usedAt);
            }
        })();
    }
    async read() {
        const stmt = this.db.prepare("SELECT value FROM settings WHERE key = ?");
        const settingsRow = stmt.get("vaultTimeoutMinutes");
        const startupLibrariesRow = stmt.get("startupLibraries");
        const readingDefaultsRow = stmt.get("readingDefaults");
        const users = this.db.prepare("SELECT * FROM users").all().map(r => this.rowToUser(r));
        const libraries = this.db.prepare("SELECT * FROM libraries").all();
        const progress = this.db.prepare("SELECT * FROM progress").all();
        const bookmarks = this.db.prepare("SELECT * FROM bookmarks").all();
        const seriesMarks = this.db.prepare("SELECT * FROM series_marks").all();
        const wantToRead = this.db.prepare("SELECT * FROM user_want_to_read").all();
        const readingList = this.db.prepare("SELECT * FROM user_reading_list").all();
        const reviews = this.db.prepare("SELECT * FROM reviews").all();
        const invitations = this.db.prepare("SELECT * FROM invitations").all();
        const passwordResetTokens = this.db.prepare("SELECT * FROM password_reset_tokens").all();
        const collections = this.db.prepare("SELECT * FROM collections").all().map(r => {
            const row = r;
            return {
                id: row.id,
                userId: row.userId,
                name: row.name,
                description: row.description,
                sharedWithUserIds: JSON.parse(row.sharedWithUserIds || "[]"),
                contentIds: JSON.parse(row.contentIds || "[]"),
                createdAt: row.createdAt,
                updatedAt: row.updatedAt
            };
        });
        return {
            settings: {
                startupLibraries: (parseSettingJson(startupLibrariesRow?.value) ?? {}),
                vaultTimeoutMinutes: settingsRow ? Number(settingsRow.value) : defaultServerSettings.vaultTimeoutMinutes,
                readingDefaults: normalizeReadingDefaults(parseSettingJson(readingDefaultsRow?.value) ?? defaultServerSettings.readingDefaults)
            },
            users, libraries, progress, bookmarks, seriesMarks,
            wantToRead, readingList, collections, reviews, invitations, passwordResetTokens
        };
    }
    async write(data) {
        this.writeAllSync(data);
    }
    async upsertProgress(progress) {
        this.db.prepare(`
      INSERT INTO progress (userId, contentId, currentPage, updatedAt, epubOffset)
      VALUES (?, ?, ?, ?, ?)
      ON CONFLICT(userId, contentId) DO UPDATE SET
        currentPage = excluded.currentPage,
        updatedAt = excluded.updatedAt,
        epubOffset = excluded.epubOffset
    `).run(progress.userId, progress.contentId, progress.currentPage, progress.updatedAt, progress.epubOffset ?? 0);
    }
    async removeProgress(userId, contentId) {
        this.db.prepare("DELETE FROM progress WHERE userId = ? AND contentId = ?").run(userId, contentId);
    }
    async updateUserProfile(userId, updates) {
        this.db.prepare(`
      UPDATE users SET avatarUrl = ?, nickname = ?, biography = ?, location = ?, favoriteContentIds = ?
      WHERE id = ?
    `).run(updates.avatarUrl, updates.nickname, updates.biography, updates.location, JSON.stringify(updates.favoriteContentIds), userId);
        const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
        return row ? this.rowToUser(row) : null;
    }
    usuarioPorId(userId) {
        const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
        return row ? this.rowToUser(row) : null;
    }
    async createUser(user) {
        this.db.prepare(`
      INSERT INTO users (id, username, displayName, email, avatarUrl, googleSub, nickname, biography, location, favoriteContentIds, canLogin, canDownload, canChangePassword, passwordChangeRequiresEmailConfirmation, lastActiveAt, role, passwordHash, allowedLibraryIds)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(...this.usersToRows(user));
        return user;
    }
    async updateSettings(updates) {
        const current = await this.read();
        const vaultTimeoutMinutes = normalizeVaultTimeoutMinutes(updates.vaultTimeoutMinutes ?? current.settings.vaultTimeoutMinutes);
        const readingDefaults = normalizeReadingDefaults(updates.readingDefaults ?? current.settings.readingDefaults);
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('vaultTimeoutMinutes', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(String(vaultTimeoutMinutes));
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('readingDefaults', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value")
            .run(JSON.stringify(readingDefaults));
        const startupLibraries = { ...current.settings.startupLibraries, ...updates.startupLibraries };
        this.db.prepare("INSERT INTO settings (key, value) VALUES ('startupLibraries', ?) ON CONFLICT(key) DO UPDATE SET value = excluded.value").run(JSON.stringify(startupLibraries));
        return { vaultTimeoutMinutes, readingDefaults, startupLibraries };
    }
    async updateUser(userId, updates) {
        const fields = [];
        const values = [];
        for (const [key, value] of Object.entries(updates)) {
            if (key === "favoriteContentIds" || key === "allowedLibraryIds") {
                fields.push(`${key} = ?`);
                values.push(JSON.stringify(value));
            }
            else if (key === "canLogin" || key === "canDownload" || key === "canChangePassword") {
                fields.push(`${key} = ?`);
                values.push(value ? 1 : 0);
            }
            else if (key === "googleSub") {
                fields.push("googleSub = ?");
                values.push(value ?? null);
            }
            else {
                fields.push(`${key} = ?`);
                values.push(value);
            }
        }
        if (fields.length === 0) {
            const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
            return row ? this.rowToUser(row) : null;
        }
        values.push(userId);
        this.db.prepare(`UPDATE users SET ${fields.join(", ")} WHERE id = ?`).run(...values);
        const row = this.db.prepare("SELECT * FROM users WHERE id = ?").get(userId);
        return row ? this.rowToUser(row) : null;
    }
    async deleteUser(userId) {
        const row = this.db.prepare("SELECT id FROM users WHERE id = ?").get(userId);
        if (!row)
            return false;
        this.db.transaction(() => {
            this.db.prepare("DELETE FROM progress WHERE userId = ?").run(userId);
            this.db.prepare("DELETE FROM bookmarks WHERE userId = ?").run(userId);
            this.db.prepare("DELETE FROM series_marks WHERE userId = ?").run(userId);
            this.db.prepare("DELETE FROM user_want_to_read WHERE userId = ?").run(userId);
            this.db.prepare("DELETE FROM user_reading_list WHERE userId = ?").run(userId);
            this.db.prepare("DELETE FROM collections WHERE userId = ?").run(userId);
            this.db.prepare("DELETE FROM reviews WHERE userId = ?").run(userId);
            this.db.prepare("DELETE FROM users WHERE id = ?").run(userId);
        })();
        return true;
    }
    async createInvitation(invitation) {
        this.db.prepare(`
      INSERT INTO invitations (token, email, displayName, username, role, allowedLibraryIds, canLogin, canDownload, canChangePassword, createdAt, usedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(invitation.token, invitation.email, invitation.displayName, invitation.username, invitation.role, JSON.stringify(invitation.allowedLibraryIds), invitation.canLogin ? 1 : 0, invitation.canDownload ? 1 : 0, invitation.canChangePassword ? 1 : 0, invitation.createdAt, invitation.usedAt);
        return invitation;
    }
    async getInvitation(token) {
        const row = this.db.prepare("SELECT * FROM invitations WHERE token = ? AND usedAt IS NULL").get(token);
        if (!row)
            return null;
        return {
            token: row.token,
            email: row.email,
            displayName: row.displayName,
            username: row.username,
            role: row.role,
            allowedLibraryIds: JSON.parse(row.allowedLibraryIds || "[]"),
            canLogin: Boolean(row.canLogin),
            canDownload: Boolean(row.canDownload),
            canChangePassword: Boolean(row.canChangePassword),
            createdAt: row.createdAt,
            usedAt: row.usedAt ?? null
        };
    }
    async consumeInvitation(token) {
        const row = this.db.prepare("SELECT * FROM invitations WHERE token = ? AND usedAt IS NULL").get(token);
        if (!row)
            return null;
        const now = new Date().toISOString();
        this.db.prepare("UPDATE invitations SET usedAt = ? WHERE token = ?").run(now, token);
        return {
            token: row.token,
            email: row.email,
            displayName: row.displayName,
            username: row.username,
            role: row.role,
            allowedLibraryIds: JSON.parse(row.allowedLibraryIds || "[]"),
            canLogin: Boolean(row.canLogin),
            canDownload: Boolean(row.canDownload),
            canChangePassword: Boolean(row.canChangePassword),
            createdAt: row.createdAt,
            usedAt: now
        };
    }
    async createPasswordResetToken(token) {
        this.db.prepare(`
      INSERT INTO password_reset_tokens (token, userId, email, purpose, createdAt, expiresAt, usedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?)
    `).run(token.token, token.userId, token.email, token.purpose, token.createdAt, token.expiresAt, token.usedAt);
        return token;
    }
    async getPasswordResetToken(tokenValue) {
        const tokenHash = crypto.createHash("sha256").update(tokenValue).digest("hex");
        const row = this.db.prepare("SELECT * FROM password_reset_tokens WHERE token = ?").get(tokenHash);
        if (!row)
            return null;
        return {
            token: row.token,
            userId: row.userId,
            email: row.email,
            purpose: row.purpose,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            usedAt: row.usedAt ?? null
        };
    }
    async consumePasswordResetToken(tokenValue) {
        const tokenHash = crypto.createHash("sha256").update(tokenValue).digest("hex");
        const row = this.db.prepare("SELECT * FROM password_reset_tokens WHERE token = ? AND usedAt IS NULL").get(tokenHash);
        if (!row)
            return null;
        const now = new Date().toISOString();
        this.db.prepare("UPDATE password_reset_tokens SET usedAt = ? WHERE token = ?").run(now, tokenHash);
        return {
            token: row.token,
            userId: row.userId,
            email: row.email,
            purpose: row.purpose,
            createdAt: row.createdAt,
            expiresAt: row.expiresAt,
            usedAt: now
        };
    }
    async createLibrary(library) {
        this.db.transaction(() => {
            this.db.prepare(`
        INSERT INTO libraries (id, name, kind, path, isPersonal, ownerUserId, lastScannedAt)
        VALUES (?, ?, ?, ?, ?, ?, ?)
      `).run(library.id, library.name, library.kind, library.path, library.isPersonal ? 1 : 0, library.ownerUserId ?? null, library.lastScannedAt ?? null);
            if (!library.isPersonal) {
                const users = this.db.prepare("SELECT id FROM users").all();
                for (const u of users) {
                    const row = this.db.prepare("SELECT allowedLibraryIds FROM users WHERE id = ?").get(u.id);
                    if (!row)
                        continue;
                    const ids = JSON.parse(row.allowedLibraryIds || "[]");
                    if (!ids.includes(library.id)) {
                        ids.push(library.id);
                        this.db.prepare("UPDATE users SET allowedLibraryIds = ? WHERE id = ?").run(JSON.stringify(ids), u.id);
                    }
                }
            }
        })();
        return library;
    }
    async updateLibrary(libraryId, updates) {
        this.db.prepare("UPDATE libraries SET name = ?, kind = ?, path = ? WHERE id = ?")
            .run(updates.name, updates.kind, updates.path, libraryId);
        const row = this.db.prepare("SELECT * FROM libraries WHERE id = ?").get(libraryId);
        return row ?? null;
    }
    async deleteLibrary(libraryId) {
        const row = this.db.prepare("SELECT id FROM libraries WHERE id = ?").get(libraryId);
        if (!row)
            return false;
        this.db.transaction(() => {
            this.db.prepare("DELETE FROM libraries WHERE id = ?").run(libraryId);
            const contentPrefix = `${libraryId}:`;
            const users = this.db.prepare("SELECT id, allowedLibraryIds, favoriteContentIds FROM users").all();
            for (const u of users) {
                const libIds = JSON.parse(u.allowedLibraryIds || "[]");
                const favIds = JSON.parse(u.favoriteContentIds || "[]");
                const newLibIds = libIds.filter((id) => id !== libraryId);
                const newFavIds = favIds.filter((id) => !id.startsWith(contentPrefix));
                if (newLibIds.length !== libIds.length || newFavIds.length !== favIds.length) {
                    this.db.prepare("UPDATE users SET allowedLibraryIds = ?, favoriteContentIds = ? WHERE id = ?")
                        .run(JSON.stringify(newLibIds), JSON.stringify(newFavIds), u.id);
                }
            }
            this.db.prepare("DELETE FROM progress WHERE contentId LIKE ?").run(`${contentPrefix}%`);
            this.db.prepare("DELETE FROM bookmarks WHERE contentId LIKE ?").run(`${contentPrefix}%`);
            this.db.prepare("DELETE FROM series_marks WHERE contentId LIKE ?").run(`${contentPrefix}%`);
            this.db.prepare("DELETE FROM user_want_to_read WHERE contentId LIKE ?").run(`${contentPrefix}%`);
            this.db.prepare("DELETE FROM user_reading_list WHERE contentId LIKE ?").run(`${contentPrefix}%`);
            this.db.prepare("DELETE FROM reviews WHERE contentId LIKE ?").run(`${contentPrefix}%`);
            const collections = this.db.prepare("SELECT id, userId, contentIds FROM collections").all();
            const now = new Date().toISOString();
            for (const c of collections) {
                const ids = JSON.parse(c.contentIds || "[]");
                const filtered = ids.filter((id) => !id.startsWith(contentPrefix));
                if (filtered.length !== ids.length) {
                    this.db.prepare("UPDATE collections SET contentIds = ?, updatedAt = ? WHERE id = ? AND userId = ?")
                        .run(JSON.stringify(filtered), now, c.id, c.userId);
                }
            }
        })();
        return true;
    }
    async markLibraryScanned(libraryId, scannedAt) {
        this.db.prepare("UPDATE libraries SET lastScannedAt = ? WHERE id = ?").run(scannedAt, libraryId);
    }
    createSyncRun(run) {
        this.db.prepare(`
      INSERT INTO sync_runs (
        id, source, state, target, libraryId, contentId, message, output, startedAt, finishedAt
      ) VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?)
    `).run(run.id, run.source, run.state, run.target, run.libraryId, run.contentId, run.message, run.output, run.startedAt, run.finishedAt);
    }
    finishSyncRun(id, state, message, output, finishedAt) {
        this.db.prepare(`
      UPDATE sync_runs
      SET state = ?, message = ?, output = ?, finishedAt = ?
      WHERE id = ?
    `).run(state, message, output.slice(-64 * 1024), finishedAt, id);
        this.db.prepare(`
      DELETE FROM sync_runs
      WHERE id NOT IN (
        SELECT id FROM sync_runs ORDER BY startedAt DESC LIMIT 200
      )
    `).run();
    }
    getLatestSyncRun() {
        const row = this.db.prepare(`
      SELECT id, source, state, target, libraryId, contentId, message, output, startedAt, finishedAt
      FROM sync_runs
      WHERE finishedAt IS NOT NULL
      ORDER BY startedAt DESC
      LIMIT 1
    `).get();
        return row ?? null;
    }
    async renameBookmark(userId, contentId, page, name) {
        const result = this.db.prepare("UPDATE bookmarks SET name = ? WHERE userId = ? AND contentId = ? AND page = ?")
            .run(name, userId, contentId, page);
        if (!result.changes)
            return null;
        return this.db.prepare("SELECT * FROM bookmarks WHERE userId = ? AND contentId = ? AND page = ?")
            .get(userId, contentId, page);
    }
    async toggleBookmark(bookmark) {
        const existing = this.db.prepare("SELECT 1 FROM bookmarks WHERE userId = ? AND contentId = ? AND page = ?")
            .get(bookmark.userId, bookmark.contentId, bookmark.page);
        if (existing) {
            this.db.prepare("DELETE FROM bookmarks WHERE userId = ? AND contentId = ? AND page = ?")
                .run(bookmark.userId, bookmark.contentId, bookmark.page);
            return { marked: false };
        }
        this.db.prepare("INSERT INTO bookmarks (userId, contentId, page, createdAt, name) VALUES (?, ?, ?, ?, ?)")
            .run(bookmark.userId, bookmark.contentId, bookmark.page, bookmark.createdAt, bookmark.name ?? "");
        return { marked: true };
    }
    async toggleSeriesMark(mark) {
        const existing = this.db.prepare("SELECT 1 FROM series_marks WHERE userId = ? AND contentId = ?")
            .get(mark.userId, mark.contentId);
        if (existing) {
            this.db.prepare("DELETE FROM series_marks WHERE userId = ? AND contentId = ?")
                .run(mark.userId, mark.contentId);
            return { marked: false };
        }
        this.db.prepare("INSERT INTO series_marks (userId, contentId, createdAt) VALUES (?, ?, ?)")
            .run(mark.userId, mark.contentId, mark.createdAt);
        return { marked: true };
    }
    async addToWantToRead(mark) {
        this.db.prepare("INSERT OR IGNORE INTO user_want_to_read (userId, contentId, createdAt) VALUES (?, ?, ?)")
            .run(mark.userId, mark.contentId, mark.createdAt);
    }
    async removeFromWantToRead(userId, contentId) {
        this.db.prepare("DELETE FROM user_want_to_read WHERE userId = ? AND contentId = ?").run(userId, contentId);
    }
    async addToReadingList(mark) {
        this.db.prepare("INSERT OR IGNORE INTO user_reading_list (userId, contentId, createdAt) VALUES (?, ?, ?)")
            .run(mark.userId, mark.contentId, mark.createdAt);
    }
    async removeFromReadingList(userId, contentId) {
        this.db.prepare("DELETE FROM user_reading_list WHERE userId = ? AND contentId = ?").run(userId, contentId);
    }
    async addToCollection(userId, collectionId, contentId) {
        const row = this.db.prepare("SELECT * FROM collections WHERE id = ? AND userId = ?").get(collectionId, userId);
        if (!row)
            return null;
        const ids = JSON.parse(row.contentIds || "[]");
        if (ids.includes(contentId)) {
            return this.rowToCollection(row);
        }
        ids.push(contentId);
        const now = new Date().toISOString();
        this.db.prepare("UPDATE collections SET contentIds = ?, updatedAt = ? WHERE id = ? AND userId = ?")
            .run(JSON.stringify(ids), now, collectionId, userId);
        return { ...this.rowToCollection(row), contentIds: ids, updatedAt: now };
    }
    async createCollection(collection) {
        this.db.prepare(`
      INSERT INTO collections (id, userId, name, description, sharedWithUserIds, contentIds, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?, ?, ?)
    `).run(collection.id, collection.userId, collection.name, collection.description, JSON.stringify(collection.sharedWithUserIds), JSON.stringify(collection.contentIds), collection.createdAt, collection.updatedAt);
        return collection;
    }
    async updateCollection(userId, collectionId, updates) {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE collections SET name = ?, description = ?, updatedAt = ? WHERE id = ? AND userId = ?")
            .run(updates.name, updates.description, now, collectionId, userId);
        const row = this.db.prepare("SELECT * FROM collections WHERE id = ? AND userId = ?").get(collectionId, userId);
        return row ? this.rowToCollection(row) : null;
    }
    async updateCollectionSharing(userId, collectionId, sharedWithUserIds) {
        const now = new Date().toISOString();
        this.db.prepare("UPDATE collections SET sharedWithUserIds = ?, updatedAt = ? WHERE id = ? AND userId = ?")
            .run(JSON.stringify(sharedWithUserIds), now, collectionId, userId);
        const row = this.db.prepare("SELECT * FROM collections WHERE id = ? AND userId = ?").get(collectionId, userId);
        return row ? this.rowToCollection(row) : null;
    }
    async deleteCollection(userId, collectionId) {
        const result = this.db.prepare("DELETE FROM collections WHERE id = ? AND userId = ?").run(collectionId, userId);
        return result.changes > 0;
    }
    async removeFromCollection(userId, collectionId, contentId) {
        const row = this.db.prepare("SELECT * FROM collections WHERE id = ? AND userId = ?").get(collectionId, userId);
        if (!row)
            return null;
        const ids = JSON.parse(row.contentIds || "[]");
        const filtered = ids.filter((id) => id !== contentId);
        if (filtered.length === ids.length) {
            return this.rowToCollection(row);
        }
        const now = new Date().toISOString();
        this.db.prepare("UPDATE collections SET contentIds = ?, updatedAt = ? WHERE id = ? AND userId = ?")
            .run(JSON.stringify(filtered), now, collectionId, userId);
        return { ...this.rowToCollection(row), contentIds: filtered, updatedAt: now };
    }
    async removeContentForUser(userId, contentId) {
        this.db.transaction(() => {
            this.db.prepare("DELETE FROM progress WHERE userId = ? AND contentId = ?").run(userId, contentId);
            this.db.prepare("DELETE FROM bookmarks WHERE userId = ? AND contentId = ?").run(userId, contentId);
            this.db.prepare("DELETE FROM series_marks WHERE userId = ? AND contentId = ?").run(userId, contentId);
            this.db.prepare("DELETE FROM user_want_to_read WHERE userId = ? AND contentId = ?").run(userId, contentId);
            this.db.prepare("DELETE FROM user_reading_list WHERE userId = ? AND contentId = ?").run(userId, contentId);
            const collections = this.db.prepare("SELECT id, userId, contentIds FROM collections WHERE userId = ?").all(userId);
            const now = new Date().toISOString();
            for (const c of collections) {
                const ids = JSON.parse(c.contentIds || "[]");
                const filtered = ids.filter((id) => id !== contentId);
                if (filtered.length !== ids.length) {
                    this.db.prepare("UPDATE collections SET contentIds = ?, updatedAt = ? WHERE id = ? AND userId = ?")
                        .run(JSON.stringify(filtered), now, c.id, c.userId);
                }
            }
        })();
    }
    async upsertReview(review) {
        this.db.prepare(`
      INSERT INTO reviews (userId, contentId, rating, comment, createdAt, updatedAt)
      VALUES (?, ?, ?, ?, ?, ?)
      ON CONFLICT(userId, contentId) DO UPDATE SET
        rating = excluded.rating,
        comment = excluded.comment,
        updatedAt = excluded.updatedAt
    `).run(review.userId, review.contentId, review.rating, review.comment, review.createdAt, review.updatedAt);
    }
    rowToCollection(row) {
        return {
            id: row.id,
            userId: row.userId,
            name: row.name,
            description: row.description,
            sharedWithUserIds: JSON.parse(row.sharedWithUserIds || "[]"),
            contentIds: JSON.parse(row.contentIds || "[]"),
            createdAt: row.createdAt,
            updatedAt: row.updatedAt
        };
    }
}
export const store = new Store();
