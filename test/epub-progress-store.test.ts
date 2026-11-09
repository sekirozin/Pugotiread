import test from "node:test";
import assert from "node:assert/strict";
import fs from "node:fs/promises";
import os from "node:os";
import path from "node:path";
import Database from "better-sqlite3";

test("PugotiQA: posição do EPUB migra e persiste em banco anterior", async () => {
  const dir = await fs.mkdtemp(path.join(os.tmpdir(), "pugotiread-epub-progress-"));
  try {
    const file = path.join(dir, "store.db");
    const old = new Database(file);
    old.exec(`CREATE TABLE users (
      id TEXT PRIMARY KEY, username TEXT NOT NULL, displayName TEXT NOT NULL, email TEXT NOT NULL,
      avatarUrl TEXT NOT NULL DEFAULT '', googleSub TEXT, nickname TEXT NOT NULL DEFAULT '',
      biography TEXT NOT NULL DEFAULT '', location TEXT NOT NULL DEFAULT '',
      favoriteContentIds TEXT NOT NULL DEFAULT '[]', canLogin INTEGER NOT NULL DEFAULT 1,
      canDownload INTEGER NOT NULL DEFAULT 1, canChangePassword INTEGER NOT NULL DEFAULT 1,
      passwordChangeRequiresEmailConfirmation INTEGER NOT NULL DEFAULT 1, lastActiveAt TEXT,
      role TEXT NOT NULL DEFAULT 'user', passwordHash TEXT NOT NULL, allowedLibraryIds TEXT NOT NULL DEFAULT '[]'
    )`);
    old.prepare("INSERT INTO users (id, username, displayName, email, passwordHash) VALUES (?, ?, ?, ?, ?)")
      .run("u", "tester", "Tester", "test@example.test", "pbkdf2$1$salt$hash");
    old.exec("CREATE TABLE progress (userId TEXT NOT NULL, contentId TEXT NOT NULL, currentPage INTEGER NOT NULL, updatedAt TEXT NOT NULL, PRIMARY KEY (userId, contentId))");
    old.prepare("INSERT INTO progress VALUES (?, ?, ?, ?)").run("u", "book", 2, "2026-10-16");
    old.close();
    process.env.DB_FILE = file;
    process.env.DATA_FILE = path.join(dir, "missing.json");
    const { Store } = await import("../src/server/store.js");
    const store = new Store();
    const migrated = (await store.read()).progress.find(item => item.contentId === "book");
    assert.equal(migrated?.currentPage, 2);
    assert.equal(migrated?.epubOffset, 0);
    await store.upsertProgress({ userId: "u", contentId: "book", currentPage: 2, epubOffset: 0.65, updatedAt: "2026-10-16" });
    const saved = (await store.read()).progress.find(item => item.contentId === "book");
    assert.equal(saved?.epubOffset, 0.65);
  } finally {
    await fs.rm(dir, { recursive: true, force: true });
  }
});
