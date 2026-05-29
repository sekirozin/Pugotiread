import type { ContentItem } from "../../../shared/types.js";
import { renderIcon } from "../components/icons.js";
import { renderSeriesCard } from "../components/series-card.js";
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
  return content.chapters
    .filter((chapter) => !chapter.isSpecial)
    .reduce((latest, chapter) => Math.max(latest, getChapterUpdatedAt(chapter)), 0);
}

function getReleaseContents(): ContentItem[] {
  return getFilteredHomeContents()
    .map((content) => ({ content, updatedAt: getContentLatestUpdateAt(content) }))
    .filter((item) => item.updatedAt > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt || a.content.title.localeCompare(b.content.title, "pt-BR"))
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
    .map((chapter) => ({ chapter, updatedAt: getChapterUpdatedAt(chapter) }))
    .filter((item) => item.updatedAt > 0)
    .sort((a, b) => b.updatedAt - a.updatedAt || b.chapter.startPage - a.chapter.startPage)
    .slice(0, 3)
    .map((item) => item.chapter);

  if (latestChapters.length === 0) {
    return `<p class="home-list-empty">Nenhum capítulo encontrado.</p>`;
  }

  return latestChapters.map((chapter) => `
    <button class="home-list-chapter${isRecentlyUpdatedChapter(chapter) ? " recent-update" : ""}" data-chapter-open="${escapeHtml(content.id)}" data-chapter-start="${chapter.startPage}" type="button" aria-label="Abrir ${escapeHtml(chapter.name)} de ${escapeHtml(content.title)}">
      <span class="chapter-status-dot" aria-hidden="true"></span>
      <span class="home-list-chapter-name">${escapeHtml(chapter.name)}</span>
      <span class="home-list-chapter-meta">${chapter.pageCount} pág.</span>
    </button>
  `).join("");
}

function renderHomeListItem(content: ContentItem, index: number): string {
  const hasRecentUpdate = hasRecentlyUpdatedChapters(content.chapters);
  return `
    <article class="home-list-item${hasRecentUpdate ? " recent-update" : ""}">
      <button class="home-list-cover" data-series-open="${escapeHtml(content.id)}" type="button" aria-label="Abrir ${escapeHtml(content.title)}">
        ${
          content.coverUrl
            ? `<img src="${escapeHtml(content.coverUrl)}" alt="Capa de ${escapeHtml(content.title)}" loading="${index < 3 ? "eager" : "lazy"}" />`
            : `<span>${escapeHtml(content.title.slice(0, 1).toUpperCase())}</span>`
        }
      </button>
      <div class="home-list-main">
        <button class="home-list-title" data-series-open="${escapeHtml(content.id)}" type="button">${escapeHtml(content.title)}</button>
        <div class="home-list-chapters">
          ${renderLatestChapterRows(content)}
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
