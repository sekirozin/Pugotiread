import { state } from "../../state/store.js";
import { renderIcon, renderSidebarIcon } from "../icons.js";
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
function renderNavButton(view, icon, label) {
    const active = state.activeView === view ? " active" : "";
    return `
    <button class="nav-button${active}" data-nav-view="${view}" type="button" title="${escapeHtml(label)}">
      <span class="nav-icon" aria-hidden="true">${icon}</span>
      <span class="nav-label">${label}</span>
    </button>
  `;
}
function renderLibraryButton(library) {
    const active = state.activeView === "library" && library.id === state.activeLibraryId ? " active" : "";
    return `
    <div class="library-nav-item">
      <button class="nav-button library-button${active}" data-library-id="${library.id}" type="button" aria-label="Abrir biblioteca ${escapeHtml(library.name)}">
        <span class="nav-icon" aria-hidden="true">${renderSidebarIcon("book", library.name)}</span>
        <span class="nav-label">${escapeHtml(library.name)}</span>
      </button>
      ${state.user?.role === "admin"
        ? `
            <button class="nav-more library-nav-menu-button" data-library-menu-id="${library.id}" type="button" aria-label="Opções da biblioteca ${escapeHtml(library.name)}" aria-expanded="${state.openLibraryMenuId === library.id}">${renderIcon("moreVertical")}</button>
            ${state.openLibraryMenuId === library.id ? renderLibraryContextMenu(library) : ""}
          `
        : ""}
    </div>
  `;
}
export function renderVaultNavButton() {
    const active = state.activeView === "vault" ? " active" : "";
    return `
    <div class="vault-nav-item">
      <button class="nav-button library-button${active}" data-nav-view="vault" type="button" title="Cofre pessoal">
        <span class="nav-icon" aria-hidden="true">${renderSidebarIcon(state.vaultUnlocked ? "vaultOpen" : "vaultClosed", "Cofre pessoal")}</span>
        <span class="nav-label">Cofre pessoal</span>
      </button>
      <button class="nav-more vault-nav-more" data-vault-menu type="button" aria-label="Opções do cofre" aria-expanded="${state.vaultMenuOpen}">${renderIcon("moreVertical")}</button>
      ${state.vaultMenuOpen ? renderVaultContextMenu() : ""}
    </div>
  `;
}
export function renderVaultContextMenu() {
    return `
    <span class="library-context-menu" role="menu" aria-label="Opções do cofre pessoal">
      ${state.vaultUnlocked
        ? `<button class="library-menu-item" id="lock-vault-sidebar-button" type="button" role="menuitem">Bloquear cofre</button>`
        : `<button class="library-menu-item disabled" type="button" role="menuitem" disabled>Cofre bloqueado</button>`}
      <button class="library-menu-item" id="hide-vault-sidebar-button" type="button" role="menuitem">Esconder <span class="menu-shortcut">Ctrl+Shift+L</span></button>
    </span>
  `;
}
export function renderLibraryContextMenu(library) {
    return `
    <span class="library-context-menu" role="menu" aria-label="Opções de ${escapeHtml(library.name)}">
      <button class="library-menu-item" data-scan-library-id="${library.id}" type="button" role="menuitem">Escanear biblioteca</button>
      <button class="library-menu-item" data-edit-library="${library.id}" type="button" role="menuitem">Editar</button>
    </span>
  `;
}
function renderSettingsButton(section, label) {
    const active = state.settingsSection === section ? " active" : "";
    return `<button class="settings-nav-button${active}" data-settings-section="${section}" type="button">${escapeHtml(label)}</button>`;
}
function renderServerSectionButton(section, label) {
    const active = state.settingsSection === "server" && state.serverSection === section ? " active" : "";
    return `<button class="settings-nav-button${active}" data-server-section="${section}" type="button">${escapeHtml(label)}</button>`;
}
function renderMainSidebar() {
    return `
    <nav id="mobile-sidebar" class="side-nav" aria-label="Menu principal">
      ${renderNavButton("home", renderSidebarIcon("home", "Início"), "Início")}
      ${renderNavButton("want", renderSidebarIcon("want", "Lendo agora"), "Lendo agora")}
      ${renderNavButton("collections", renderSidebarIcon("collections", "Coleções"), "Coleções")}
      ${renderNavButton("lists", renderSidebarIcon("lists", "Listas de leitura"), "Listas de leitura")}
      ${renderNavButton("bookmarks", renderSidebarIcon("bookmarks", "Marcadores"), "Marcadores")}
      ${renderNavButton("profile", renderSidebarIcon("reviews", "Minhas Reviews"), "Minhas Reviews")}
      ${renderNavButton("all", renderSidebarIcon("all", "Todos os títulos"), "Todos os títulos")}
      ${state.user?.role === "admin" && !state.vaultHiddenFromMenu ? renderVaultNavButton() : ""}
      ${renderNavButton("people", renderSidebarIcon("people", "Pessoas"), "Pessoas")}
    </nav>
    <div class="side-section">
      <p class="nav-title">Bibliotecas</p>
      <nav class="library-list" aria-label="Bibliotecas criadas pelo admin">
        ${state.libraries.map(renderLibraryButton).join("")}
      </nav>
    </div>
  `;
}
function renderSettingsSidebar() {
    const isAdmin = state.user?.role === "admin";
    const canDownload = isAdmin || state.user?.role === "superuser";
    return `
    <nav class="settings-sidebar" aria-label="Configurações">
      <div class="settings-group">
        <h3>Conta</h3>
        ${renderSettingsButton("account", "Conta")}
      </div>
      ${isAdmin
        ? `
            <div class="settings-group">
              <h3>Servidor</h3>
              ${renderServerSectionButton("libraries", "Bibliotecas")}
              ${renderServerSectionButton("sync", "Sincronizar")}
              ${renderServerSectionButton("users", "Usuários")}
              ${renderServerSectionButton("reading", "Modo de leitura")}
              ${renderServerSectionButton("vault", "Cofre pessoal")}
            </div>
          `
        : ""}
      ${canDownload
        ? `
            <div class="settings-group">
              <h3>Ferramentas</h3>
              ${renderSettingsButton("download", "Download")}
            </div>
          `
        : ""}
    </nav>
  `;
}
export function renderSidebar() {
    return state.activeView === "settings" ? renderSettingsSidebar() : renderMainSidebar();
}
