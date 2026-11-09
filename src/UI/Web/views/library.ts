import type { ContentItem, Library } from "../../../shared/types.js";
import { renderIcon } from "../components/icons.js";
import { renderLibraryContextMenu } from "../components/layout/sidebar.js";
import { renderSeriesCard } from "../components/series-card.js";
import { state } from "../state/store.js";
import { buildRoute } from '../router.js';
import { isRpgSheetFolder } from '../../../shared/rpg-folders.js';
import { renderEmptyMedia, renderNoSearchResults } from "./shared.js";

function escapeHtml(value: string): string {
  return value
    .replaceAll("&", "&amp;")
    .replaceAll("<", "&lt;")
    .replaceAll(">", "&gt;")
    .replaceAll('"', "&quot;")
    .replaceAll("'", "&#039;");
}

function renderContentCard(content: ContentItem, index: string | number): string {
  return renderSeriesCard(content, `library-${content.id}-${index}`);
}

type FolderNode = {
  contents: ContentItem[];
  children: Map<string, FolderNode>;
};

function createFolderNode(): FolderNode {
  return { contents: [], children: new Map() };
}

function isCharacterSheet(content: ContentItem): boolean {
  return Boolean(content.formOwnerUserId || content.formVisibility || content.rpgRole === 'template')
    || isRpgSheetFolder(content.system);
}

function renderFolderContents(node: FolderNode, depth: number, key: string, hideSheets = false): string {
  const cards = node.contents.filter(content => !hideSheets || !isCharacterSheet(content)).map((content, index) => renderContentCard(content, `${key}-${index}`)).join("");
  const children = [...node.children.entries()]
    .sort(([left], [right]) => left.localeCompare(right, "pt-BR"))
    .map(([name, child]) => {
      const body = renderFolderContents(child, depth + 1, `${key}-${name}`, hideSheets);
      return body ? `
      <section class="library-folder-section" data-folder-depth="${depth}">
        <h${Math.min(3 + depth, 6)}>${escapeHtml(name)}</h${Math.min(3 + depth, 6)}>
        ${body}
      </section>` : '';
    })
    .join("");
  return `${cards ? `<div class="content-grid">${cards}</div>` : ""}${children}`;
}

export function renderLibraryView(activeLibrary: Library | undefined, contents: ContentItem[]): string {
  const isLoading = Boolean(activeLibrary && state.loadingLibraryId === activeLibrary.id);
  const emptyMessage = state.libraryLoadError
    ? `<p class="empty">${escapeHtml(state.libraryLoadError)}</p>`
    : isLoading
      ? `<p class="empty">Carregando biblioteca...</p>`
      : state.search
        ? renderNoSearchResults()
        : renderEmptyMedia();

  const folders = createFolderNode();
  for (const content of contents) {
    const parts = (content.system ?? "").split(/[\\/]+/).map(part => part.trim()).filter(Boolean);
    let current = folders;
    for (const part of parts) {
      const next = current.children.get(part) ?? createFolderNode();
      current.children.set(part, next);
      current = next;
    }
    current.contents.push(content);
  }
  const isRpg = activeLibrary?.kind === 'other';
  const folder = isRpg ? state.activeLibraryFolder : '';
  const hideSheets = isRpg && !folder;
  const visibleCount = hideSheets ? contents.filter(content => !isCharacterSheet(content)).length : contents.length;
  let selected = folders;
  let found = true;
  for (const part of folder.split('/').filter(Boolean)) {
    const child = selected.children.get(part);
    if (!child) { found = false; break; }
    selected = child;
  }
  const folderLink = (path: string, label: string, active = false) => `<a class="library-folder-link${active ? ' active' : ''}" ${active ? 'aria-current="page"' : ''} data-library-folder="${escapeHtml(path)}" href="${escapeHtml(buildRoute({kind:'library',libraryId:activeLibrary!.id,folder:path}))}">${escapeHtml(label)}</a>`;
  const tabs = isRpg && folders.children.size ? `<nav class="library-system-tabs" aria-label="Sistemas de RPG">${folderLink('','Todos',!folder)}${[...folders.children.keys()].sort((a,b)=>a.localeCompare(b,'pt-BR')).map(name => folderLink(name,name,folder.split('/')[0] === name)).join('')}</nav>` : '';
  const breadcrumbs = folder ? `<nav class="library-breadcrumbs" aria-label="Caminho da pasta">${folderLink('',activeLibrary!.name)}${folder.split('/').map((name,index,parts)=>`<span aria-hidden="true">›</span>${folderLink(parts.slice(0,index+1).join('/'),name,index===parts.length-1)}`).join('')}</nav>` : '';
  const contentSections = folder
    ? found ? `${breadcrumbs}<nav class="library-subfolders" aria-label="Subpastas">${[...selected.children.keys()].sort((a,b)=>a.localeCompare(b,'pt-BR')).map(name=>folderLink(`${folder}/${name}`,name)).join('')}</nav>${selected.contents.length ? `<div class="content-grid">${selected.contents.map((item,index)=>renderContentCard(item,index)).join('')}</div>` : '<p class="empty">Selecione uma subpasta para ver os materiais.</p>'}`
      : `${breadcrumbs}<p class="empty">Esta pasta não possui materiais disponíveis${state.search ? ' para esta busca' : ''}.</p>`
    : renderFolderContents(folders, 0, "library", hideSheets);

  return `
    <section class="library-heading">
      <div class="library-title-row">
        <h2>${escapeHtml(activeLibrary?.name ?? "Biblioteca")}</h2>
        ${
          state.user?.role === "admin" && activeLibrary
            ? `
              <span class="inline-menu-shell">
                <button class="inline-more" data-library-menu-id="${activeLibrary.id}" type="button">${renderIcon("moreVertical")}</button>
                ${state.openLibraryMenuId === activeLibrary.id ? renderLibraryContextMenu(activeLibrary) : ""}
              </span>
            `
            : ""
        }
      </div>
      <p>${visibleCount} ${isRpg ? visibleCount === 1 ? 'material' : 'materiais' : visibleCount === 1 ? "série" : "séries"}</p>
      ${tabs}
    </section>
    ${
      visibleCount
        ? contentSections
        : hideSheets && contents.length ? '<p class="empty">As fichas estão disponíveis nas abas de cada sistema.</p>' : emptyMessage
    }
  `;
}
