import type { ContentItem } from "../../../shared/types.js";
import { renderSeriesCard } from "../components/series-card.js";
import { filterContents } from "../services/search.js";
import { state } from "../state/store.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

export function renderEmptyMedia(): string {
  return `<p class="empty">Nenhum conteúdo encontrado. Monte suas mídias em /media e crie pastas dentro da biblioteca.</p>`;
}

export function renderNoSearchResults(): string {
  return `
    <section class="empty">
      <strong>Nenhum resultado encontrado</strong>
      <p>Não encontramos obras parecidas com "${escapeHtml(state.search)}". Confira a escrita ou tente buscar por uma parte menor do nome.</p>
    </section>
  `;
}

export function renderPlaceholderView(title: string, description: string): string {
  return `
    <section class="section-heading">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">${escapeHtml(description)}</p>
      </div>
    </section>
    <p class="empty">Base visual criada. A regra de dados desta área será implementada por etapa.</p>
  `;
}

export function renderContentListView(title: string, description: string, contents: ContentItem[]): string {
  const filtered = filterContents(contents, state.search);
  return `
    <section class="section-heading">
      <div>
        <h2>${escapeHtml(title)}</h2>
        <p class="muted">${escapeHtml(description)}</p>
      </div>
      <span class="muted">${filtered.length} títulos</span>
    </section>
    ${filtered.length ? `<section class="content-grid">${filtered.map((content, index) => renderSeriesCard(content, `list-${state.activeView}-${content.id}-${index}`)).join("")}</section>` : state.search ? renderNoSearchResults() : `<p class="empty">Nenhuma obra nesta área.</p>`}
  `;
}
