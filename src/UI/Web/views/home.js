import { renderSeriesCard } from "../components/series-card.js";
import { filterContents } from "../services/search.js";
import { state } from "../state/store.js";
import { renderNoSearchResults } from "./shared.js";
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
function getFilteredHomeContents() {
    return filterContents(state.homeContents, state.search);
}
function renderShelf(title, contents, emptyText) {
    return `
    <section class="shelf">
      <h2>${escapeHtml(title)}</h2>
      ${contents.length
        ? `<div class="shelf-row">${contents.map((content, index) => renderSeriesCard(content, `shelf-${title}-${content.id}-${index}`)).join("")}</div>`
        : `<p class="empty">${escapeHtml(emptyText)}</p>`}
    </section>
  `;
}
export function renderHomeView() {
    const contents = getFilteredHomeContents();
    const reading = state.progress
        .map((progress) => contents.find((content) => content.id === progress.contentId))
        .filter((content) => Boolean(content));
    const onDeck = reading.length > 0 ? reading.slice(0, 8) : contents.slice(0, 5);
    const recentlyAdded = contents.slice(0, 12);
    if (state.search && contents.length === 0) {
        return renderNoSearchResults();
    }
    return `
    ${renderShelf("Lendo agora", onDeck, reading.length === 0 ? "Comece uma leitura para fixar progresso aqui." : "")}
    ${renderShelf("Séries adicionadas recentemente", recentlyAdded, "Monte suas mídias em /media para popular esta galeria.")}
  `;
}
//# sourceMappingURL=home.js.map