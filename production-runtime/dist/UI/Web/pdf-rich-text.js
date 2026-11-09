import { bodyStyle, formatRuns, mergeRuns } from '../../shared/pdf-rich-text.js';
/** A bounded page body. HTML is never persisted or accepted from the clipboard. */
export class RichPage {
    scale;
    changed;
    selected;
    element = document.createElement('div');
    runs;
    selection = { start: 0, end: 0 };
    pending;
    constructor(runs, scale, changed, selected) {
        this.scale = scale;
        this.changed = changed;
        this.selected = selected;
        this.runs = structuredClone(runs);
        this.pending = runs[0] ?? bodyStyle;
        this.element.className = 'pdf-rich-page';
        this.element.contentEditable = 'true';
        this.element.setAttribute('role', 'textbox');
        this.element.setAttribute('aria-multiline', 'true');
        this.element.spellcheck = true;
        this.draw();
        this.element.addEventListener('keyup', () => this.capture());
        this.element.addEventListener('pointerup', () => this.capture());
        this.element.addEventListener('focus', () => { this.capture(); this.selected(this.pending); });
        this.element.addEventListener('input', () => {
            this.read();
            this.capture();
            this.changed(this.runs);
        });
        this.element.addEventListener('beforeinput', event => {
            if (event.inputType === 'insertParagraph' || event.inputType === 'insertLineBreak' || (event.inputType === 'insertText' && !event.isComposing)) {
                event.preventDefault();
                this.insert(event.inputType === 'insertText' ? event.data ?? '' : '\n');
            }
        });
        this.element.addEventListener('paste', event => { event.preventDefault(); this.insert(event.clipboardData?.getData('text/plain') ?? ''); });
        this.element.addEventListener('drop', event => event.preventDefault());
        this.element.addEventListener('keydown', event => {
            if ((event.ctrlKey || event.metaKey) && ['b', 'i', 'u'].includes(event.key.toLowerCase())) {
                event.preventDefault();
                const key = { b: 'bold', i: 'italic', u: 'underline' }[event.key.toLowerCase()];
                this.format({ [key]: !this.pending[key] });
            }
        });
    }
    selectionState() { return { ...this.selection, pending: { ...this.pending } }; }
    restoreSelection(state, focus = false) {
        const length = this.runs.reduce((n, r) => n + r.text.length, 0);
        this.selection = { start: Math.min(state.start, length), end: Math.min(state.end, length) };
        this.pending = state.pending;
        if (focus) {
            const target = { ...this.selection };
            this.element.focus({ preventScroll: true });
            this.caret(target.start, target.end);
            this.pending = state.pending;
        }
    }
    capture() {
        const selection = window.getSelection();
        if (!selection?.rangeCount)
            return;
        const range = selection.getRangeAt(0);
        if (!this.element.contains(range.startContainer) || !this.element.contains(range.endContainer))
            return;
        const before = range.cloneRange();
        before.selectNodeContents(this.element);
        before.setEnd(range.startContainer, range.startOffset);
        const next = { start: before.toString().length, end: before.toString().length + range.toString().length };
        if (next.start === this.selection.start && next.end === this.selection.end)
            return;
        this.selection = next;
        let offset = 0;
        for (const run of this.runs) {
            offset += run.text.length;
            if (offset >= this.selection.start) {
                this.pending = { ...run };
                break;
            }
        }
        this.selected(this.pending);
    }
    caret(start, end = start) {
        const range = document.createRange(), walker = document.createTreeWalker(this.element, NodeFilter.SHOW_TEXT);
        let node, offset = 0, found = false;
        while ((node = walker.nextNode())) {
            const length = node.textContent?.length ?? 0;
            if (!found && start <= offset + length) {
                range.setStart(node, Math.max(0, start - offset));
                found = true;
            }
            if (found && end <= offset + length) {
                range.setEnd(node, Math.max(0, end - offset));
                break;
            }
            offset += length;
        }
        if (!found) {
            range.selectNodeContents(this.element);
            range.collapse(false);
        }
        const selection = window.getSelection();
        selection?.removeAllRanges();
        selection?.addRange(range);
        this.selection = { start, end };
    }
    span(run) {
        const span = document.createElement('span');
        span.textContent = run.text;
        Object.assign(span.style, { fontFamily: run.font === 'times' ? 'Times New Roman, Times, serif' : run.font === 'courier' ? 'Courier New, Courier, monospace' : 'Helvetica, Arial, sans-serif', fontSize: `${run.fontSize * this.scale}px`, color: run.color, fontWeight: run.bold ? '700' : '400', fontStyle: run.italic ? 'italic' : 'normal', textDecoration: run.underline ? 'underline' : 'none' });
        return span;
    }
    draw() { this.element.replaceChildren(...this.runs.map(r => this.span(r))); if (!this.runs.length)
        this.element.append(document.createTextNode('')); }
    read() {
        const result = [];
        const walk = (node) => {
            if (node.nodeType === Node.TEXT_NODE) {
                const style = getComputedStyle(node.parentElement);
                const c = style.color.match(/[\d.]+/g) ?? ['0', '0', '0'];
                result.push({ text: node.textContent ?? '', font: /courier/i.test(style.fontFamily) ? 'courier' : /times/i.test(style.fontFamily) ? 'times' : 'helvetica', fontSize: Math.max(4, Math.min(72, parseFloat(style.fontSize) / this.scale)), color: '#' + c.slice(0, 3).map(n => Math.round(Number(n)).toString(16).padStart(2, '0')).join(''), bold: Number(style.fontWeight) >= 600, italic: style.fontStyle === 'italic', underline: style.textDecorationLine.includes('underline') });
            }
            else if (node instanceof HTMLElement) {
                if (node.tagName === 'BR')
                    result.push({ ...this.pending, text: '\n' });
                else {
                    if (node !== this.element && ['DIV', 'P'].includes(node.tagName) && result.length && !result.at(-1).text.endsWith('\n'))
                        result.push({ ...this.pending, text: '\n' });
                    node.childNodes.forEach(walk);
                }
            }
        };
        walk(this.element);
        this.runs = mergeRuns(result);
    }
    insert(text) {
        this.capture();
        const { start, end } = this.selection;
        const cut = (a, b) => { let pos = 0; return this.runs.flatMap(r => { const text = r.text.slice(Math.max(0, a - pos), Math.max(0, Math.min(r.text.length, b - pos))); pos += r.text.length; return text ? [{ ...r, text }] : []; }); };
        text = text.replace(/\r\n?/g, '\n');
        const length = this.runs.reduce((n, r) => n + r.text.length, 0);
        if (length - (end - start) + text.length > 10000)
            return;
        this.runs = mergeRuns([...cut(0, start), { ...this.pending, text }, ...cut(end, length)]);
        this.draw();
        this.caret(start + text.length);
        this.changed(this.runs);
    }
    format(patch) {
        this.capture();
        const { start, end } = this.selection;
        this.pending = { ...this.pending, ...patch };
        if (start !== end) {
            this.runs = formatRuns(this.runs, start, end, patch);
            this.draw();
            this.changed(this.runs);
        }
        const pending = this.pending;
        this.element.focus({ preventScroll: true });
        this.caret(start, end);
        this.pending = pending;
        this.selected(this.pending);
    }
}
