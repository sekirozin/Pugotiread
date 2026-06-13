import { spawn } from "node:child_process";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import type { ContentItem, Library } from "../shared/types.js";

const syncableLibraryKinds = new Set(["manga", "manhwa", "comic", "other"]);
const outputLimit = 4 * 1024 * 1024;

export type SyncStatus = {
  state: "idle" | "running" | "completed" | "error";
  target: string;
  libraryId: string | null;
  contentId: string | null;
  percent: number;
  currentChapter: number;
  totalChapters: number;
  currentPage: number;
  totalPages: number;
  currentLabel: string;
  currentWork: number;
  totalWorks: number;
  message: string;
  startedAt: string | null;
  finishedAt: string | null;
  output: string;
};

let syncStatus: SyncStatus = createIdleStatus();

function createIdleStatus(): SyncStatus {
  return {
    state: "idle",
    target: "",
    libraryId: null,
    contentId: null,
    percent: 0,
    currentChapter: 0,
    totalChapters: 0,
    currentPage: 0,
    totalPages: 0,
    currentLabel: "",
    currentWork: 0,
    totalWorks: 0,
    message: "Nenhuma sincronização executada nesta sessão do servidor.",
    startedAt: null,
    finishedAt: null,
    output: ""
  };
}

function getContentFolderName(library: Library, content: ContentItem): string {
  const prefix = `${library.id}:`;
  if (!content.id.startsWith(prefix)) {
    throw new Error("A obra não pertence à biblioteca selecionada.");
  }

  try {
    return Buffer.from(content.id.slice(prefix.length), "base64url").toString("utf8");
  } catch {
    throw new Error("Identificador de obra inválido.");
  }
}

async function resolveContentPath(library: Library, content: ContentItem): Promise<string> {
  const libraryPath = path.resolve(library.path);
  const contentPath = path.resolve(libraryPath, getContentFolderName(library, content));
  const relative = path.relative(libraryPath, contentPath);
  if (!relative || relative.startsWith("..") || path.isAbsolute(relative)) {
    throw new Error("Pasta da obra inválida.");
  }

  const urlFile = path.join(contentPath, "manga_url.txt");
  const stat = await fs.stat(urlFile).catch(() => null);
  if (!stat?.isFile()) {
    throw new Error("A obra não possui manga_url.txt e não pode ser sincronizada.");
  }
  return contentPath;
}

function appendOutput(value: string): void {
  syncStatus.output = `${syncStatus.output}${value}`.slice(-outputLimit);
}

function updateProgress(line: string): void {
  const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
  if (!clean) {
    return;
  }

  const workMatch = clean.match(/^\[(\d+)\/(\d+)\]\s+/);
  if (workMatch) {
    syncStatus.currentWork = Number(workMatch[1]);
    syncStatus.totalWorks = Number(workMatch[2]);
    syncStatus.message = `Sincronizando obra ${syncStatus.currentWork} de ${syncStatus.totalWorks}.`;
    return;
  }

  const progressMatch = clean.match(
    /Capitulo atual .+?\s(\d+)\/(\d+)\s+\|\s+Total .+?\s(\d+)\/(\d+)\s+\|\s+(.+)$/
  );
  if (!progressMatch) {
    return;
  }

  syncStatus.currentPage = Number(progressMatch[1]);
  syncStatus.totalPages = Number(progressMatch[2]);
  syncStatus.currentChapter = Number(progressMatch[3]);
  syncStatus.totalChapters = Number(progressMatch[4]);
  syncStatus.currentLabel = progressMatch[5];

  const chapterFraction = syncStatus.totalChapters > 0
    ? Math.max(0, syncStatus.currentChapter - 1) / syncStatus.totalChapters
      + (syncStatus.totalPages > 0 ? syncStatus.currentPage / syncStatus.totalPages / syncStatus.totalChapters : 0)
    : 0;
  const totalWorks = Math.max(syncStatus.totalWorks, 1);
  const currentWork = Math.max(syncStatus.currentWork, 1);
  const overallFraction = ((currentWork - 1) + chapterFraction) / totalWorks;
  syncStatus.percent = Math.min(99, Math.max(syncStatus.percent, Math.round(overallFraction * 100)));
  syncStatus.message = `${syncStatus.currentLabel}: página ${syncStatus.currentPage} de ${syncStatus.totalPages}.`;
}

