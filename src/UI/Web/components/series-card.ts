import { isPublicationCompleted } from "../../../shared/work-metadata.js";
import type { ContentItem, LibraryKind } from "../../../shared/types.js";
import { hasRecentlyUpdatedChapters, isRecentlyUpdatedChapter } from "../services/recent-updates.js";
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

function cleanTitle(title: string): string {
  return title.replace(/^\s*MANGA\s*LIVRE\s*[-:]?\s*/i, "").trim() || title;
}

const contentKindTags: Record<LibraryKind, { label: string; tone: string }> = {
  manhwa: { label: "Manhwa", tone: "manhwa" },
  manga: { label: "Mangá", tone: "manga" },
  book: { label: "Livros", tone: "book" },
  lightNovel: { label: "Livros", tone: "book" },
  comic: { label: "Comics", tone: "comic" },
  other: { label: "Outros", tone: "other" }
};

export function renderContentKindTag(content: ContentItem): string {
  const library = state.libraries.find((item) => item.id === content.libraryId);
  if (!library) {
    return "";
  }

  const tag = contentKindTags[library.kind];
  return `<span class="content-kind-tag content-kind-tag--${tag.tone}">${tag.label}</span>`;
}

export function isEpubBook(content: ContentItem): boolean {
  return content.pageTypes.includes("epub");
}

export function isPdfDocument(content: ContentItem): boolean {
  return content.pageTypes.includes("pdf");
}

function getRpgPdfCategory(title: string): string {
  const normalized = title.normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase();
  if (/monstro|bestiario|criatura/.test(normalized)) return "Bestiário";
  if (/classe|prestigio|malandro/.test(normalized)) return "Classes";
  if (/arcano|magia|feitico/.test(normalized)) return "Magias";
  if (/deus|deuses|devoto|divindade/.test(normalized)) return "Divindades";
  if (/raca|racas/.test(normalized)) return "Raças";
  if (/combate|regra/.test(normalized)) return "Regras";
  if (/mundo|arton|cenario/.test(normalized)) return "Cenário";
  if (/aventura|campanha|trilogia/.test(normalized)) return "Guia";
  if (/basico|revisado/.test(normalized)) return "Livro básico";
  return "Suplemento";
}

export function renderPdfDocumentSummary(content: ContentItem): string {
  const progress = state.progress.find((item) => item.contentId === content.id);
  const totalPages = Math.max(content.pageCount, 1);
  const currentPage = progress ? Math.min(Math.max(progress.currentPage + 1, 1), totalPages) : 0;
  const percentage = progress ? Math.round((currentPage / totalPages) * 100) : 0;
  const category = content.formOwnerUserId
    ? content.formOwnerUserId === state.user?.id ? 'Minha ficha' : content.formVisibility === 'private' ? 'Ficha pessoal' : 'Ficha compartilhada'
    : content.rpgRole === 'template' ? 'Modelo de ficha' : content.rpgRole === 'module' ? 'Módulo' : getRpgPdfCategory(cleanTitle(content.title));

  return `
    <div class="rpg-pdf-summary" aria-label="${escapeHtml(category)}: ${escapeHtml(cleanTitle(content.title))}">
      <div class="rpg-pdf-heading">
        <span>${escapeHtml(category)}</span>
        <span>PDF</span>
      </div>
      <button class="rpg-pdf-position" data-series-continue="${escapeHtml(content.id)}" type="button" aria-label="${progress ? "Continuar" : "Abrir"} ${escapeHtml(cleanTitle(content.title))}">
        ${progress ? `Página ${currentPage} de ${totalPages}` : `${totalPages} páginas`}
      </button>
      <progress class="rpg-pdf-progress-bar" value="${percentage}" max="100" aria-label="${percentage}% consultado">${percentage}%</progress>
      <div class="rpg-pdf-meta">
        <span>${progress ? "Último acesso" : "Pronto para consultar"}</span>
        <strong>${percentage}%</strong>
      </div>
    </div>
  `;
}

