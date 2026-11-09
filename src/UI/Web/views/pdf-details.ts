import type {ContentItem, Library, ReadingProgress} from '../../../shared/types.js';
import {renderIcon} from '../components/icons.js';
import {buildRoute} from '../router.js';

const escape=(value:string)=>value.replaceAll('&','&amp;').replaceAll('<','&lt;').replaceAll('>','&gt;').replaceAll('"','&quot;').replaceAll("'",'&#039;');

export function renderPdfDetails(content:ContentItem, library:Library|undefined, progress:ReadingProgress|null, marked:boolean, bookmarks:string, bookmarkCount:number):string {
  const total=Math.max(0,content.pageCount);
  const page=progress ? Math.min(Math.max(1,progress.currentPage+1),total || 1) : 0;
  const percent=total && page ? Math.round(page/total*100) : 0;
  const isForm=Boolean(content.formOwnerUserId) || content.rpgRole==='template';
  const kind=content.formOwnerUserId ? 'Ficha pessoal' : content.rpgRole==='template' ? 'Modelo de ficha' : content.rpgRole==='module' ? 'Módulo de RPG' : 'Documento';
  const parts=(content.system ?? '').split(/[\\/]+/).filter(Boolean);
  const crumbs=[{name:library?.name ?? 'Biblioteca',folder:''},...parts.map((name,i)=>({name,folder:parts.slice(0,i+1).join('/')}))];
  return `<section class="pdf-document-detail">
    <button class="series-back-link" data-series-back type="button">${renderIcon('back')}<span>Voltar à biblioteca</span></button>
    <div class="pdf-document-hero">
      <div class="pdf-document-preview">${content.coverUrl ? `<img src="${escape(content.coverUrl)}" alt="Prévia de ${escape(content.title)}">` : `<div class="pdf-document-placeholder">${renderIcon('file')}<span>PDF</span></div>`}<span class="pdf-document-preview-label">Prévia do documento</span></div>
      <div class="pdf-document-info">
        <div class="pdf-document-kicker"><span>PDF</span><span>${kind}</span></div>
        <h1>${escape(content.title)}</h1>
        <nav class="pdf-document-location" aria-label="Localização do documento">${crumbs.map((item,i)=>`${i?'<span aria-hidden="true">/</span>':''}<a data-library-folder="${escape(item.folder)}" href="${escape(buildRoute({kind:'library',libraryId:content.libraryId,...(library?.kind==='other'?{folder:item.folder}:{})}))}">${escape(item.name)}</a>`).join('')}</nav>
        <div class="pdf-document-facts"><span>${renderIcon('file')} ${total || '—'} ${total===1?'página':'páginas'}</span><span>${renderIcon('author')} Autor(es): ${escape(content.authors?.filter(name=>name.trim()).join(', ') || 'N/A')}</span><span>${renderIcon('bookmarks')} ${bookmarkCount} ${bookmarkCount===1?'marcador':'marcadores'}</span></div>
        <div class="pdf-document-actions">
          <button class="button" type="button" data-series-continue="${escape(content.id)}">${renderIcon('continue')} ${content.formOwnerUserId?'Abrir ficha':progress?'Continuar leitura':'Abrir PDF'}</button>
          ${progress && page>1?`<button class="button secondary" type="button" data-chapter-open="${escape(content.id)}" data-chapter-start="0">Do início</button>`:''}
          <button class="button secondary${marked?' active-mark':''}" type="button" data-series-mark-toggle="${escape(content.id)}" aria-pressed="${marked}">${renderIcon(marked?'ratingFilled':'rating')} ${marked?'Favoritado':'Favoritar'}</button>
        </div>
        ${!isForm || progress && total>1?`<div class="pdf-document-reading"><div><span>${progress?`Última página ${isForm?'consultada':'aberta'} <strong>${page}</strong> de ${total || '—'}`:'Pronto para abrir'}</span>${progress && !isForm?`<span>${percent}%</span>`:''}</div>${progress && !isForm?`<progress max="100" value="${percent}" aria-label="Posição de leitura: ${percent}%"></progress>`:''}</div>`:''}
        ${content.description?`<section class="pdf-document-description"><h2>Sobre o documento</h2><p>${escape(content.description)}</p></section>`:''}
      </div>
    </div>
    ${library?.kind==='other'?'<section class="rpg-panel" data-rpg-panel><p class="muted">Carregando informações do material…</p></section>':''}
    <section class="pdf-document-bookmarks"><header><div>${renderIcon('bookmarks')}<h2>Páginas marcadas</h2></div><span>${bookmarkCount}</span></header>${bookmarkCount?bookmarks:'<p class="muted">Marque páginas durante a leitura para encontrá-las aqui.</p>'}</section>
  </section>`;
}
