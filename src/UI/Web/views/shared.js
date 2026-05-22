import { renderSeriesCard } from "../components/series-card.js";
import { filterContents } from "../services/search.js";
import { state } from "../state/store.js";
function escapeHtml(value) {
    return value
        .replaceAll("&", "&amp;")
        .replaceAll("<", "&lt;")
        .replaceAll(">", "&gt;")
        .replaceAll('"', "&quot;")
        .replaceAll("'", "&#039;");
}
export function renderEmptyMedia() {
    return `<p class="empty">Nenhum conteúdo encontrado. Monte suas mídias em /media e crie pastas dentro da biblioteca.</p>`;
}
export function renderNoSearchResults() {
    return `
    <section class="empty">
      <strong>Nenhum resultado encontrado</strong>
      <p>Não encontramos obras parecidas com "${escapeHtml(state.search)}". Confira a escrita ou tente buscar por uma parte menor do nome.</p>
    </section>
  `;
}
export function renderPlaceholderView(title, description) {
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
export function renderContentListView(title, description, contents) {
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
//# sourceMappingURL=shared.js.map