function consumeOutput(value: string, remainder: { value: string }): void {
  appendOutput(value);
  const parts = `${remainder.value}${value}`.split(/[\r\n]+/);
  remainder.value = parts.pop() ?? "";
  for (const line of parts) {
    updateProgress(line);
  }
  updateProgress(remainder.value);
}

export function canSyncLibrary(library: Library): boolean {
  return !library.isPersonal && syncableLibraryKinds.has(library.kind);
}

export function getMangasekSyncStatus(): SyncStatus {
  return { ...syncStatus };
}

export async function startMangasekSync(
  library: Library,
  content: ContentItem | null,
  onSuccess: () => Promise<void>
): Promise<SyncStatus> {
  if (!canSyncLibrary(library)) {
    throw new Error("Este tipo de biblioteca não participa da sincronização.");
  }
  if (syncStatus.state === "running") {
    throw new Error("Já existe uma sincronização em andamento.");
  }

  const targetPath = content ? await resolveContentPath(library, content) : "all";
  const args = content
    ? [targetPath, "--sync", "--output", library.path]
    : ["--all", "--sync", "--output", library.path];
  const target = content?.title ?? `Todas as obras de ${library.name}`;
  syncStatus = {
    ...createIdleStatus(),
    state: "running",
    target,
    libraryId: library.id,
    contentId: content?.id ?? null,
    currentWork: content ? 1 : 0,
    totalWorks: content ? 1 : 0,
    message: `Preparando ${target}...`,
    startedAt: new Date().toISOString()
  };

  const child = spawn(config.mangasekCommand, args, {
    cwd: library.path,
    env: { ...process.env, MANGASEK_PROGRESS: "1" },
    stdio: ["ignore", "pipe", "pipe"]
  });
  const stdoutRemainder = { value: "" };
  const stderrRemainder = { value: "" };
  let settled = false;

  child.stdout.setEncoding("utf8");
  child.stderr.setEncoding("utf8");
  child.stdout.on("data", (chunk: string) => consumeOutput(chunk, stdoutRemainder));
  child.stderr.on("data", (chunk: string) => consumeOutput(chunk, stderrRemainder));

  const timeout = setTimeout(() => {
    child.kill("SIGTERM");
    syncStatus.message = "O sincronizador excedeu o tempo limite.";
  }, config.mangasekTimeoutMs);

  const fail = (message: string): void => {
    if (settled) {
      return;
    }
    settled = true;
    clearTimeout(timeout);
    syncStatus.state = "error";
    syncStatus.message = message;
    syncStatus.finishedAt = new Date().toISOString();
  };

  child.on("error", (error) => {
    fail((error as NodeJS.ErrnoException).code === "ENOENT"
      ? "Executável do mangasekdownloader não foi encontrado no servidor."
      : error.message);
  });
  child.on("close", (code, signal) => {
    if (settled) {
      return;
    }
    clearTimeout(timeout);
    updateProgress(stdoutRemainder.value);
    updateProgress(stderrRemainder.value);
    if (code !== 0) {
      const detail = syncStatus.output.trim().split(/\r?\n/).filter(Boolean).at(-1);
      fail(detail || `O sincronizador terminou com código ${code ?? signal ?? "desconhecido"}.`);
      return;
    }

    syncStatus.percent = 99;
    syncStatus.message = "Atualizando a biblioteca...";
    void onSuccess()
      .then(() => {
        settled = true;
        syncStatus.state = "completed";
        syncStatus.percent = 100;
        syncStatus.message = `${target}: sincronização concluída.`;
        syncStatus.finishedAt = new Date().toISOString();
      })
      .catch((error) => {
        fail(error instanceof Error ? error.message : "Falha ao atualizar a biblioteca.");
      });
  });

  return getMangasekSyncStatus();
}
