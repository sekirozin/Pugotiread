import { state } from "../../state/store.js";
import { renderAvatar } from "../avatar.js";
import { renderIcon, renderSidebarIcon } from "../icons.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function formatDuration(milliseconds: number): string {
  const totalSeconds = Math.max(Math.floor(milliseconds / 1000), 0);
  const hours = Math.floor(totalSeconds / 3600);
  const minutes = Math.floor((totalSeconds % 3600) / 60);
  if (hours > 0) {
    return `${hours}h ${minutes}min`;
  }
  return `${minutes}min`;
}

function formatDateTime(value: string | null): string {
  if (!value) {
    return "Nunca";
  }
  const date = new Date(value);
  return Number.isNaN(date.getTime()) ? "Não registrada" : date.toLocaleString("pt-BR");
}

export function renderStatsMenu(): string {
  const user = state.user;
  const sessionStartedAt = user?.lastActiveAt ? new Date(user.lastActiveAt) : null;
  const validSessionStart = sessionStartedAt && !Number.isNaN(sessionStartedAt.getTime()) ? sessionStartedAt : null;
  const sessionDuration = validSessionStart ? formatDuration(Date.now() - validSessionStart.getTime()) : "Sessão atual";
  const libraryAccessLabel = user?.role === "admin"
    ? `${state.libraries.length} bibliotecas públicas`
    : `${user?.allowedLibraryIds.length ?? 0} bibliotecas liberadas`;
  const sync = user?.role === "admin" ? state.syncStatus : null;
  const vaultSyncRunning = sync?.state === "running" && sync.isVault;
  const queuedDownloads = sync?.queuedDownloads ?? [];
  const syncLabel = sync?.state === "running"
    ? `${sync.percent}%`
    : sync?.state === "completed"
      ? "Concluída"
      : sync?.state === "error"
        ? "Erro"
        : "Parada";

  return `
    <div id="stats-menu" class="stats-menu" role="dialog" aria-label="Estatísticas da sessão">
      <div class="stats-menu-header">
        <strong>Estatísticas</strong>
        <span>${escapeHtml(user?.role === "admin" ? "Admin" : "Usuário")}</span>
      </div>
      <div class="stats-grid">
        <span>Conectado há</span>
        <strong>${escapeHtml(sessionDuration)}</strong>
        <span>Entrada</span>
        <strong>${escapeHtml(validSessionStart ? validSessionStart.toLocaleString("pt-BR") : "Não registrada")}</strong>
        <span>Acesso</span>
        <strong>${escapeHtml(libraryAccessLabel)}</strong>
        ${
          sync
            ? `
              <span>Sincronização</span>
              <strong>${escapeHtml(syncLabel)}</strong>
              <span>Última sincronização</span>
              <strong title="${escapeHtml(sync.lastSyncTarget)}">${escapeHtml(formatDateTime(sync.lastSyncAt))}</strong>
              <span>Downloads na fila</span>
              <strong>${queuedDownloads.length ? `${queuedDownloads.length} aguardando` : "Nenhum"}</strong>
            `
            : ""
        }
      </div>
      ${
        sync?.state === "running"
          ? `
            <div class="sync-stats">
              <div class="sync-stats-heading">
                <strong>${escapeHtml(sync.target)}</strong>
                <span>${sync.percent}%</span>
              </div>
              <progress max="100" value="${sync.percent}">${sync.percent}%</progress>
              ${vaultSyncRunning ? "" : `<p>${escapeHtml(sync.message)}</p>`}
            </div>
          `
          : sync && sync.state !== "idle"
            ? `<p class="sync-stats-result ${sync.state === "error" ? "error" : ""}">${escapeHtml(sync.message)}</p>`
            : ""
      }
      ${
        queuedDownloads.length
          ? `<div class="sync-stats"><div class="sync-stats-heading"><strong>Fila de downloads</strong><span>${queuedDownloads.length}</span></div><p>${escapeHtml(queuedDownloads.map((item) => item.target).join("\n"))}</p></div>`
          : ""
      }
    </div>
  `;
}

export function renderAccountMenu(userName: string): string {
  return `
    <div id="account-menu" class="account-menu" role="menu">
      <div class="account-summary">
        ${renderAvatar(state.user, "avatar account-avatar")}
        <div>
          <strong>${escapeHtml(userName)}</strong>
          <p>${escapeHtml(state.user?.role === "admin" ? "Administrador" : "Usuário")}</p>
        </div>
      </div>
      <button class="account-menu-item" id="profile-button" type="button" role="menuitem">Perfil</button>
      <button class="account-menu-item danger" id="logout-button" type="button" role="menuitem">${renderIcon("logout")}<span>Sair</span></button>
    </div>
  `;
}

export function renderTopbar(userName: string): string {
  return `
    <header class="topbar">
      <div class="topbar-brand">
        <button class="icon-button" id="menu-button" type="button" title="Menu" aria-expanded="${state.mobileNavOpen}" aria-controls="mobile-sidebar">${renderIcon("menu")}</button>
        <button class="topbar-home" id="home-button" type="button">
          <span class="brand-badge" aria-hidden="true">${renderSidebarIcon("book", "Pugotiread")}</span>
          <span>Pugotiread</span>
        </button>
      </div>
      <div class="topbar-actions">
        <div class="search-menu-shell">
          <button class="icon-button" id="search-button" type="button" title="Pesquisar" aria-label="Pesquisar">${renderIcon("search")}</button>
          <label class="search-shell">
            <span class="visually-hidden">Pesquisar</span>
            <input class="search" id="search" placeholder="Pesquisar" value="" autocomplete="off" aria-label="Pesquisar na biblioteca" />
            <span class="search-ghost" id="search-ghost" aria-hidden="true"></span>
            <kbd>Ctrl+Y</kbd>
          </label>
        </div>
        <div class="stats-menu-shell">
          <button class="icon-button" id="stats-button" type="button" title="Estatísticas" aria-expanded="${state.statsMenuOpen}" aria-controls="stats-menu">${renderIcon("stats")}</button>
          ${state.statsMenuOpen ? renderStatsMenu() : ""}
        </div>
        <button class="icon-button" id="theme-toggle" type="button" title="${state.darkMode ? "Modo claro" : "Modo escuro"}">${renderIcon(state.darkMode ? "sun" : "moon")}</button>
        <button class="icon-button" id="settings-button" type="button" title="Configurações">${renderIcon("settings")}</button>
        <div class="account-menu-shell">
          <button class="avatar-button" id="account-button" type="button" aria-expanded="${state.accountMenuOpen}" aria-controls="account-menu" title="${escapeHtml(userName)}">
            ${renderAvatar(state.user)}
            <span class="avatar-caret" aria-hidden="true">${renderIcon("caret")}</span>
          </button>
          ${state.accountMenuOpen ? renderAccountMenu(userName) : ""}
        </div>
      </div>
    </header>
  `;
}
