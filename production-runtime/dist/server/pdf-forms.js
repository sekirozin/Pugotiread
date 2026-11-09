import { readRich, validateRuns, writeRich } from './pdf-rich-text.js';
import fs from "node:fs/promises";
import { linkSync, unlinkSync } from 'node:fs';
import path from "node:path";
import { createHash } from "node:crypto";
import { PDFDocument, PDFTextField, PDFCheckBox, PDFDropdown, PDFOptionList, PDFRadioGroup, PDFSignature, StandardFonts, TextAlignment, rgb, setFillingColor } from "pdf-lib";
export class FormError extends Error {
}
export async function formRevision(source) {
    if ((await fs.stat(source)).size > 40 * 1024 * 1024)
        throw new FormError('O limite para preencher formulários é 40 MB.');
    return createHash('sha256').update(await fs.readFile(source)).digest('hex');
}
export function fullFormName(value) {
    if (typeof value !== 'string')
        throw new FormError('Nome inválido.');
    const name = value.trim().replace(/\.pdf$/i, '').trim();
    if (!name || name.length > 160 || name.startsWith('.') || /[\x00-\x1f\x7f/\\:*?"<>|]/.test(name))
        throw new FormError('Use um nome de até 160 caracteres, sem barras ou caracteres especiais de arquivo.');
    return name + '.pdf';
}
const writing = new Set();
export async function withFormLock(source, action) {
    if (writing.has(source))
        throw new FormError('Esta ficha está sendo salva. Tente novamente.');
    writing.add(source);
    try {
        return await action();
    }
    finally {
        writing.delete(source);
    }
}
export async function updateForm(source, bytes, revision) {
    if (typeof revision !== 'string' || await formRevision(source) !== revision)
        throw new FormError('A ficha mudou desde que foi aberta. Reabra antes de salvar para não perder alterações.');
    const temporary = await fs.mkdtemp(path.join(path.dirname(source), '.pdf-copy-save-'));
    try {
        const backup = path.join(path.dirname(source), '.pdf-copy-history');
        await fs.mkdir(backup, { recursive: true });
        await fs.copyFile(source, path.join(backup, revision + '.pdf'));
        await fs.writeFile(path.join(temporary, 'updated.pdf'), bytes, { mode: (await fs.stat(source)).mode });
        if (await formRevision(source) !== revision)
            throw new FormError('A ficha foi alterada por outra sessão. Reabra antes de salvar.');
        await fs.rename(path.join(temporary, 'updated.pdf'), source);
    }
    finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}
const defaultTextStyle = { font: "helvetica", fontSize: 10, color: "#000000", alignment: "left" };
function clamp(value) { return Math.min(1, Math.max(0, value)); }
function colorHex(red, green, blue) {
    return `#${[red, green, blue].map(value => Math.round(clamp(value) * 255).toString(16).padStart(2, "0")).join("")}`;
}
function parseTextStyle(field) {
    const appearance = field.acroField.getDefaultAppearance() ?? "";
    const fontName = appearance.match(/\/([^\s/]+)\s+[\d.]+\s+Tf/)?.[1] ?? "";
    const font = /times/i.test(fontName) ? "times" : /courier/i.test(fontName) ? "courier" : "helvetica";
    const size = Number(appearance.match(/\/[^\s/]+\s+([\d.]+)\s+Tf/)?.[1]);
    const rgbMatch = appearance.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+rg/);
    const grayMatch = appearance.match(/([\d.]+)\s+g/);
    const cmykMatch = appearance.match(/([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+([\d.]+)\s+k/);
    const color = rgbMatch ? colorHex(Number(rgbMatch[1]), Number(rgbMatch[2]), Number(rgbMatch[3]))
        : grayMatch ? colorHex(Number(grayMatch[1]), Number(grayMatch[1]), Number(grayMatch[1]))
            : cmykMatch ? colorHex(1 - Math.min(1, Number(cmykMatch[1]) + Number(cmykMatch[4])), 1 - Math.min(1, Number(cmykMatch[2]) + Number(cmykMatch[4])), 1 - Math.min(1, Number(cmykMatch[3]) + Number(cmykMatch[4])))
                : defaultTextStyle.color;
    const alignment = field.getAlignment() === TextAlignment.Center ? "center" : field.getAlignment() === TextAlignment.Right ? "right" : "left";
    return { ...(readRich(field) ? { runs: readRich(field) } : {}), font, fontSize: Number.isFinite(size) && size >= 4 && size <= 72 ? size : defaultTextStyle.fontSize, color, alignment };
}
function parseStyle(value, fallback, name) {
    if (value === undefined)
        return fallback;
    if (!value || typeof value !== "object" || Array.isArray(value))
        throw new FormError(`Estilo inválido: ${name}`);
    const input = value;
    const font = input.font;
    const fontSize = Number(input.fontSize);
    const color = input.color;
    const alignment = input.alignment;
    if ((font !== "helvetica" && font !== "times" && font !== "courier") || !Number.isFinite(fontSize) || fontSize < 4 || fontSize > 72 || typeof color !== "string" || !/^#[\da-f]{6}$/i.test(color) || (alignment !== "left" && alignment !== "center" && alignment !== "right"))
        throw new FormError(`Estilo inválido: ${name}`);
    return { font, fontSize: Math.round(fontSize * 10) / 10, color: color.toLowerCase(), alignment, ...(input.runs !== undefined ? { runs: input.runs } : {}) };
}
function alignmentValue(value) {
    return value === "center" ? TextAlignment.Center : value === "right" ? TextAlignment.Right : TextAlignment.Left;
}
function fontForStyle(style) {
    return style.font === "times" ? StandardFonts.TimesRoman : style.font === "courier" ? StandardFonts.Courier : StandardFonts.Helvetica;
}
function applyTextStyle(field, style) {
    const red = Number.parseInt(style.color.slice(1, 3), 16) / 255;
    const green = Number.parseInt(style.color.slice(3, 5), 16) / 255;
    const blue = Number.parseInt(style.color.slice(5, 7), 16) / 255;
    field.setAlignment(alignmentValue(style.alignment));
    // pdf-lib reads the color from the default appearance before generating the
    // widget stream. This also removes inconsistent legacy color operators.
    field.acroField.setDefaultAppearance(`${setFillingColor(rgb(red, green, blue)).toString()}\n/${style.font === "times" ? "Times-Roman" : style.font === "courier" ? "Courier" : "Helvetica"} ${style.fontSize} Tf`);
    field.setFontSize(style.fontSize);
}
async function load(source) {
    if (path.extname(source).toLowerCase() !== ".pdf")
        throw new FormError("Este arquivo não é um PDF.");
    if ((await fs.stat(source)).size > 40 * 1024 * 1024)
        throw new FormError("O limite para preencher formulários é 40 MB.");
    let document;
    try {
        document = await PDFDocument.load(await fs.readFile(source), { updateMetadata: false });
    }
    catch {
        throw new FormError("PDF protegido ou inválido. Não foi possível abrir o formulário.");
    }
    const form = document.getForm();
    if (form.hasXFA())
        throw new FormError("Formulários XFA não são suportados nesta versão.");
    if (form.getFields().some(field => field instanceof PDFSignature))
        throw new FormError("PDFs com campos de assinatura não são suportados nesta versão.");
    return { document, form };
}
export async function describeForm(source) {
    const { document } = await load(source);
    return describePdf(document, path.basename(source, path.extname(source)));
}
export function describePdf(document, originalName) {
    const form = document.getForm();
    const fields = form.getFields().flatMap(field => {
        if (field.isReadOnly())
            return [];
        const name = field.getName();
        if (field instanceof PDFTextField && !field.isRichFormatted() && !field.isFileSelector())
            return [{ name, type: "text", value: field.getText() ?? "", multiline: field.isMultiline(), maxLength: field.getMaxLength(), style: parseTextStyle(field) }];
        if (field instanceof PDFCheckBox)
            return [{ name, type: "checkbox", value: field.isChecked() }];
        if (field instanceof PDFDropdown || field instanceof PDFOptionList)
            return [{ name, type: "choice", value: field.getSelected(), options: field.getOptions(), multiple: field.isMultiselect() }];
        if (field instanceof PDFRadioGroup)
            return [{ name, type: "radio", value: field.getSelected() ?? "", options: field.getOptions() }];
        return [];
    });
    return { originalName, fields, pageCount: document.getPageCount() };
}
export async function previewPdf(source, values, styles, edits) {
    const bytes = await fillCopyBytes(source, values, styles, edits);
    return { pdf: Buffer.from(bytes).toString('base64'), schema: describePdf(await PDFDocument.load(bytes), path.basename(source, path.extname(source))) };
}
export function copyName(original, suffix) {
    if (suffix !== undefined && typeof suffix !== "string")
        throw new FormError("Nome inválido.");
    const name = (typeof suffix === "string" ? suffix.trim() : "") || "copia";
    if (name.length > 80 || /[\x00-\x1f\x7f/\\:*?"<>|]/.test(name) || name === "." || name === "..")
        throw new FormError("Use um nome de até 80 caracteres, sem barras ou caracteres especiais de arquivo.");
    const base = path.basename(original, path.extname(original)).slice(0, 80);
    return `${base} - ${name}`;
}
export async function fillCopyBytes(source, values, styles = {}, edits = []) {
    if (!values || typeof values !== "object" || Array.isArray(values) || Object.keys(values).length > 2000)
        throw new FormError("Valores de formulário inválidos.");
    if (!styles || typeof styles !== "object" || Array.isArray(styles) || Object.keys(styles).length > 2000)
        throw new FormError("Estilos de formulário inválidos.");
    const { document, form } = await load(source);
    if (!Array.isArray(edits) || edits.length > 500)
        throw new FormError('Operações de edição inválidas (máximo 500).');
    const removedNames = new Set();
    for (const edit of edits) {
        if (!edit || typeof edit !== 'object')
            throw new FormError('Operação inválida.');
        if (edit.kind === 'insert') {
            if (edit.position !== 'start' && edit.position !== 'end')
                throw new FormError('Posição inválida.');
            const reference = document.getPage(edit.position === 'start' ? 0 : document.getPageCount() - 1);
            const box = reference.getCropBox();
            const rotated = Math.abs(reference.getRotation().angle) % 180 === 90;
            const inserted = document.insertPage(edit.position === 'start' ? 0 : document.getPageCount(), rotated ? [box.height, box.width] : [box.width, box.height]);
            if (edit.name !== undefined) {
                if (typeof edit.name !== 'string' || !/^pugoti_body_[a-zA-Z0-9_-]{1,80}$/.test(edit.name) || form.getFieldMaybe(edit.name))
                    throw new FormError('Identificador de página inválido.');
                const margin = Math.min(72, inserted.getWidth() / 6, inserted.getHeight() / 6);
                const field = form.createTextField(edit.name);
                field.enableMultiline();
                field.setText('');
                field.addToPage(inserted, { x: margin, y: margin, width: inserted.getWidth() - 2 * margin, height: inserted.getHeight() - 2 * margin, borderWidth: 0, backgroundColor: undefined, borderColor: undefined });
                applyTextStyle(field, { ...defaultTextStyle, fontSize: 12 });
                await writeRich(document, field, []);
            }
            continue;
        }
        if (!Number.isInteger(edit.page) || edit.page < 1 || edit.page > document.getPageCount())
            throw new FormError('Página inválida.');
        const page = document.getPage(edit.page - 1);
        if (edit.kind === 'delete') {
            if (document.getPageCount() <= 1)
                throw new FormError('O PDF precisa ter pelo menos uma página.');
            for (const field of form.getFields()) {
                const widgets = field.acroField.getWidgets();
                const onPage = widgets.map((widget, index) => ({ widget, index })).filter(({ widget }) => widget.P()?.toString() === page.ref.toString() || page.node.Annots()?.asArray().some(ref => document.context.lookup(ref) === widget.dict));
                if (!onPage.length)
                    continue;
                if (onPage.length === widgets.length) {
                    removedNames.add(field.getName());
                    form.removeField(field);
                }
                else
                    for (const { index } of onPage.reverse())
                        field.acroField.removeWidget(index);
            }
            document.removePage(edit.page - 1);
        }
        else if (edit.kind === 'text') {
            if (typeof edit.name !== 'string' || !/^pugoti_text_[a-zA-Z0-9_-]{1,80}$/.test(edit.name) || form.getFieldMaybe(edit.name))
                throw new FormError('Identificador de texto inválido.');
            const rect = edit.rect;
            if (!Array.isArray(rect) || rect.length !== 4 || rect.some((n) => typeof n !== 'number' || !Number.isFinite(n)))
                throw new FormError('Posição do texto inválida.');
            const [x, y, width, height] = rect;
            const box = page.getCropBox();
            if (width < 10 || height < 10 || x < box.x - 1 || y < box.y - 1 || x + width > box.x + box.width + 1 || y + height > box.y + box.height + 1)
                throw new FormError('O texto precisa ficar dentro da página.');
            const field = form.createTextField(edit.name);
            field.enableMultiline();
            field.setText('');
            field.addToPage(page, { x, y, width, height, borderWidth: 0, backgroundColor: undefined, borderColor: undefined });
            applyTextStyle(field, { ...defaultTextStyle, fontSize: 12 });
            field.updateAppearances(await document.embedFont(StandardFonts.Helvetica));
        }
        else
            throw new FormError('Operação de edição desconhecida.');
    }
    const submittedStyles = styles;
    const entries = new Map(Object.entries(values));
    for (const name of Object.keys(submittedStyles))
        if (!entries.has(name))
            entries.set(name, undefined);
    for (const [name, value] of entries) {
        if (removedNames.has(name) && !form.getFieldMaybe(name))
            continue;
        const field = form.getFieldMaybe(name);
        if (!field || field.isReadOnly())
            throw new FormError(`Campo indisponível: ${name}`);
        if (field instanceof PDFTextField && !field.isRichFormatted() && !field.isFileSelector()) {
            const text = value === undefined ? field.getText() ?? "" : value;
            if (typeof text !== "string" || text.length > Math.min(field.getMaxLength() ?? 10000, 10000))
                throw new FormError(`Texto inválido: ${name}`);
            const style = parseStyle(submittedStyles[name], parseTextStyle(field), name);
            applyTextStyle(field, style);
            field.setText(text);
            if (style.runs !== undefined || field.getName().startsWith('pugoti_body_')) {
                try {
                    await writeRich(document, field, validateRuns(style.runs ?? [{ ...style, text }], text));
                }
                catch (error) {
                    throw new FormError(error instanceof Error ? error.message : 'Formatação inválida.');
                }
            }
            else
                field.updateAppearances(await document.embedFont(fontForStyle(style)));
        }
        else if (field instanceof PDFCheckBox && typeof value === "boolean") {
            value ? field.check() : field.uncheck();
        }
        else if (field instanceof PDFDropdown || field instanceof PDFOptionList || field instanceof PDFRadioGroup) {
            const selected = typeof value === "string" ? (value ? [value] : []) : value;
            if (!Array.isArray(selected) || selected.some(item => typeof item !== "string" || !field.getOptions().includes(item)))
                throw new FormError(`Opção inválida: ${name}`);
            if ((field instanceof PDFRadioGroup || !field.isMultiselect()) && selected.length > 1)
                throw new FormError(`Selecione apenas uma opção: ${name}`);
            field.clear();
            if (selected.length) {
                if (field instanceof PDFRadioGroup)
                    field.select(selected[0]);
                else
                    field.select(selected);
            }
        }
        else
            throw new FormError(`Tipo de campo não suportado: ${name}`);
    }
    try {
        return await document.save();
    }
    catch {
        throw new FormError("Não foi possível gerar a cópia. Use caracteres latinos nos campos; emojis e alguns alfabetos ainda não são suportados.");
    }
}
// Hard-link publication is atomic and exclusive: an existing path (including a
// symlink) can never be replaced. The original is opened only for reading.
export async function publishCopy(directory, base, bytes, register) {
    const temporary = await fs.mkdtemp(path.join(directory, ".pdf-copy-"));
    const staged = path.join(temporary, "copy.pdf");
    try {
        await fs.writeFile(staged, bytes, { flag: "wx", mode: 0o644 });
        for (let index = 1; index <= 10000; index++) {
            const name = `${base}${index === 1 ? "" : ` (${index})`}.pdf`;
            const target = path.join(directory, name);
            // Publish and register permissions in the same event-loop turn. No request
            // can read a newly published personal PDF before its owner is recorded.
            try {
                linkSync(staged, target);
            }
            catch (error) {
                if (error.code === 'EEXIST')
                    continue;
                throw error;
            }
            try {
                register?.(name);
            }
            catch (error) {
                unlinkSync(target);
                throw error;
            }
            return name;
        }
        throw new FormError("Há cópias demais com este nome. Escolha outro nome.");
    }
    finally {
        await fs.rm(temporary, { recursive: true, force: true });
    }
}
