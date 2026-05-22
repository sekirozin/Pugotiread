import type { ContentItem } from "../../../shared/types.js";
import { state } from "../state/store.js";
import { renderIcon, renderSidebarIcon } from "./icons.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderLatestChapters(content: ContentItem): string {
  const latestChapters = content.chapters
    .filter((chapter) => !chapter.isSpecial)
    .slice(-3)
    .reverse();

  if (latestChapters.length === 0) {
    return "";
  }

  return `
    <div class="series-latest-chapters" aria-label="Últimos capítulos de ${escapeHtml(content.title)}">
      ${latestChapters.map((chapter) => `
        <div class="series-latest-chapter">
          <span class="chapter-status-dot" aria-hidden="true"></span>
          <span class="series-latest-chapter-name">${escapeHtml(chapter.name)}</span>
          <span class="series-latest-chapter-pages">${chapter.pageCount} pág.</span>
        </div>
      `).join("")}
    </div>
  `;
}

export function renderSeriesCard(content: ContentItem, cardKey = content.id): string {
  const showMarkButton = state.activeView === "library";
  const marked = state.seriesMarks.includes(content.id);
  const menuOpen = state.openSeriesMenuId === cardKey;
  return `
    <article class="content-card series-card">
      ${
        content.coverUrl
          ? `<img class="cover-image" src="${escapeHtml(content.coverUrl)}" alt="Capa de ${escapeHtml(content.title)}" loading="lazy" />`
          : `<div class="cover-placeholder">${escapeHtml(content.title.slice(0, 1).toUpperCase())}</div>`
      }
      <div class="series-hover-actions">
        ${
          showMarkButton
            ? `<button class="series-mark-button${marked ? " active" : ""}" data-series-mark-toggle="${content.id}" type="button" aria-label="${marked ? "Remover marcação de" : "Marcar"} ${escapeHtml(content.title)}">${renderIcon("mark")}</button>`
            : ""
        }
        <button class="series-continue-button" data-series-continue="${content.id}" type="button" aria-label="Continuar leitura de ${escapeHtml(content.title)}">${renderSidebarIcon("book", "Continuar leitura")}</button>
      </div>
      <div class="series-footer">
        <span class="series-file-icon" aria-hidden="true">${renderSidebarIcon("book", "Obra")}</span>
        <span class="content-title">${escapeHtml(content.title)}</span>
        <button class="series-menu-button" data-series-menu-key="${escapeHtml(cardKey)}" type="button" aria-label="Opções de ${escapeHtml(content.title)}" aria-expanded="${menuOpen}">⋮</button>
      </div>
      ${menuOpen ? renderSeriesContextMenu(content, cardKey) : ""}
      ${renderLatestChapters(content)}
      <p class="series-meta">${content.pageCount} páginas${marked ? " · marcado" : ""}</p>
      <button class="series-open" data-series-open="${content.id}" aria-label="Abrir ${escapeHtml(content.title)}"></button>
    </article>
  `;
}

function renderSeriesContextMenu(content: ContentItem, cardKey: string): string {
  const addMenuOpen = state.openSeriesAddMenuId === cardKey;
  const removeMenuOpen = state.openSeriesRemoveMenuId === cardKey;
  return `
    <div class="series-context-menu" role="menu" aria-label="Opções de ${escapeHtml(content.title)}">
      <button class="series-menu-item has-submenu" data-series-add-menu-key="${escapeHtml(cardKey)}" type="button" role="menuitem" aria-expanded="${addMenuOpen}">
        <span>Adicionar a</span>
        <span aria-hidden="true">›</span>
      </button>
      ${addMenuOpen ? renderSeriesAddMenu(content) : ""}
      <button class="series-menu-item has-submenu" data-series-remove-menu-key="${escapeHtml(cardKey)}" type="button" role="menuitem" aria-expanded="${removeMenuOpen}">
        <span>Remover de</span>
        <span aria-hidden="true">›</span>
      </button>
      ${removeMenuOpen ? renderSeriesRemoveMenu(content) : ""}
      <button class="series-menu-item" data-series-mark-read="${content.id}" type="button" role="menuitem">Marcar como lido</button>
      <button class="series-menu-item" data-series-mark-unread="${content.id}" type="button" role="menuitem">Marcar como não lido</button>
      <button class="series-menu-item" data-series-scan="${content.id}" type="button" role="menuitem">Escanear série</button>
    </div>
  `;
}

function renderSeriesRemoveMenu(content: ContentItem): string {
  const removableCollections = state.collections.filter((collection) => collection.userId === state.user?.id && collection.contentIds.includes(content.id));
  const hasRemovableItems =
    state.wantToRead.includes(content.id) ||
    state.readingList.includes(content.id) ||
    removableCollections.length > 0;

  return `
    <div class="series-remove-menu" role="menu" aria-label="Remover ${escapeHtml(content.title)} de">
      ${
        state.wantToRead.includes(content.id)
          ? `<button class="series-menu-item" data-remove-want="${content.id}" type="button" role="menuitem">Quero ler</button>`
          : ""
      }
      ${
        state.readingList.includes(content.id)
          ? `<button class="series-menu-item" data-remove-reading-list="${content.id}" type="button" role="menuitem">Lista de leitura</button>`
          : ""
      }
      ${removableCollections.map((collection) => `<button class="series-menu-item" data-remove-collection="${escapeHtml(collection.id)}" data-content-id="${content.id}" type="button" role="menuitem">${escapeHtml(collection.name)}</button>`).join("")}
      ${hasRemovableItems ? "" : `<span class="series-menu-empty">Não está em nenhuma lista</span>`}
    </div>
  `;
}

function renderSeriesAddMenu(content: ContentItem): string {
  const ownedCollections = state.collections.filter((collection) => collection.userId === state.user?.id);
  return `
    <div class="series-add-menu" role="menu" aria-label="Adicionar ${escapeHtml(content.title)} a">
      <button class="series-menu-item" data-add-want="${content.id}" type="button" role="menuitem">Quero ler</button>
      <button class="series-menu-item" data-add-reading-list="${content.id}" type="button" role="menuitem">Lista de leitura</button>
      ${
        ownedCollections.length
          ? ownedCollections.map((collection) => `<button class="series-menu-item" data-add-collection="${escapeHtml(collection.id)}" data-content-id="${content.id}" type="button" role="menuitem">${escapeHtml(collection.name)}</button>`).join("")
          : `<span class="series-menu-empty">Nenhuma coleção existente</span>`
      }
    </div>
  `;
}
