import { api } from '../services/api.js';
import { buildRoute } from '../router.js';
const escape = (value) => value.replaceAll('&', '&amp;').replaceAll('<', '&lt;').replaceAll('>', '&gt;').replaceAll('"', '&quot;').replaceAll("'", '&#039;');
const titleLink = (item) => `<a class="button secondary" data-rpg-open="${escape(item.id)}" href="${escape(buildRoute({ kind: 'title', libraryId: item.libraryId, contentId: item.id }))}">${escape(item.title)}</a>`;
export async function bindRpgPanel(root, content, admin, open) {
    const endpoint = `/api/contents/${encodeURIComponent(content.id)}/rpg`;
    const load = async () => {
        try {
            const details = await api(endpoint);
            if (!root.isConnected)
                return;
            render(details);
        }
        catch (error) {
            if (root.isConnected) {
                root.textContent = error instanceof Error ? error.message : 'Não foi possível carregar as fichas.';
                const retry = document.createElement('button');
                retry.type = 'button';
                retry.textContent = 'Tentar novamente';
                retry.onclick = () => void load();
                root.append(retry);
            }
        }
    };
    const render = (details) => {
        const { document: doc, copy } = details;
        const section = (title, items, empty) => `<section class="rpg-related"><h3>${title}</h3><div class="rpg-material-links">${items.length ? items.map(titleLink).join('') : `<p class="muted">${empty}</p>`}</div></section>`;
        const templates = details.templates.map(item => `<div class="rpg-template-row">${titleLink(item)}<button class="button" type="button" data-rpg-create="${escape(item.id)}">Criar minha ficha</button></div>`).join('');
        const modules = details.documents.filter(item => item.role === 'module');
        root.innerHTML = `
      ${copy ? `<header class="rpg-access-summary"><div><span class="rpg-access-eyebrow">Acesso à ficha</span><h2>${copy.visibility === 'private' ? 'Ficha privada' : copy.visibility === 'shared' ? 'Compartilhada com pessoas selecionadas' : 'Visível para todos da biblioteca'}</h2><p>Proprietário: <strong>${escape(copy.ownerDisplayName)}</strong></p></div><span class="rpg-access-badge">${copy.visibility === 'private' ? 'Privada' : 'Compartilhada'}</span></header>` : content.formOwnerUserId ? '<header class="rpg-access-summary"><div><span class="rpg-access-eyebrow">Acesso à ficha</span><h2>Compartilhada para leitura</h2><p>A edição é reservada ao proprietário e aos administradores.</p></div></header>' : ''}
      ${doc?.role === 'template' ? '<p class="rpg-preservation-note">Modelo original compartilhado. Ao salvar o preenchimento, será criada uma ficha privada para você.</p><button type="button" class="button" data-rpg-create="' + escape(content.id) + '">Criar minha ficha</button>' : ''}
      ${doc?.role === 'module' ? `<h2>Fichas deste módulo</h2><section class="rpg-related"><h3>Modelos originais</h3>${templates || '<p class="muted">Nenhum modelo vinculado. O administrador pode selecionar os modelos nas propriedades abaixo.</p>'}</section>` : ''}
      ${details.modules.length ? section('Módulos', details.modules, '') : ''}
      ${doc ? section('Minhas fichas', details.mySheets, 'Você ainda não criou fichas para este material.') + section('Fichas compartilhadas', details.sharedSheets, 'Nenhuma outra ficha disponível para você.') : ''}
      ${details.canManage ? `<details class="rpg-properties"><summary>${copy ? 'Propriedade e compartilhamento da ficha' : 'Organizar material de RPG'}</summary>
        <form class="rpg-properties-form">
        ${copy ? `
          ${admin ? `<label>Proprietário<select class="input" name="ownerUserId">${details.users.map(person => `<option value="${escape(person.id)}" ${person.id === copy.ownerUserId ? 'selected' : ''}>${escape(person.displayName)}</option>`).join('')}</select></label>` : ''}
          <label>Visibilidade<select class="input" name="visibility"><option value="private" ${copy.visibility === 'private' ? 'selected' : ''}>Somente eu</option><option value="shared" ${copy.visibility === 'shared' ? 'selected' : ''}>Pessoas selecionadas</option><option value="public" ${copy.visibility === 'public' ? 'selected' : ''}>Todos da biblioteca</option></select></label>
          <fieldset class="pdf-copy-sharing" data-rpg-sharing ${copy.visibility === 'shared' ? '' : 'hidden'}><legend>Permitir leitura para</legend>${details.users.filter(person => person.id !== copy.ownerUserId).map(person => `<label><input type="checkbox" name="sharedWithUserIds" value="${escape(person.id)}" ${copy.sharedWithUserIds.includes(person.id) ? 'checked' : ''}>${escape(person.displayName)}</label>`).join('')}</fieldset>
          <p class="muted">Somente o proprietário e administradores podem editar esta ficha. O compartilhamento permite apenas leitura.</p>
          <label>Módulo<select class="input" name="moduleId"><option value="">Sem módulo</option>${modules.map(item => `<option value="${escape(item.id)}" ${copy.moduleId === item.id ? 'selected' : ''}>${escape(item.title)}</option>`).join('')}</select></label>
        ` : `
          <label>Tipo de material<select class="input" name="role"><option value="">Material comum</option><option value="module" ${doc?.role === 'module' ? 'selected' : ''}>Módulo</option><option value="template" ${doc?.role === 'template' ? 'selected' : ''}>Modelo de ficha (original preservado)</option><option value="sheet">Ficha pessoal</option></select></label>
          <fieldset data-rpg-sheet hidden><legend>Ficha pessoal existente</legend><p>O arquivo será privado para o proprietário selecionado. Seu conteúdo será preservado.</p><label>Proprietário<select class="input" name="ownerUserId"><option value="">Selecione o proprietário</option>${details.users.map(person => `<option value="${escape(person.id)}">${escape(person.displayName)}</option>`).join('')}</select></label><label>Módulo<select class="input" name="moduleId"><option value="">Sem módulo</option>${modules.filter(item => item.contentId !== content.id).map(item => `<option value="${escape(item.id)}">${escape(item.title)}</option>`).join('')}</select></label></fieldset>
          <fieldset data-rpg-templates class="pdf-copy-sharing" ${doc?.role === 'module' ? '' : 'hidden'}><legend>Modelos deste módulo</legend>${details.documents.filter(item => item.role === 'template' && item.contentId !== content.id).map(item => `<label><input type="checkbox" name="templateIds" value="${escape(item.id)}" ${details.templateIds.includes(item.id) ? 'checked' : ''}>${escape(item.title)}</label>`).join('') || '<p>Primeiro classifique o PDF da ficha como modelo.</p>'}</fieldset>
        `}
        <button class="button" type="submit">Salvar propriedades</button><p role="status" aria-live="polite"></p></form></details>` : ''}
      <p data-rpg-status role="status" aria-live="polite"></p>`;
        root.querySelectorAll('[data-rpg-open]').forEach(link => link.onclick = event => {
            if (event.ctrlKey || event.metaKey || event.shiftKey || event.altKey)
                return;
            event.preventDefault();
            void open(link.dataset.rpgOpen);
        });
        root.querySelectorAll('[data-rpg-create]').forEach(button => button.onclick = async () => {
            const name = prompt('Nome da sua ficha (opcional):', '');
            if (name === null)
                return;
            const status = root.querySelector('[data-rpg-status]');
            button.disabled = true;
            status.textContent = 'Criando sua ficha privada…';
            try {
                const result = await api(`/api/contents/${encodeURIComponent(button.dataset.rpgCreate)}/pdf-form/copies`, { method: 'POST', body: JSON.stringify({ name, values: {}, ...(doc?.role === 'module' ? { moduleId: doc.id } : {}) }) });
                if (!result.content)
                    throw new Error('A ficha foi salva, mas a biblioteca ainda está atualizando. Recarregue a página.');
                window.dispatchEvent(new CustomEvent('pugotiread:pdf-copy-saved', { detail: result.content }));
                await open(result.content.id, true);
            }
            catch (error) {
                status.textContent = error instanceof Error ? error.message : 'Não foi possível criar a ficha.';
                button.disabled = false;
            }
        });
        const form = root.querySelector('form');
        root.hidden = !root.textContent?.trim();
        const visibility = form?.querySelector('[name=visibility]');
        if (visibility)
            visibility.onchange = () => { form.querySelector('[data-rpg-sharing]').hidden = visibility.value !== 'shared'; };
        const role = form?.querySelector('[name=role]');
        if (role)
            role.onchange = () => { form.querySelector('[data-rpg-templates]').hidden = role.value !== 'module'; form.querySelector('[data-rpg-sheet]').hidden = role.value !== 'sheet'; };
        if (form)
            form.onsubmit = async (event) => {
                event.preventDefault();
                const data = new FormData(form);
                const status = form.querySelector('[role=status]');
                const submit = form.querySelector('button[type=submit]');
                submit.disabled = true;
                status.textContent = 'Salvando…';
                try {
                    const body = copy ? { visibility: data.get('visibility'), sharedWithUserIds: data.getAll('sharedWithUserIds'), moduleId: data.get('moduleId') || null, ...(admin ? { ownerUserId: data.get('ownerUserId') } : {}) } : { role: data.get('role') || null, templateIds: data.getAll('templateIds'), ownerUserId: data.get('ownerUserId'), moduleId: data.get('moduleId') || null };
                    await api(endpoint, { method: 'PATCH', body: JSON.stringify(body) });
                    await load();
                    root.querySelector('[data-rpg-status]').textContent = 'Propriedades salvas.';
                }
                catch (error) {
                    status.textContent = error instanceof Error ? error.message : 'Não foi possível salvar.';
                    submit.disabled = false;
                }
            };
    };
    await load();
}
