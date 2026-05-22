import { renderLibraryContextMenu } from "../components/layout/sidebar.js";
import { renderSeriesCard } from "../components/series-card.js";
import { state } from "../state/store.js";
import { renderEmptyMedia, renderNoSearchResults } from "./shared.js";
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
function renderContentCard(content, index) {
    return renderSeriesCard(content, `library-${content.id}-${index}`);
}
export function renderLibraryView(activeLibrary, contents) {
    const isLoading = Boolean(activeLibrary && state.loadingLibraryId === activeLibrary.id);
    const emptyMessage = state.libraryLoadError
        ? `<p class="empty">${escapeHtml(state.libraryLoadError)}</p>`
        : isLoading
            ? `<p class="empty">Carregando biblioteca...</p>`
            : state.search
                ? renderNoSearchResults()
                : renderEmptyMedia();
    return `
    <section class="library-heading">
      <div class="library-title-row">
        <h2>${escapeHtml(activeLibrary?.name ?? "Biblioteca")}</h2>
        ${state.user?.role === "admin" && activeLibrary
        ? `
              <span class="inline-menu-shell">
                <button class="inline-more" data-library-menu-id="${activeLibrary.id}" type="button">⋮</button>
                ${state.openLibraryMenuId === activeLibrary.id ? renderLibraryContextMenu(activeLibrary) : ""}
              </span>
            `
        : ""}
      </div>
      <p>${contents.length} ${contents.length === 1 ? "série" : "séries"}</p>
    </section>
    ${contents.length
        ? `<section class="content-grid">${contents.map(renderContentCard).join("")}</section>`
        : emptyMessage}
  `;
}
//# sourceMappingURL=library.js.map