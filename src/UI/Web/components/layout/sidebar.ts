import type { Library } from "../../../../shared/types.js";
import type { AppState } from "../../state/types.js";
import { state } from "../../state/store.js";
import { renderSidebarIcon } from "../icons.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderNavButton(view: AppState["activeView"], icon: string, label: string): string {
  const active = state.activeView === view ? " active" : "";
  return `
    <button class="nav-button${active}" data-nav-view="${view}" title="${escapeHtml(label)}">
      <span class="nav-icon" aria-hidden="true">${icon}</span>
      <span class="nav-label">${label}</span>
    </button>
  `;
}

function renderLibraryButton(library: Library): string {
  const active = state.activeView === "library" && library.id === state.activeLibraryId ? " active" : "";
  return `
    <button class="nav-button library-button${active}" data-library-id="${library.id}" title="${escapeHtml(library.name)}">
      <span class="nav-icon" aria-hidden="true">${renderSidebarIcon("book", library.name)}</span>
      <span class="nav-label">${escapeHtml(library.name)}</span>
      ${
        state.user?.role === "admin"
          ? `
            <span class="nav-more" data-library-menu-id="${library.id}" role="button" tabindex="0" title="Opções da biblioteca">⋮</span>
            ${state.openLibraryMenuId === library.id ? renderLibraryContextMenu(library) : ""}
          `
          : ""
      }
    </button>
  `;
}

function renderVaultNavButton(): string {
  const active = state.activeView === "vault" ? " active" : "";
  return `
    <button class="nav-button library-button${active}" data-nav-view="vault" title="Cofre pessoal">
      <span class="nav-icon" aria-hidden="true">${renderSidebarIcon(state.vaultUnlocked ? "vaultOpen" : "vaultClosed", "Cofre pessoal")}</span>
      <span class="nav-label">Cofre pessoal</span>
      <span class="nav-more vault-nav-more" data-vault-menu role="button" tabindex="0" title="Opções do cofre">⋮</span>
      ${state.vaultMenuOpen ? renderVaultContextMenu() : ""}
    </button>
  `;
}

function renderVaultContextMenu(): string {
  return `
    <span class="library-context-menu" role="menu" aria-label="Opções do cofre pessoal">
      ${
        state.vaultUnlocked
          ? `<span class="library-menu-item" id="lock-vault-sidebar-button" role="menuitem">Bloquear cofre</span>`
          : `<span class="library-menu-item disabled" role="menuitem">Cofre bloqueado</span>`
      }
    </span>
  `;
}

export function renderLibraryContextMenu(library: Library): string {
  return `
    <span class="library-context-menu" role="menu" aria-label="Opções de ${escapeHtml(library.name)}">
      <span class="library-menu-item" data-scan-library-id="${library.id}" role="menuitem">Scan Library</span>
      <span class="library-menu-item" data-edit-library="${library.id}" role="menuitem">Editar</span>
      <span class="library-menu-item disabled" role="menuitem">Reading Profiles ›</span>
      <span class="library-menu-item disabled" role="menuitem">Others ›</span>
    </span>
  `;
}

function renderSettingsButton(section: AppState["settingsSection"], label: string): string {
  const active = state.settingsSection === section ? " active" : "";
  return `<button class="settings-nav-button${active}" data-settings-section="${section}" type="button">${escapeHtml(label)}</button>`;
}

function renderServerSectionButton(section: AppState["serverSection"], label: string): string {
  const active = state.settingsSection === "server" && state.serverSection === section ? " active" : "";
  return `<button class="settings-nav-button${active}" data-server-section="${section}" type="button">${escapeHtml(label)}</button>`;
}

function renderMainSidebar(): string {
  return `
    <nav class="side-nav" aria-label="Menu principal">
      ${renderNavButton("home", renderSidebarIcon("home", "Início"), "Início")}
      ${renderNavButton("want", renderSidebarIcon("want", "Quero ler"), "Quero ler")}
      ${renderNavButton("collections", renderSidebarIcon("collections", "Coleções"), "Coleções")}
      ${renderNavButton("lists", renderSidebarIcon("lists", "Listas de leitura"), "Listas de leitura")}
      ${renderNavButton("bookmarks", renderSidebarIcon("bookmarks", "Marcadores"), "Marcadores")}
      ${renderNavButton("all", renderSidebarIcon("all", "Todos os títulos"), "Todos os títulos")}
      ${state.user?.role === "admin" ? renderVaultNavButton() : ""}
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

function renderSettingsSidebar(): string {
  const isAdmin = state.user?.role === "admin";
  return `
    <nav class="settings-sidebar" aria-label="Configurações">
      <div class="settings-group">
        <h3>Conta</h3>
        ${renderSettingsButton("account", "Conta")}
      </div>
      ${
        isAdmin
          ? `
            <div class="settings-group">
              <h3>Servidor</h3>
              ${renderServerSectionButton("libraries", "Bibliotecas")}
              ${renderServerSectionButton("users", "Usuários")}
              ${renderServerSectionButton("vault", "Cofre pessoal")}
            </div>
          `
          : ""
      }
    </nav>
  `;
}

export function renderSidebar(): string {
  return state.activeView === "settings" ? renderSettingsSidebar() : renderMainSidebar();
}
