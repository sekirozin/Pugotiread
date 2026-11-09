import { RichPage } from './pdf-rich-text.js';
import { parseRoute, buildRoute } from './router.js';
import { EditHistory } from './pdf-edit-history.js';
async function api(url, init) {
    const client = await import("./services/api.js");
    return client.api(url, init);
}
const editDrafts = new Map();
// Drafts survive page virtualization, zoom and returning to the same document.
const drafts = new Map();
const styleDrafts = new Map();
const dirty = new Set();
if (typeof window !== "undefined")
    window.addEventListener("beforeunload", event => {
        if (dirty.size) {
            event.preventDefault();
            event.returnValue = "";
        }
    });
export function clearPdfFormDrafts() { drafts.clear(); styleDrafts.clear(); editDrafts.clear(); dirty.clear(); }
export class PdfFormEditor {
    root;
    contentId;
    preview;
    currentPage;
    schema = null;
    editing = false;
    disposed = false;
    saving = false;
    button = document.createElement("button");
    panel = document.createElement("form");
    status = document.createElement("p");
    name = document.createElement("input");
    save = document.createElement("button");
    update = document.createElement('button');
    actions = document.createElement("div");
    values;
    styles;
    stylePanel = document.createElement("fieldset");
    styleFont = document.createElement("select");
    styleSize = document.createElement("input");
    styleColor = document.createElement("input");
    styleAlignment = document.createElement("input");
    alignmentButtons = new Map();
    bulkTextPanel = document.createElement("div");
    bulkText = document.createElement("input");
    selectedTextFields = new Set();
    activeTextField = null;
    richPages = new Map();
    richButtons = new Map();
    richStyle = null;
    ignoreNextFocusSelection = false;
    pages = new Map();
    edits;
    history = new EditHistory();
    undoButton = document.createElement('button');
    redoButton = document.createElement('button');
    insertTextButton = document.createElement('button');
    placingText = false;
    focusAfterRender = null;
    listeners = new AbortController();
    constructor(root, contentId, preview, currentPage) {
        this.root = root;
        this.contentId = contentId;
        this.preview = preview;
        this.currentPage = currentPage;
        this.edits = editDrafts.get(contentId) ?? [];
        editDrafts.set(contentId, this.edits);
        this.values = drafts.get(contentId) ?? Object.create(null);
        drafts.set(contentId, this.values);
        this.styles = styleDrafts.get(contentId) ?? Object.create(null);
        styleDrafts.set(contentId, this.styles);
        this.button.type = "button";
        this.button.textContent = "Editar PDF";
        this.button.disabled = true;
        this.button.title = "Preparando editor…";
        this.button.className = "pdf-form-toggle";
        root.querySelector(".reader-pdf-side-toolbar")?.append(this.button);
        this.panel.className = "pdf-form-panel";
        this.panel.hidden = true;
        const heading = document.createElement("strong");
        heading.className = "pdf-form-editor-title";
        heading.textContent = "Editar PDF";
        const note = document.createElement("p");
        note.className = "pdf-form-editor-note";
        note.textContent = "Página nova: digite dentro das margens • Texto: adicionar caixa • Shift + clique: selecionar vários campos • Salvar atualiza este PDF";
        const label = document.createElement("label");
        label.className = "pdf-form-name";
        label.textContent = "Nome";
        this.name.maxLength = 160;
        this.name.placeholder = "Ex.: Mephisto - Tormenta RPG";
        label.append(this.name);
        this.save.type = "button";
        this.save.className = "pdf-form-save-copy";
        this.save.textContent = "Salvar como nova cópia";
        this.save.onclick = () => void this.saveCopy();
        this.update.type = 'submit';
        this.update.className = "pdf-form-save";
        this.update.textContent = 'Salvar';
        const close = document.createElement("button");
        close.type = "button";
        close.className = "pdf-form-close";
        close.textContent = "Fechar edição";
        close.onclick = () => this.closeEditor();
        const discard = document.createElement("button");
        discard.type = "button";
        discard.className = "pdf-form-discard";
        discard.textContent = "Descartar";
        discard.onclick = async () => {
            if (this.saving || !confirm("Descartar os valores ainda não salvos?"))
                return;
            const before = this.snapshot();
            for (const key of Object.keys(this.values))
                delete this.values[key];
            for (const key of Object.keys(this.styles))
                delete this.styles[key];
            this.edits.splice(0);
            if (await this.reloadPreview()) {
                this.history.record(before);
                dirty.delete(this.contentId);
                this.status.textContent = "Edições descartadas.";
            }
            else
                this.restore(before);
            this.syncHistory();
        };
        this.status.setAttribute("role", "status");
        this.createStyleControls();
        this.actions.className = "pdf-form-actions";
        this.actions.append(this.update, this.save, discard, close);
        const header = document.createElement("div");
        header.className = "pdf-form-header";
        header.append(heading, label, this.actions);
        this.panel.append(header, this.createDocumentControls(), this.stylePanel, note, this.status);
        const icons = [
            [this.update, "Salvar", "M5 3h12l4 4v14H3V3h2M7 3v6h10V3M7 21v-8h10v8"],
            [this.save, "Salvar como nova cópia", "M8 7V3h13v14h-4M3 7h14v14H3zM7 11h6M7 15h6"],
            [discard, "Descartar preenchimento", "M4 7h16M9 7V3h6v4M6 7l1 14h10l1-14M10 11v6M14 11v6"],
            [close, "Fechar edição", "M6 6l12 12M6 18L18 6"]
        ];
        for (const [button, title, path] of icons) {
            button.title = title;
            button.setAttribute("aria-label", title);
            button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" stroke-linecap="round" stroke-linejoin="round" aria-hidden="true"><path d="${path}"/></svg>`;
        }
        this.syncStylePanel();
        root.append(this.panel);
        this.button.onclick = () => {
            this.editing = true;
            this.panel.hidden = false;
            this.root.classList.add("pdf-form-editing");
            this.refresh();
            window.dispatchEvent(new Event("resize"));
        };
        this.panel.onsubmit = event => { event.preventDefault(); void this.changeExisting(this.name.value); };
        this.name.addEventListener('beforeinput', () => this.checkpoint());
        this.name.addEventListener('input', () => dirty.add(this.contentId));
        root.addEventListener('keydown', event => {
            if (!this.editing || this.saving || !(event.ctrlKey || event.metaKey) || event.altKey)
                return;
            if (event.key.toLowerCase() === 'z' || event.key.toLowerCase() === 'y') {
                event.preventDefault();
                event.stopPropagation();
                void this.travel(event.shiftKey || event.key.toLowerCase() === 'y');
            }
        }, { capture: true, signal: this.listeners.signal });
        void this.detect();
    }
    snapshot() { return structuredClone({ values: this.values, styles: this.styles, edits: this.edits, name: this.name.value }); }
    restore(state) {
        for (const key of Object.keys(this.values))
            delete this.values[key];
        for (const key of Object.keys(this.styles))
            delete this.styles[key];
        Object.assign(this.values, state.values);
        Object.assign(this.styles, state.styles);
        this.edits.splice(0, this.edits.length, ...state.edits);
        this.name.value = state.name;
        this.selectedTextFields.clear();
        this.activeTextField = null;
        dirty.add(this.contentId);
        this.syncStylePanel();
        this.refresh();
    }
    checkpoint() { this.history.record(this.snapshot()); this.syncHistory(); }
    syncHistory() { this.undoButton.disabled = this.saving || !this.history.canUndo; this.redoButton.disabled = this.saving || !this.history.canRedo; }
    async travel(forward) {
        if (this.saving)
            return;
        const focusedField = document.activeElement?.dataset.pdfFormField;
        const before = this.snapshot();
        const next = forward ? this.history.redo(before) : this.history.undo(before);
        if (!next)
            return;
        this.restore(next);
        this.focusAfterRender = focusedField ?? null;
        if (!await this.reloadPreview()) {
            forward ? this.history.undo(next) : this.history.redo(next);
            this.restore(before);
        }
        this.syncHistory();
    }
    createDocumentControls() {
        const group = document.createElement('div');
        group.className = 'pdf-document-tools';
        const tool = (button, label, icon, action) => {
            button.type = 'button';
            button.title = label;
            button.setAttribute('aria-label', label);
            button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.7" aria-hidden="true"><path d="${icon}"/></svg><span>${label}</span>`;
            button.onclick = action;
            group.append(button);
        };
        tool(this.undoButton, 'Desfazer', 'M9 5L3 11l6 6M3 11h11a6 6 0 016 6', () => void this.travel(false));
        tool(this.redoButton, 'Refazer', 'M15 5l6 6-6 6M21 11H10a6 6 0 00-6 6', () => void this.travel(true));
        tool(this.insertTextButton, 'Texto', 'M4 5h16M12 5v15M8 20h8', () => {
            this.placingText = !this.placingText;
            this.insertTextButton.setAttribute('aria-pressed', String(this.placingText));
            this.root.classList.toggle('pdf-placing-text', this.placingText);
            this.status.textContent = this.placingText ? 'Clique ou toque na página onde deseja digitar.' : '';
        });
        for (const [position, label] of [['start', 'Página no início'], ['end', 'Página no fim']]) {
            tool(document.createElement('button'), label, 'M14 2H4v20h16V8zM14 2v6h6M8 15h8M12 11v8', () => { const name = 'pugoti_body_' + Array.from(crypto.getRandomValues(new Uint8Array(16)), b => b.toString(16).padStart(2, '0')).join(''); this.focusAfterRender = name; void this.mutate({ kind: 'insert', position, name }, position === 'start' ? 1 : (this.schema?.pageCount ?? 0) + 1); });
        }
        tool(document.createElement('button'), 'Excluir página', 'M4 7h16M9 7V3h6v4M6 7l1 14h10l1-14', () => {
            const page = this.currentPage();
            if ((this.schema?.pageCount ?? 0) <= 1) {
                this.status.textContent = 'O PDF precisa ter pelo menos uma página.';
                return;
            }
            if (confirm(`Excluir a página ${page}? Você poderá desfazer antes de salvar.`))
                void this.mutate({ kind: 'delete', page }, page);
        });
        this.syncHistory();
        return group;
    }
    async mutate(edit, page) {
        if (this.saving)
            return;
        const before = this.snapshot();
        this.edits.push(edit);
        if (await this.reloadPreview(page)) {
            this.history.record(before);
            dirty.add(this.contentId);
        }
        else
            this.restore(before);
        this.syncHistory();
    }
    async reloadPreview(page = this.currentPage()) {
        if (!this.schema || this.disposed)
            return false;
        this.saving = true;
        this.placingText = false;
        this.root.classList.remove('pdf-placing-text');
        this.insertTextButton.setAttribute('aria-pressed', 'false');
        this.panel.setAttribute('aria-busy', 'true');
        this.panel.querySelectorAll('input,button,select').forEach(control => control.disabled = true);
        this.refresh();
        this.status.textContent = 'Preparando prévia…';
        try {
            const result = await api(`/api/contents/${encodeURIComponent(this.contentId)}/pdf-form/preview`, { method: 'POST', body: JSON.stringify({ revision: this.schema.revision, values: this.values, styles: this.styles, edits: this.edits }) });
            if (this.disposed)
                return false;
            const url = URL.createObjectURL(new Blob([Uint8Array.from(atob(result.pdf), c => c.charCodeAt(0))], { type: 'application/pdf' }));
            try {
                await this.preview(url, Math.max(1, Math.min(page, result.schema.pageCount)));
            }
            finally {
                URL.revokeObjectURL(url);
            }
            this.schema = result.schema;
            this.activeTextField = this.schema.fields.find(field => this.selectedTextFields.has(field.name)) ?? null;
            this.status.textContent = 'Alterações ainda não salvas.';
            return true;
        }
        catch (error) {
            this.status.textContent = error instanceof Error ? error.message : 'Falha ao preparar prévia.';
            return false;
        }
        finally {
            this.saving = false;
            this.panel.setAttribute('aria-busy', 'false');
            this.panel.querySelectorAll('input,button,select').forEach(control => control.disabled = false);
            if (!this.disposed) {
                this.syncStylePanel();
                this.syncHistory();
                this.refresh();
            }
        }
    }
    closeEditor() {
        this.placingText = false;
        this.root.classList.remove('pdf-placing-text');
        this.editing = false;
        this.panel.hidden = true;
        this.root.classList.remove("pdf-form-editing");
        this.refresh();
        window.dispatchEvent(new Event("resize"));
    }
    createStyleControls() {
        this.stylePanel.className = "pdf-form-style-panel";
        this.stylePanel.hidden = false;
        const legend = document.createElement("legend");
        legend.textContent = "Estilo do campo";
        legend.dataset.pdfFormStyleLegend = "true";
        const fontLabel = document.createElement("label");
        fontLabel.className = "pdf-form-style-font";
        fontLabel.textContent = "Fonte";
        this.styleFont.id = "pdf-form-style-font";
        fontLabel.htmlFor = this.styleFont.id;
        [["helvetica", "Helvetica"], ["times", "Times"], ["courier", "Courier"]].forEach(([value, label]) => this.styleFont.add(new Option(label, value)));
        fontLabel.append(this.styleFont);
        const sizeLabel = document.createElement("label");
        sizeLabel.className = "pdf-form-style-size";
        sizeLabel.textContent = "Tamanho";
        this.styleSize.id = "pdf-form-style-size";
        sizeLabel.htmlFor = this.styleSize.id;
        this.styleSize.type = "number";
        this.styleSize.min = "4";
        this.styleSize.max = "72";
        this.styleSize.step = "0.5";
        sizeLabel.append(this.styleSize);
        const colorLabel = document.createElement("label");
        colorLabel.className = "pdf-form-style-color";
        colorLabel.textContent = "Cor";
        this.styleColor.id = "pdf-form-style-color";
        colorLabel.htmlFor = this.styleColor.id;
        this.styleColor.type = "color";
        colorLabel.append(this.styleColor);
        const alignmentLabel = document.createElement("div");
        alignmentLabel.className = "pdf-form-style-alignment";
        const alignmentTitle = document.createElement("span");
        alignmentTitle.textContent = "Alinhamento";
        const alignmentGroup = document.createElement("div");
        alignmentGroup.className = "pdf-form-alignment-buttons";
        alignmentGroup.setAttribute("role", "group");
        alignmentGroup.setAttribute("aria-label", "Alinhamento");
        this.styleAlignment.type = "hidden";
        this.styleAlignment.id = "pdf-form-style-alignment";
        [
            ["left", "Alinhar à esquerda", '<path d="M4 6h16M4 10h10M4 14h16M4 18h10"/>'],
            ["center", "Centralizar", '<path d="M4 6h16M7 10h10M4 14h16M7 18h10"/>'],
            ["right", "Alinhar à direita", '<path d="M4 6h16M10 10h10M4 14h16M10 18h10"/>']
        ].forEach(([value, label, paths]) => {
            const button = document.createElement("button");
            button.type = "button";
            button.title = label;
            button.setAttribute("aria-label", label);
            button.dataset.pdfFormAlignment = value;
            button.innerHTML = `<svg viewBox="0 0 24 24" aria-hidden="true" fill="none" stroke="currentColor" stroke-width="1.8" stroke-linecap="round">${paths}</svg>`;
            button.onclick = () => { this.styleAlignment.value = value; this.syncAlignmentButtons(); this.updateActiveTextStyle(); };
            this.alignmentButtons.set(value, button);
            alignmentGroup.append(button);
        });
        alignmentLabel.append(alignmentTitle, alignmentGroup, this.styleAlignment);
        this.bulkTextPanel.className = "pdf-form-bulk-text";
        this.bulkTextPanel.hidden = true;
        const bulkLabel = document.createElement("label");
        bulkLabel.textContent = "Texto para os campos selecionados";
        this.bulkText.id = "pdf-form-bulk-text";
        this.bulkText.placeholder = "Aplicar o mesmo texto";
        bulkLabel.htmlFor = this.bulkText.id;
        bulkLabel.append(this.bulkText);
        const bulkApply = document.createElement("button");
        bulkApply.type = "button";
        bulkApply.textContent = "Aplicar texto";
        bulkApply.onclick = () => this.applyBulkText();
        this.bulkTextPanel.append(bulkLabel, bulkApply);
        for (const control of [this.styleFont, this.styleSize, this.styleColor])
            control.onchange = () => this.updateActiveTextStyle();
        const resizeGroup = document.createElement("div");
        resizeGroup.className = "pdf-form-font-steps";
        for (const [delta, title] of [[1, "Aumentar fonte"], [-1, "Diminuir fonte"]]) {
            const button = document.createElement("button");
            button.type = "button";
            button.title = title;
            button.setAttribute("aria-label", title);
            button.innerHTML = `<svg viewBox="0 0 24 24" fill="none" stroke="currentColor" stroke-width="1.6" aria-hidden="true"><path d="M3 19L8 5l5 14M5 14h6M15 7h7${delta === 1 ? "M18.5 3.5v7" : ""}"/></svg>`;
            button.onclick = () => { this.styleSize.value = String(Math.min(72, Math.max(4, Number(this.styleSize.value) + delta))); this.updateActiveTextStyle(); };
            resizeGroup.append(button);
        }
        const emphasis = document.createElement('div');
        emphasis.className = 'pdf-form-alignment-buttons';
        for (const [key, label, letter] of [['bold', 'Negrito', 'B'], ['italic', 'Itálico', 'I'], ['underline', 'Sublinhado', 'U']]) {
            const button = document.createElement('button');
            button.type = 'button';
            button.title = label;
            button.setAttribute('aria-label', label);
            button.textContent = letter;
            button.style.fontWeight = key === 'bold' ? '700' : '400';
            button.style.fontStyle = key === 'italic' ? 'italic' : 'normal';
            button.style.textDecoration = key === 'underline' ? 'underline' : 'none';
            button.onpointerdown = e => e.preventDefault();
            button.onclick = () => { const rich = this.activeTextField && this.richPages.get(this.activeTextField.name); rich?.format({ [key]: !this.richStyle?.[key] }); };
            this.richButtons.set(key, button);
            emphasis.append(button);
        }
        this.panel.addEventListener('pointerdown', () => { if (this.activeTextField)
            this.richPages.get(this.activeTextField.name)?.capture(); }, true);
        this.stylePanel.append(emphasis);
        this.stylePanel.append(legend, fontLabel, sizeLabel, resizeGroup, colorLabel, alignmentLabel, this.bulkTextPanel);
    }
    getTextStyle(field) {
        return this.styles[field.name] ?? field.style ?? { font: "helvetica", fontSize: 10, color: "#000000", alignment: "left" };
    }
    selectTextField(field, additive = false) {
        if (field.type !== "text")
            return;
        if (additive) {
            if (this.selectedTextFields.has(field.name))
                this.selectedTextFields.delete(field.name);
            else
                this.selectedTextFields.add(field.name);
        }
        else {
            this.selectedTextFields.clear();
            this.selectedTextFields.add(field.name);
        }
        this.activeTextField = this.selectedTextFields.has(field.name) ? field : this.schema?.fields.find(item => item.type === "text" && this.selectedTextFields.has(item.name)) ?? null;
        this.syncStylePanel();
        this.syncSelectedControls();
    }
    syncStylePanel() {
        const field = this.activeTextField;
        this.stylePanel.disabled = !field || this.saving;
        if (!field) {
            this.bulkTextPanel.hidden = true;
            return;
        }
        for (const button of this.richButtons.values())
            button.disabled = !field.name.startsWith('pugoti_body_');
        const style = this.getTextStyle(field);
        this.styleFont.value = style.font;
        this.styleSize.value = String(style.fontSize);
        this.styleColor.value = style.color;
        this.styleAlignment.value = style.alignment;
        this.syncAlignmentButtons();
        const count = this.selectedTextFields.size;
        const legend = this.stylePanel.querySelector("[data-pdf-form-style-legend]");
        if (legend)
            legend.textContent = count > 1 ? `Estilo de ${count} campos` : "Estilo do campo";
        this.bulkTextPanel.hidden = count < 2;
        this.stylePanel.hidden = false;
    }
    syncAlignmentButtons() {
        for (const [alignment, button] of this.alignmentButtons)
            button.setAttribute("aria-pressed", String(alignment === this.styleAlignment.value));
    }
    syncSelectedControls() {
        for (const control of Array.from(this.root.querySelectorAll("[data-pdf-form-field]"))) {
            const selected = this.selectedTextFields.has(control.dataset.pdfFormField ?? "");
            control.toggleAttribute("data-pdf-form-selected", selected);
        }
    }
    updateActiveTextStyle() {
        if (!this.activeTextField || !this.selectedTextFields.size || this.saving)
            return;
        const fontSize = Number(this.styleSize.value);
        if (!Number.isFinite(fontSize) || fontSize < 4 || fontSize > 72) {
            this.status.textContent = "Use um tamanho entre 4 e 72.";
            return;
        }
        const style = { font: this.styleFont.value, fontSize, color: this.styleColor.value.toLowerCase(), alignment: this.styleAlignment.value };
        const rich = this.richPages.get(this.activeTextField.name);
        if (rich) {
            const previous = this.richStyle ?? this.getTextStyle(this.activeTextField);
            const patch = {};
            if (style.font !== previous.font)
                patch.font = style.font;
            if (style.fontSize !== previous.fontSize)
                patch.fontSize = style.fontSize;
            if (style.color !== previous.color)
                patch.color = style.color;
            if (Object.keys(patch).length)
                rich.format(patch);
            if (style.alignment !== this.getTextStyle(this.activeTextField).alignment) {
                this.checkpoint();
                this.styles[this.activeTextField.name] = { ...this.getTextStyle(this.activeTextField), alignment: style.alignment };
                rich.element.style.textAlign = style.alignment;
                dirty.add(this.contentId);
            }
            return;
        }
        this.checkpoint();
        for (const fieldName of this.selectedTextFields)
            this.styles[fieldName] = style;
        dirty.add(this.contentId);
        this.status.textContent = "Estilo ainda não salvo.";
        for (const control of Array.from(this.root.querySelectorAll("[data-pdf-form-field]"))) {
            if (this.selectedTextFields.has(control.dataset.pdfFormField ?? ""))
                this.applyTextStyle(control, style);
        }
    }
    applyTextStyle(control, style) {
        control.style.fontFamily = style.font === "times" ? "Times New Roman, Times, serif" : style.font === "courier" ? "Courier New, Courier, monospace" : "Helvetica, Arial, sans-serif";
        control.style.fontSize = `${style.fontSize * Number(control.dataset.pdfScale || 1)}px`;
        control.style.color = style.color;
        control.style.textAlign = style.alignment;
    }
    applyBulkText() {
        if (this.saving || this.selectedTextFields.size < 2)
            return;
        const value = this.bulkText.value;
        this.checkpoint();
        for (const fieldName of this.selectedTextFields)
            this.values[fieldName] = value;
        dirty.add(this.contentId);
        this.status.textContent = "Texto aplicado aos campos selecionados. Alterações ainda não salvas.";
        for (const control of Array.from(this.root.querySelectorAll("[data-pdf-form-field]"))) {
            if (this.selectedTextFields.has(control.dataset.pdfFormField ?? ""))
                control.value = value;
        }
    }
    async detect() {
        try {
            const schema = await api(`/api/contents/${encodeURIComponent(this.contentId)}/pdf-form`);
            if (this.disposed)
                return;
            this.schema = schema;
            if (schema.canEdit === false) {
                this.button.hidden = true;
                return;
            }
            const note = this.panel.querySelector('.pdf-form-editor-note');
            if (schema.saveCreatesCopy && note)
                note.textContent = 'Modelo original preservado • Salvar cria sua ficha privada • Shift + clique: selecionar vários campos';
            this.name.value = schema.originalName;
            this.button.disabled = false;
            this.button.title = "Editar texto e páginas do PDF";
            this.name.title = `${schema.originalName}.pdf`;
            this.refresh();
            if (this.edits.length)
                await this.reloadPreview();
        }
        catch (error) {
            if (!this.disposed)
                this.button.title = error instanceof Error ? error.message : "Formulário indisponível";
        }
    }
    async attach(element, page, viewport) {
        const annotations = await page.getAnnotations();
        if (this.disposed || !element.isConnected)
            return;
        for (const old of this.pages.keys())
            if (!old.isConnected || !old.querySelector("canvas"))
                this.pages.delete(old);
        this.pages.set(element, { annotations, viewport });
        this.render(element, annotations, viewport);
    }
    beforeRender(element) {
        const active = document.activeElement;
        if (active && element.contains(active) && active.dataset.pdfFormField) {
            this.richPages.get(active.dataset.pdfFormField)?.capture();
            this.focusAfterRender = active.dataset.pdfFormField;
        }
    }
    refresh() {
        this.button.setAttribute("aria-pressed", String(this.editing));
        for (const [element, { annotations, viewport }] of this.pages) {
            if (!element.isConnected || !element.querySelector("canvas")) {
                this.pages.delete(element);
                continue;
            }
            this.render(element, annotations, viewport);
        }
    }
    render(element, annotations, viewport) {
        this.beforeRender(element);
        element.querySelector(".pdf-form-layer")?.remove();
        if (!this.editing || !this.schema)
            return;
        const layer = document.createElement("div");
        layer.className = "pdf-form-layer";
        layer.onclick = event => {
            if (!this.placingText || this.saving || event.target !== layer)
                return;
            event.preventDefault();
            event.stopPropagation();
            const bounds = element.getBoundingClientRect();
            const left = Math.min(Math.max(0, event.clientX - bounds.left), Math.max(0, bounds.width - 100));
            const top = Math.min(Math.max(0, event.clientY - bounds.top), Math.max(0, bounds.height - 60));
            const point = viewport.convertToPdfPoint(left * viewport.width / bounds.width, top * viewport.height / bounds.height);
            const end = viewport.convertToPdfPoint(Math.min(bounds.width, left + Math.min(280, bounds.width * .6)) * viewport.width / bounds.width, Math.min(bounds.height, top + 70) * viewport.height / bounds.height);
            const name = `pugoti_text_${Array.from(crypto.getRandomValues(new Uint8Array(16)), byte => byte.toString(16).padStart(2, '0')).join('')}`;
            this.focusAfterRender = name;
            void this.mutate({ kind: 'text', page: Number(element.dataset.pdfPage), name, rect: [Math.min(point[0], end[0]), Math.min(point[1], end[1]), Math.abs(end[0] - point[0]), Math.abs(end[1] - point[1])] }, Number(element.dataset.pdfPage)).then(() => {
                const field = this.schema?.fields.find(item => item.name === name);
                if (field)
                    this.selectTextField(field);
                this.root.querySelector(`[data-pdf-form-field="${name}"]`)?.focus();
            });
        };
        for (const annotation of annotations) {
            const field = this.schema.fields.find(item => item.name === annotation.fieldName);
            if (!field || annotation.subtype !== "Widget" || annotation.hidden || annotation.readOnly)
                continue;
            const rect = viewport.convertToViewportRectangle(annotation.rect);
            const value = this.values[field.name] ?? field.value;
            if (field.name.startsWith('pugoti_body_')) {
                const style = this.getTextStyle(field);
                const previousSelection = this.richPages.get(field.name)?.selectionState();
                const rich = new RichPage(style.runs ?? [{ ...style, text: String(value) }], viewport.scale ?? 1, runs => {
                    this.checkpoint();
                    this.values[field.name] = runs.map(r => r.text).join('');
                    this.styles[field.name] = { ...this.getTextStyle(field), runs: structuredClone(runs) };
                    dirty.add(this.contentId);
                    this.status.textContent = rich.element.scrollHeight > rich.element.clientHeight + 2 ? 'O texto excede a página. Adicione outra página ou reduza a fonte antes de salvar.' : 'Alterações ainda não salvas.';
                }, selected => {
                    this.selectTextField(field);
                    this.richStyle = selected;
                    this.styleFont.value = selected.font;
                    this.styleSize.value = String(selected.fontSize);
                    this.styleColor.value = selected.color;
                    for (const [key, button] of this.richButtons)
                        button.setAttribute('aria-pressed', String(!!selected[key]));
                });
                if (previousSelection)
                    rich.restoreSelection(previousSelection);
                this.richPages.set(field.name, rich);
                const body = rich.element;
                body.contentEditable = String(!this.saving);
                body.dataset.pdfFormField = field.name;
                body.setAttribute('aria-label', 'Texto da página');
                Object.assign(body.style, { left: `${Math.min(rect[0], rect[2]) / viewport.width * 100}%`, top: `${Math.min(rect[1], rect[3]) / viewport.height * 100}%`, width: `${Math.abs(rect[2] - rect[0]) / viewport.width * 100}%`, height: `${Math.abs(rect[3] - rect[1]) / viewport.height * 100}%`, fontSize: `${12 * (viewport.scale ?? 1)}px`, textAlign: style.alignment });
                layer.append(body);
                continue;
            }
            let control;
            if (field.type === "choice") {
                const select = document.createElement("select");
                select.multiple = !!field.multiple;
                if (!select.multiple)
                    select.add(new Option("", ""));
                for (const option of field.options ?? []) {
                    const item = new Option(option, option);
                    item.selected = Array.isArray(value) && value.includes(option);
                    select.add(item);
                }
                control = select;
            }
            else if (field.type === "text" && field.multiline) {
                control = document.createElement("textarea");
                control.value = String(value);
                control.maxLength = field.maxLength ?? 10000;
            }
            else {
                const input = document.createElement("input");
                input.type = field.type === "checkbox" ? "checkbox" : field.type === "radio" ? "radio" : "text";
                if (field.type === "checkbox")
                    input.checked = value === true;
                else if (field.type === "radio") {
                    input.value = annotation.buttonValue ?? annotation.exportValue ?? "";
                    input.checked = value === input.value;
                    input.name = `pdf-${field.name}`;
                }
                else {
                    input.value = String(value);
                    input.maxLength = field.maxLength ?? 10000;
                }
                control = input;
            }
            const label = field.name.startsWith('pugoti_text_') ? 'Texto adicionado' : field.name;
            control.setAttribute("aria-label", label);
            control.title = label;
            control.dataset.pdfFormField = field.name;
            control.dataset.pdfScale = String(viewport.scale ?? 1);
            control.disabled = this.saving;
            Object.assign(control.style, {
                left: `${Math.min(rect[0], rect[2]) / viewport.width * 100}%`, top: `${Math.min(rect[1], rect[3]) / viewport.height * 100}%`,
                width: `${Math.abs(rect[2] - rect[0]) / viewport.width * 100}%`, height: `${Math.abs(rect[3] - rect[1]) / viewport.height * 100}%`
            });
            if (field.type === "text" && (control instanceof HTMLInputElement || control instanceof HTMLTextAreaElement)) {
                this.applyTextStyle(control, this.getTextStyle(field));
                if (this.selectedTextFields.has(field.name))
                    control.setAttribute("data-pdf-form-selected", "");
                control.onpointerdown = event => {
                    if (!event.shiftKey)
                        return;
                    this.ignoreNextFocusSelection = true;
                    this.selectTextField(field, true);
                };
                control.onfocus = () => {
                    if (this.ignoreNextFocusSelection) {
                        this.ignoreNextFocusSelection = false;
                        return;
                    }
                    this.selectTextField(field);
                };
            }
            control.oninput = () => {
                const nextValue = control instanceof HTMLSelectElement ? Array.from(control.selectedOptions, option => option.value).filter(Boolean)
                    : control instanceof HTMLInputElement && control.type === "checkbox" ? control.checked : control.value;
                if (JSON.stringify(nextValue) === JSON.stringify(this.values[field.name] ?? field.value))
                    return;
                this.checkpoint();
                dirty.add(this.contentId);
                this.values[field.name] = nextValue;
                this.status.textContent = "Alterações ainda não salvas.";
                const next = this.values[field.name];
                for (const other of Array.from(this.root.querySelectorAll("[data-pdf-form-field]"))) {
                    if (other === control || other.dataset.pdfFormField !== field.name)
                        continue;
                    if (other instanceof HTMLSelectElement) {
                        for (const option of Array.from(other.options))
                            option.selected = Array.isArray(next) && next.includes(option.value);
                    }
                    else if (other instanceof HTMLInputElement && other.type === "checkbox")
                        other.checked = next === true;
                    else if (other instanceof HTMLInputElement && other.type === "radio")
                        other.checked = next === other.value;
                    else
                        other.value = String(next);
                }
            };
            layer.append(control);
        }
        element.append(layer);
        if (!this.saving && this.focusAfterRender) {
            const control = Array.from(layer.querySelectorAll('[data-pdf-form-field]')).find(item => item.dataset.pdfFormField === this.focusAfterRender);
            if (control) {
                requestAnimationFrame(() => {
                    if (control.isConnected && this.editing && !this.saving) {
                        this.focusAfterRender = null;
                        const rich = this.richPages.get(control.dataset.pdfFormField ?? '');
                        if (rich)
                            rich.restoreSelection(rich.selectionState(), true);
                        else
                            control.focus({ preventScroll: true });
                    }
                });
            }
        }
    }
    async saveCopy() {
        if (this.saving || !this.schema)
            return;
        this.saving = true;
        this.panel.querySelectorAll("input,button,select").forEach(control => control.disabled = true);
        this.refresh();
        this.status.textContent = "Salvando nova cópia…";
        const savedValues = { ...this.values };
        const savedStyles = { ...this.styles };
        try {
            const result = await api(`/api/contents/${encodeURIComponent(this.contentId)}/pdf-form/copies`, {
                method: "POST", body: JSON.stringify({ name: this.name.value, values: savedValues, styles: savedStyles, edits: this.edits, revision: this.schema.revision })
            });
            this.status.textContent = `Cópia salva na biblioteca: ${result.filename}. Original preservado.`;
            for (const [key, value] of Object.entries(savedValues)) {
                if (JSON.stringify(this.values[key]) === JSON.stringify(value))
                    delete this.values[key];
            }
            for (const [key, style] of Object.entries(savedStyles)) {
                if (JSON.stringify(this.styles[key]) === JSON.stringify(style))
                    delete this.styles[key];
            }
            this.editing = false;
            this.panel.hidden = true;
            this.root.classList.remove("pdf-form-editing");
            this.edits.splice(0);
            this.history.clear();
            if (!Object.keys(this.values).length)
                dirty.delete(this.contentId);
            window.dispatchEvent(new CustomEvent("pugotiread:pdf-copy-saved", { detail: result.content }));
            if (!this.disposed)
                await this.reloadPreview();
            this.status.textContent = `Cópia salva na biblioteca: ${result.filename}. Original preservado.`;
        }
        catch (error) {
            this.status.textContent = error instanceof Error ? error.message : "Falha ao salvar. Seus campos foram mantidos.";
        }
        finally {
            this.saving = false;
            this.panel.querySelectorAll("input,button,select").forEach(control => control.disabled = false);
            if (!this.disposed) {
                this.syncStylePanel();
                this.syncHistory();
                this.refresh();
            }
            window.dispatchEvent(new Event("resize"));
        }
    }
    async changeExisting(name) {
        if (this.saving || !this.schema)
            return;
        this.saving = true;
        this.panel.querySelectorAll('input,button,select').forEach(el => el.disabled = true);
        this.refresh();
        this.status.textContent = 'Salvando…';
        try {
            const result = await api(`/api/contents/${encodeURIComponent(this.contentId)}/pdf-form/save`, { method: 'POST', body: JSON.stringify({ revision: this.schema.revision, values: { ...this.values }, styles: { ...this.styles }, edits: this.edits, name }) });
            for (const key of Object.keys(this.values))
                delete this.values[key];
            for (const key of Object.keys(this.styles))
                delete this.styles[key];
            dirty.delete(this.contentId);
            drafts.delete(this.contentId);
            styleDrafts.delete(this.contentId);
            editDrafts.delete(this.contentId);
            this.history.clear();
            this.status.textContent = 'Ficha salva.';
            const route = parseRoute(window.location.href);
            if (result.content && result.content.id !== this.contentId && (route.kind === 'reader' || route.kind === 'title')) {
                window.location.replace(buildRoute({ ...route, contentId: result.content.id }));
            }
            else
                window.location.reload();
        }
        catch (error) {
            this.status.textContent = error instanceof Error ? error.message : 'Não foi possível atualizar a ficha. Seus campos foram mantidos.';
        }
        finally {
            this.saving = false;
            this.panel.querySelectorAll('input,button,select').forEach(el => el.disabled = false);
            if (!this.disposed)
                this.refresh();
        }
    }
    destroy() { this.disposed = true; this.listeners.abort(); this.root.classList.remove("pdf-form-editing", "pdf-placing-text"); this.pages.clear(); this.richPages.clear(); this.button.remove(); this.panel.remove(); }
}
