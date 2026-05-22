import type { ContentItem } from "../../../shared/types.js";
import { renderSeriesCard } from "../components/series-card.js";
import { filterContents } from "../services/search.js";
import { state } from "../state/store.js";
import { renderEmptyMedia, renderNoSearchResults } from "./shared.js";

function getFilteredHomeContents(): ContentItem[] {
  return filterContents(state.homeContents, state.search);
}

export function renderHomeView(): string {
  const contents = getFilteredHomeContents();

  if (state.search && contents.length === 0) {
    return renderNoSearchResults();
  }

  return `
    <section class="section-heading">
      <div>
        <h2>Obras disponíveis</h2>
        <p class="muted">Todos os conteúdos disponíveis nas bibliotecas permitidas.</p>
      </div>
      <span class="muted">${contents.length} títulos</span>
    </section>
    ${contents.length ? `<section class="content-grid">${contents.map((content, index) => renderSeriesCard(content, `home-${content.id}-${index}`)).join("")}</section>` : renderEmptyMedia()}
  `;
}
