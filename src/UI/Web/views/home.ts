import type { ContentItem } from "../../../shared/types.js";
import { renderIcon } from "../components/icons.js";
import { isEpubBook, isPdfDocument, renderContentKindTag, renderEpubBookProgress, renderPdfDocumentSummary, renderSeriesCard } from "../components/series-card.js";
import { hasRecentlyUpdatedChapters, isRecentlyUpdatedChapter } from "../services/recent-updates.js";
import { filterContents } from "../services/search.js";
import { state } from "../state/store.js";
import { renderEmptyMedia, renderNoSearchResults } from "./shared.js";

function getFilteredHomeContents(): ContentItem[] {
  return filterContents(state.homeContents, state.search);
}

function getChapterUpdatedAt(chapter: ContentItem["chapters"][number]): number {
  if (!chapter.addedAt) {
    return 0;
  }

  const updatedAt = Date.parse(chapter.addedAt);
  return Number.isFinite(updatedAt) ? updatedAt : 0;
}

function getContentLatestUpdateAt(content: ContentItem): number {
  const latestChapter = content.chapters
    .filter((chapter) => !chapter.isSpecial)
    .reduce<ContentItem["chapters"][number] | null>((latest, chapter) => {
      if (!latest || chapter.startPage > latest.startPage) {
        return chapter;
      }
      return latest;
    }, null);

  return latestChapter ? getChapterUpdatedAt(latestChapter) : 0;
}

function getReleaseContents(): ContentItem[] {
  return getFilteredHomeContents()
    .map((content) => ({ content, updatedAt: getContentLatestUpdateAt(content) }))
    .filter((item) => item.updatedAt > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt || cleanTitle(a.content.title).localeCompare(cleanTitle(b.content.title), "pt-BR"))
    .map((item) => item.content);
}

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

function renderHomeLayoutButton(layout: "grid" | "list", label: string, icon: "grid" | "readerVertical"): string {
  const active = state.homeLayout === layout;
  return `
    <button class="home-layout-button${active ? " active" : ""}" data-home-layout="${layout}" type="button" aria-label="Mostrar em ${label}" aria-pressed="${active}">
      ${renderIcon(icon)}
    </button>
  `;
}

function renderLatestChapterRows(content: ContentItem): string {
  const latestChapters = content.chapters
    .filter((chapter) => !chapter.isSpecial)
    .sort((a, b) => b.startPage - a.startPage)
    .slice(0, 3)

  if (latestChapters.length === 0) {
    return `<p class="home-list-empty">Nenhum capítulo encontrado.</p>`;
  }

  return latestChapters.map((chapter) => `
    <button class="home-list-chapter${isRecentlyUpdatedChapter(chapter) ? " recent-update" : ""}" data-chapter-open="${escapeHtml(content.id)}" data-chapter-start="${chapter.startPage}" type="button" aria-label="Abrir ${escapeHtml(chapter.name)} de ${escapeHtml(cleanTitle(content.title))}">
      <span class="chapter-status-dot" aria-hidden="true"></span>
      <span class="home-list-chapter-name">${escapeHtml(chapter.name)}</span>
      <span class="home-list-chapter-meta">${chapter.pageCount} pág.</span>
    </button>
  `).join("");
}

function renderHomeListItem(content: ContentItem, index: number): string {
  const hasRecentUpdate = !isPdfDocument(content) && hasRecentlyUpdatedChapters(content.chapters);
  return `
    <article class="home-list-item${hasRecentUpdate ? " recent-update" : ""}">
      <button class="home-list-cover" data-series-open="${escapeHtml(content.id)}" type="button" aria-label="Abrir ${escapeHtml(cleanTitle(content.title))}">
        ${
          content.coverUrl
            ? `<img src="${escapeHtml(content.coverUrl)}" alt="Capa de ${escapeHtml(cleanTitle(content.title))}" loading="${index < 3 ? "eager" : "lazy"}" />`
          : `<span>${escapeHtml(cleanTitle(content.title).slice(0, 1).toUpperCase())}</span>`
        }
        ${renderContentKindTag(content)}
      </button>
      <div class="home-list-main">
        <button class="home-list-title" data-series-open="${escapeHtml(content.id)}" type="button">${escapeHtml(cleanTitle(content.title))}</button>
        <div class="home-list-chapters">
          ${isEpubBook(content) ? renderEpubBookProgress(content) : isPdfDocument(content) ? renderPdfDocumentSummary(content) : renderLatestChapterRows(content)}
        </div>
      </div>
    </article>
  `;
}

export function renderHomeView(): string {
  const contents = getReleaseContents();

  if (state.search && contents.length === 0) {
    return renderNoSearchResults();
  }

  return `
    <section class="section-heading">
      <div>
        <h2>Lançamentos</h2>
        <p class="muted">Obras ordenadas pelos capítulos atualizados mais recentemente.</p>
      </div>
      <div class="home-layout-toggle" role="group" aria-label="Modo de exibição dos lançamentos">
        ${renderHomeLayoutButton("grid", "grade", "grid")}
        ${renderHomeLayoutButton("list", "lista", "readerVertical")}
      </div>
    </section>
    ${
      contents.length
        ? state.homeLayout === "list"
          ? `<section class="home-list">${contents.map(renderHomeListItem).join("")}</section>`
          : `<section class="content-grid">${contents.map((content, index) => renderSeriesCard(content, `home-${content.id}-${index}`)).join("")}</section>`
        : renderEmptyMedia()
    }
  `;
}
