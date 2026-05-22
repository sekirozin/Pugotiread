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

function renderStatsMenu(): string {
  const user = state.user;
  const sessionStartedAt = user?.lastActiveAt ? new Date(user.lastActiveAt) : null;
  const validSessionStart = sessionStartedAt && !Number.isNaN(sessionStartedAt.getTime()) ? sessionStartedAt : null;
  const sessionDuration = validSessionStart ? formatDuration(Date.now() - validSessionStart.getTime()) : "Sessão atual";
  const libraryAccessLabel = user?.role === "admin"
    ? `${state.libraries.length} bibliotecas públicas`
    : `${user?.allowedLibraryIds.length ?? 0} bibliotecas liberadas`;

  return `
    <div class="stats-menu" role="dialog" aria-label="Estatísticas da sessão">
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
      </div>
    </div>
  `;
}

function renderAccountMenu(userName: string): string {
  return `
    <div class="account-menu" role="menu">
      <div class="account-summary">
        ${renderAvatar(state.user, "avatar account-avatar")}
        <div>
          <strong>${escapeHtml(userName)}</strong>
          <p>${escapeHtml(state.user?.role === "admin" ? "Administrador" : "Usuário")}</p>
        </div>
      </div>
      <button class="account-menu-item" id="profile-button" type="button" role="menuitem">Perfil</button>
      <button class="account-menu-item danger" id="logout-button" type="button" role="menuitem">Logout</button>
    </div>
  `;
}

export function renderTopbar(userName: string): string {
  return `
    <header class="topbar">
      <div class="topbar-brand">
        <button class="icon-button" id="menu-button" type="button" title="Menu" aria-expanded="${state.mobileNavOpen}">${renderIcon("menu")}</button>
        <button class="topbar-home" id="home-button" type="button">
          <span class="brand-badge" aria-hidden="true">${renderSidebarIcon("book", "Pugotiread")}</span>
          <span>Pugotiread</span>
        </button>
      </div>
      <div class="topbar-actions">
        <div class="search-menu-shell">
          <button class="icon-button" id="search-button" type="button" title="Pesquisar" aria-label="Pesquisar"><i class="fa-solid fa-magnifying-glass"></i></button>
          <label class="search-shell">
            <span class="visually-hidden">Pesquisar</span>
            <input class="search" id="search" placeholder="Search (Procurar)" value="" />
            <span class="search-ghost" id="search-ghost" aria-hidden="true"></span>
            <kbd>Ctrl+Y</kbd>
          </label>
        </div>
        <div class="stats-menu-shell">
          <button class="icon-button" id="stats-button" type="button" title="Estatísticas" aria-expanded="${state.statsMenuOpen}">${renderIcon("stats")}</button>
          ${state.statsMenuOpen ? renderStatsMenu() : ""}
        </div>
        <button class="icon-button" id="theme-toggle" type="button" title="${state.darkMode ? "Modo claro" : "Modo escuro"}"><i class="fa-solid ${state.darkMode ? "fa-sun" : "fa-moon"}"></i></button>
        <button class="icon-button" id="settings-button" type="button" title="Configurações">${renderIcon("settings")}</button>
        <div class="account-menu-shell">
          <button class="avatar-button" id="account-button" type="button" aria-expanded="${state.accountMenuOpen}" title="${escapeHtml(userName)}">
            ${renderAvatar(state.user)}
            <span class="avatar-caret" aria-hidden="true">${renderIcon("caret")}</span>
          </button>
          ${state.accountMenuOpen ? renderAccountMenu(userName) : ""}
        </div>
      </div>
    </header>
  `;
}
