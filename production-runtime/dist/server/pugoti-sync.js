import { spawn } from "node:child_process";
import crypto from "node:crypto";
import fs from "node:fs/promises";
import path from "node:path";
import { config } from "./config.js";
import { store } from "./store.js";
const syncableLibraryKinds = new Set(["manga", "manhwa", "comic", "lightNovel"]);
const outputLimit = 4 * 1024 * 1024;
const vaultStatusMessage = "Atualizando o cofre";
let syncStatus = createIdleStatus();
const downloadQueue = [];
let queuedDownloadStartScheduled = false;
function createIdleStatus() {
    return {
        state: "idle",
        isVault: false,
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
        lastSyncAt: null,
        lastSyncTarget: "",
        lastSyncState: null,
        lastSyncMessage: "",
        lastSyncSource: null,
        output: "",
        queuedDownloads: []
    };
}
function getContentFolderName(library, content) {
    const prefix = `${library.id}:`;
    if (!content.id.startsWith(prefix)) {
        throw new Error("A obra não pertence à biblioteca selecionada.");
    }
    try {
        return Buffer.from(content.id.slice(prefix.length), "base64url").toString("utf8");
    }
    catch {
        throw new Error("Identificador de obra inválido.");
    }
}
async function resolveContentPath(library, content) {
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
function appendOutput(value) {
    syncStatus.output = `${syncStatus.output}${value}`.slice(-outputLimit);
}
function updateProgress(line) {
    const clean = line.replace(/\x1b\[[0-9;]*[A-Za-z]/g, "").trim();
    if (!clean) {
        return;
    }
    const workMatch = clean.match(/^\[(\d+)\/(\d+)\]\s+/);
    if (workMatch) {
        syncStatus.currentWork = Number(workMatch[1]);
        syncStatus.totalWorks = Number(workMatch[2]);
        syncStatus.message = syncStatus.isVault
            ? vaultStatusMessage
            : `Sincronizando obra ${syncStatus.currentWork} de ${syncStatus.totalWorks}.`;
        return;
    }
    const progressMatch = clean.match(/Capitulo atual .+?\s(\d+)\/(\d+)\s+\|\s+Total .+?\s(\d+)\/(\d+)\s+\|\s+(.+)$/);
    if (!progressMatch) {
        return;
    }
    syncStatus.currentPage = Number(progressMatch[1]);
    syncStatus.totalPages = Number(progressMatch[2]);
    syncStatus.currentChapter = Number(progressMatch[3]);
    syncStatus.totalChapters = Number(progressMatch[4]);
    syncStatus.currentLabel = syncStatus.isVault ? "" : progressMatch[5];
    const chapterFraction = syncStatus.totalChapters > 0
        ? Math.max(0, syncStatus.currentChapter - 1) / syncStatus.totalChapters
            + (syncStatus.totalPages > 0 ? syncStatus.currentPage / syncStatus.totalPages / syncStatus.totalChapters : 0)
        : 0;
    const totalWorks = Math.max(syncStatus.totalWorks, 1);
    const currentWork = Math.max(syncStatus.currentWork, 1);
    const overallFraction = ((currentWork - 1) + chapterFraction) / totalWorks;
    syncStatus.percent = Math.min(99, Math.max(syncStatus.percent, Math.round(overallFraction * 100)));
    syncStatus.message = syncStatus.isVault
        ? vaultStatusMessage
        : `${syncStatus.currentLabel}: página ${syncStatus.currentPage} de ${syncStatus.totalPages}.`;
}
function consumeOutput(value, remainder) {
    appendOutput(value);
    const parts = `${remainder.value}${value}`.split(/[\r\n]+/);
    remainder.value = parts.pop() ?? "";
    for (const line of parts) {
        updateProgress(line);
    }
    updateProgress(remainder.value);
}
export function canDownloadToLibrary(library) {
    return syncableLibraryKinds.has(library.kind);
}
export function canSyncLibrary(library) {
    return !library.isPersonal && canDownloadToLibrary(library);
}
export function getPugotiSyncStatus() {
    const latest = store.getLatestSyncRun();
    return {
        ...syncStatus,
        output: syncStatus.isVault ? "" : syncStatus.output,
        lastSyncAt: latest?.finishedAt ?? null,
        lastSyncTarget: latest?.target ?? "",
        lastSyncState: latest?.state === "completed" || latest?.state === "error" ? latest.state : null,
        lastSyncMessage: latest?.message ?? "",
        lastSyncSource: latest?.source ?? null,
        queuedDownloads: downloadQueue.map((item) => ({
            target: item.library.isPersonal
                ? vaultStatusMessage
                : `Download ${item.directDownload.kind}: ${item.directDownload.url}`,
            queuedAt: item.queuedAt
        }))
    };
}
export function isPugotiSyncBusy() {
    return syncStatus.state === "running" || queuedDownloadStartScheduled || downloadQueue.length > 0;
}
function scheduleQueuedDownload() {
    if (syncStatus.state === "running" || queuedDownloadStartScheduled || downloadQueue.length === 0) {
        return;
    }
    queuedDownloadStartScheduled = true;
    queueMicrotask(() => {
        queuedDownloadStartScheduled = false;
        if (syncStatus.state === "running") {
            return;
        }
        const next = downloadQueue.shift();
        if (!next) {
            return;
        }
        void startPugotiSync(next.library, null, next.onSuccess, next.source, next.directDownload)
            .catch((error) => {
            console.error("[DOWNLOAD] Não foi possível iniciar item da fila:", error);
            scheduleQueuedDownload();
        });
    });
}
export async function startPugotiSync(library, content, onSuccess, source = "manual", directDownload) {
    const isDirectDownloadDestination = Boolean(directDownload) && canDownloadToLibrary(library);
    if (!canSyncLibrary(library) && !isDirectDownloadDestination) {
        throw new Error("Este tipo de biblioteca não participa da sincronização.");
    }
    if (syncStatus.state === "running") {
        if (directDownload) {
            downloadQueue.push({ library, directDownload, onSuccess, source, queuedAt: new Date().toISOString() });
            return getPugotiSyncStatus();
        }
        throw new Error("Já existe uma sincronização em andamento.");
    }
    const targetPath = content ? await resolveContentPath(library, content) : "all";
    const args = directDownload
        ? [directDownload.kind, directDownload.url, "--output", library.path]
        : content
            ? [targetPath, "--sync", "--output", library.path]
            : ["--all", "--sync", "--output", library.path];
    const isVault = Boolean(library.isPersonal);
    const target = isVault
        ? vaultStatusMessage
        : directDownload
            ? `Download ${directDownload.kind}: ${directDownload.url}`
            : content?.title ?? `Todas as obras de ${library.name}`;
    const runId = crypto.randomUUID();
    const startedAt = new Date().toISOString();
    syncStatus = {
        ...createIdleStatus(),
        state: "running",
        isVault,
        target,
        libraryId: library.id,
        contentId: content?.id ?? null,
        currentWork: content ? 1 : 0,
        totalWorks: content ? 1 : 0,
        message: isVault ? vaultStatusMessage : `Preparando ${target}...`,
        startedAt
    };
    store.createSyncRun({
        id: runId,
        source,
        state: "running",
        target,
        libraryId: library.id,
        contentId: content?.id ?? null,
        message: syncStatus.message,
        output: "",
        startedAt,
        finishedAt: null
    });
    const command = config.pugotiIoLockPath ? "flock" : config.pugotiCommand;
    const commandArgs = config.pugotiIoLockPath
        ? [
            "--exclusive",
            "--wait",
            String(config.pugotiIoLockWaitSeconds),
            config.pugotiIoLockPath,
            config.pugotiCommand,
            ...args
        ]
        : args;
    if (config.pugotiIoLockPath) {
        syncStatus.message = isVault
            ? vaultStatusMessage
            : `${target}: aguardando a fila de operações do disco...`;
    }
    const child = spawn(command, commandArgs, {
        cwd: library.path,
        env: { ...process.env, PUGOTI_PROGRESS: "1", PYTHONUNBUFFERED: "1" },
        stdio: ["ignore", "pipe", "pipe"]
    });
    const stdoutRemainder = { value: "" };
    const stderrRemainder = { value: "" };
    let settled = false;
    child.stdout.setEncoding("utf8");
    child.stderr.setEncoding("utf8");
    child.stdout.on("data", (chunk) => consumeOutput(chunk, stdoutRemainder));
    child.stderr.on("data", (chunk) => consumeOutput(chunk, stderrRemainder));
    const timeout = setTimeout(() => {
        child.kill("SIGTERM");
        syncStatus.message = "O sincronizador excedeu o tempo limite.";
    }, config.pugotiTimeoutMs);
    const fail = (message) => {
        if (settled) {
            return;
        }
        settled = true;
        clearTimeout(timeout);
        syncStatus.state = "error";
        syncStatus.message = syncStatus.isVault ? "Falha ao atualizar o cofre." : message;
        syncStatus.finishedAt = new Date().toISOString();
        store.finishSyncRun(runId, "error", syncStatus.message, syncStatus.output, syncStatus.finishedAt);
        scheduleQueuedDownload();
    };
    child.on("error", (error) => {
        fail(error.code === "ENOENT"
            ? "Executável do Pugotidownloader não foi encontrado no servidor."
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
            const lines = syncStatus.output.trim().split(/[\r\n]+/).filter(Boolean);
            const reversedLines = [...lines].reverse();
            const detail = reversedLines.find((line) => line.startsWith("Falhas no sync:"))
                ?? reversedLines.find((line) => line.startsWith("Erro:"))
                ?? lines.at(-1);
            const failure = detail || `O sincronizador terminou com código ${code ?? signal ?? "desconhecido"}.`;
            // A failing work may follow successful downloads; publish those pages too.
            void onSuccess()
                .then(() => fail(failure))
                .catch((error) => fail(`${failure} Também houve falha ao atualizar o índice: ${error instanceof Error ? error.message : String(error)}`));
            return;
        }
        syncStatus.percent = 99;
        syncStatus.message = isVault ? vaultStatusMessage : "Atualizando a biblioteca...";
        void onSuccess()
            .then(() => {
            settled = true;
            syncStatus.state = "completed";
            syncStatus.percent = 100;
            syncStatus.message = isVault ? "Cofre atualizado." : `${target}: sincronização concluída.`;
            syncStatus.finishedAt = new Date().toISOString();
            store.finishSyncRun(runId, "completed", syncStatus.message, syncStatus.output, syncStatus.finishedAt);
            scheduleQueuedDownload();
        })
            .catch((error) => {
            fail(error instanceof Error ? error.message : "Falha ao atualizar a biblioteca.");
        });
    });
    return getPugotiSyncStatus();
}