function getReadableEpubChapterName(content: ContentItem, currentPage: number): string {
  const chapterIndex = content.chapters.findIndex((chapter) => {
    const endPage = chapter.startPage + chapter.pageCount - 1;
    return currentPage >= chapter.startPage && currentPage <= endPage;
  });
  const safeIndex = chapterIndex >= 0 ? chapterIndex : Math.min(currentPage, Math.max(content.chapters.length - 1, 0));
  const chapterName = content.chapters[safeIndex]?.name.trim() ?? "";
  const technicalName =
    !chapterName ||
    /^(?:page|index(?:_split)?|split|section)[_-]?\d+$/i.test(chapterName) ||
    /^(?:copyright|cover|capa|rosto|title|toc|nav)$/i.test(chapterName) ||
    /^\d{10,}(?:[_-].*)?$/i.test(chapterName);

  if (technicalName) {
    return `Capítulo ${safeIndex + 1}`;
  }

  const readableName = chapterName.replaceAll("_", " ").replaceAll("-", " ").replace(/\s+/g, " ").trim();
  return readableName.charAt(0).toLocaleUpperCase("pt-BR") + readableName.slice(1);
}

export function renderEpubBookProgress(content: ContentItem): string {
  const progress = state.progress.find((item) => item.contentId === content.id);
  const totalPages = Math.max(content.pageCount, 1);
  const currentPage = progress ? Math.min(Math.max(progress.currentPage, 0), totalPages - 1) : 0;
  const displayedPage = progress ? currentPage + 1 : 0;
  const percentage = progress ? Math.round((displayedPage / totalPages) * 100) : 0;
  const chapterName = progress ? getReadableEpubChapterName(content, currentPage) : "Leitura não iniciada";

  return `
    <div class="epub-book-progress" aria-label="Progresso de leitura de ${escapeHtml(cleanTitle(content.title))}">
      <div class="epub-book-progress-heading">
        <span>${progress ? "Capítulo atual" : "Progresso da leitura"}</span>
      </div>
      <button class="epub-book-current-chapter" data-series-continue="${escapeHtml(content.id)}" type="button" aria-label="${progress ? "Continuar" : "Iniciar"} leitura de ${escapeHtml(cleanTitle(content.title))}">
        ${escapeHtml(chapterName)}
      </button>
      <progress class="epub-book-progress-bar" value="${percentage}" max="100" aria-label="${percentage}% concluído">${percentage}%</progress>
      <div class="epub-book-progress-meta">
        <span class="epub-book-page-position">${progress ? `Página ${displayedPage} de ${totalPages}` : `${totalPages} páginas`}</span>
        <strong>${percentage}%</strong>
      </div>
    </div>
  `;
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
    <div class="series-latest-chapters" aria-label="Últimos capítulos de ${escapeHtml(cleanTitle(content.title))}">
      ${latestChapters.map((chapter) => `
        <button class="series-latest-chapter${isRecentlyUpdatedChapter(chapter) ? " recent-update" : ""}" data-chapter-open="${escapeHtml(content.id)}" data-chapter-start="${chapter.startPage}" type="button" aria-label="Abrir ${escapeHtml(chapter.name)} de ${escapeHtml(cleanTitle(content.title))}">
          <span class="chapter-status-dot" aria-hidden="true"></span>
          <span class="series-latest-chapter-name">${escapeHtml(chapter.name)}</span>
          <span class="series-latest-chapter-pages">${chapter.pageCount} pág.</span>
        </button>
      `).join("")}
    </div>
  `;
}

function renderSeriesCardMeta(content: ContentItem): string {
  const marked = state.seriesMarks.includes(content.id);

  if (state.activeView !== "want") {
    return `${content.pageCount} páginas${marked ? " · marcado" : ""}`;
  }

  const progress = state.progress.find((item) => item.contentId === content.id);
  if (!progress) {
    return `${content.pageCount} páginas${marked ? " · marcado" : ""}`;
  }

  const chapter = content.chapters.find((item) => {
    const endPage = item.startPage + item.pageCount - 1;
    return progress.currentPage >= item.startPage && progress.currentPage <= endPage;
  });
  const pageLabel = `pág. ${progress.currentPage + 1}/${content.pageCount}`;

  return `${chapter ? `${chapter.name} · ` : ""}${pageLabel}`;
}

export function renderSeriesCard(content: ContentItem, cardKey = content.id): string {
  const showMarkButton = state.activeView === "library";
  const kind = state.libraries.find(library => library.id === content.libraryId)?.kind;
  const completed = (kind === "manga" || kind === "manhwa") && isPublicationCompleted(content.publicationStatus);
  const marked = state.seriesMarks.includes(content.id);
  const menuOpen = state.openSeriesMenuId === cardKey;
  const hasRecentUpdate = !isPdfDocument(content) && hasRecentlyUpdatedChapters(content.chapters);
  return `
    <article class="content-card series-card${hasRecentUpdate ? " recent-update" : ""}">
      <div class="series-card-tags">
        ${state.activeView === "home" ? renderContentKindTag(content) : ""}
        ${completed ? '<span class="content-kind-tag publication-completed series-completed-tag">Finalizada</span>' : ""}
      </div>
      ${
        content.coverUrl
          ? `<img class="cover-image" src="${escapeHtml(content.coverUrl)}" alt="Capa de ${escapeHtml(cleanTitle(content.title))}" loading="lazy" />`
          : `<div class="cover-placeholder">${escapeHtml(cleanTitle(content.title).slice(0, 1).toUpperCase())}</div>`
      }
      <div class="series-hover-actions">
        ${
          showMarkButton
            ? `<button class="series-mark-button${marked ? " active" : ""}" data-series-mark-toggle="${content.id}" type="button" aria-label="${marked ? "Remover marcação de" : "Marcar"} ${escapeHtml(cleanTitle(content.title))}">${renderIcon("mark")}</button>`
            : ""
        }
        <button class="series-continue-button" data-series-continue="${content.id}" type="button" aria-label="Continuar leitura de ${escapeHtml(cleanTitle(content.title))}">${renderSidebarIcon("book", "Continuar leitura")}</button>
      </div>
      <div class="series-footer">
        <span class="series-file-icon" aria-hidden="true">${renderSidebarIcon("book", "Obra")}</span>
        <span class="content-title">${escapeHtml(cleanTitle(content.title))}</span>
        <button class="series-menu-button" data-series-menu-key="${escapeHtml(cardKey)}" type="button" aria-label="Opções de ${escapeHtml(cleanTitle(content.title))}" aria-expanded="${menuOpen}">${renderIcon("moreVertical")}</button>
      </div>
      ${menuOpen ? renderSeriesContextMenu(content, cardKey) : ""}
      ${isEpubBook(content) ? renderEpubBookProgress(content) : isPdfDocument(content) ? renderPdfDocumentSummary(content) : renderLatestChapters(content)}
      ${isEpubBook(content) || isPdfDocument(content) ? "" : `<p class="series-meta">${escapeHtml(renderSeriesCardMeta(content))}</p>`}
      <button class="series-open" data-series-open="${content.id}" aria-label="Abrir ${escapeHtml(cleanTitle(content.title))}"></button>
    </article>
  `;
}

export function renderSeriesContextMenu(content: ContentItem, cardKey: string): string {
  const addMenuOpen = state.openSeriesAddMenuId === cardKey;
  const removeMenuOpen = state.openSeriesRemoveMenuId === cardKey;
  const library = state.libraries.find((item) => item.id === content.libraryId);
  const canSync =
    state.user?.role === "admin" &&
    Boolean(library && !library.isPersonal && ["manga", "manhwa", "comic", "other"].includes(library.kind));
  return `
    <div class="series-context-menu" role="menu" aria-label="Opções de ${escapeHtml(cleanTitle(content.title))}">
      <button class="series-menu-item has-submenu" data-series-add-menu-key="${escapeHtml(cardKey)}" type="button" role="menuitem" aria-expanded="${addMenuOpen}">
        <span>Adicionar a</span>
        <span aria-hidden="true">${renderIcon("caretRight")}</span>
      </button>
      ${addMenuOpen ? renderSeriesAddMenu(content) : ""}
      <button class="series-menu-item has-submenu" data-series-remove-menu-key="${escapeHtml(cardKey)}" type="button" role="menuitem" aria-expanded="${removeMenuOpen}">
        <span>Remover de</span>
        <span aria-hidden="true">${renderIcon("caretRight")}</span>
      </button>
      ${removeMenuOpen ? renderSeriesRemoveMenu(content) : ""}
      <button class="series-menu-item" data-series-mark-read="${content.id}" type="button" role="menuitem">Marcar como lido</button>
      <button class="series-menu-item" data-series-mark-unread="${content.id}" type="button" role="menuitem">Marcar como não lido</button>
      <button class="series-menu-item" data-series-scan="${content.id}" type="button" role="menuitem">Escanear série</button>
      ${canSync ? `<button class="series-menu-item" data-series-sync="${content.id}" type="button" role="menuitem">Sincronizar obra</button>` : ""}
    </div>
  `;
}

function renderSeriesRemoveMenu(content: ContentItem): string {
  const removableCollections = state.collections.filter((collection) => collection.userId === state.user?.id && collection.contentIds.includes(content.id));
  const hasProgress = state.progress.some((progress) => progress.contentId === content.id);
  const isProfileFavorite = (state.user?.favoriteContentIds ?? []).includes(content.id);
  const hasRemovableItems =
    hasProgress ||
    isProfileFavorite ||
    state.wantToRead.includes(content.id) ||
    state.readingList.includes(content.id) ||
    removableCollections.length > 0;

  return `
    <div class="series-remove-menu" role="menu" aria-label="Remover ${escapeHtml(cleanTitle(content.title))} de">
      ${
        hasProgress
          ? `<button class="series-menu-item" data-remove-reading-now="${content.id}" type="button" role="menuitem">Lendo agora</button>`
          : ""
      }
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
      ${isProfileFavorite ? `<button class="series-menu-item" data-profile-favorite-toggle="${content.id}" data-profile-favorite-enabled="false" type="button" role="menuitem">Obras favoritas</button>` : ""}
      ${hasRemovableItems ? "" : `<span class="series-menu-empty">Não está em nenhuma lista</span>`}
    </div>
  `;
}

function renderSeriesAddMenu(content: ContentItem): string {
  const ownedCollections = state.collections.filter((collection) => collection.userId === state.user?.id);
  const profileFavorites = state.user?.favoriteContentIds ?? [];
  const isProfileFavorite = profileFavorites.includes(content.id);
  const profileFavoriteLimitReached = !isProfileFavorite && profileFavorites.length >= 3;
  return `
    <div class="series-add-menu" role="menu" aria-label="Adicionar ${escapeHtml(cleanTitle(content.title))} a">
      <button class="series-menu-item" data-add-reading-list="${content.id}" type="button" role="menuitem">Lista de leitura</button>
      ${isProfileFavorite ? "" : `<button class="series-menu-item" data-profile-favorite-toggle="${content.id}" data-profile-favorite-enabled="true" type="button" role="menuitem" ${profileFavoriteLimitReached ? "disabled" : ""}>${profileFavoriteLimitReached ? "Limite de 3 favoritas" : "Obras favoritas"}</button>`}
      ${
        ownedCollections.length
          ? ownedCollections.map((collection) => `<button class="series-menu-item" data-add-collection="${escapeHtml(collection.id)}" data-content-id="${content.id}" type="button" role="menuitem">${escapeHtml(collection.name)}</button>`).join("")
          : `<span class="series-menu-empty">Nenhuma coleção existente</span>`
      }
    </div>
  `;
}
