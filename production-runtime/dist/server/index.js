import { pageImageVariant } from "./reader-resources.js";
import crypto from "node:crypto";
import { handleRpg } from './rpg.js';
import { reconcilePdfLocation, pdfLocationMissing } from './pdf-locations.js';
import { describeForm, describePdf, fillCopyBytes, copyName, publishCopy, FormError, formRevision, fullFormName, withFormLock, updateForm } from "./pdf-forms.js";
import { PDFButton, PDFDocument, PDFDict, PDFHexString, PDFName, PDFStream, PDFString, PDFTextField, StandardFonts, ImageAlignment, TextAlignment, layoutMultilineText, closePath, clip, concatTransformationMatrix, drawObject, endPath, lineTo, moveTo, popGraphicsState, pushGraphicsState, setLineWidth, setStrokingRgbColor, stroke } from "pdf-lib";
import { inflateSync } from "node:zlib";
import { pathToFileURL } from "node:url";
import FichasDatabase from "better-sqlite3";
import sharp from "sharp";
import fs from "node:fs/promises";
import http from "node:http";
import path from "node:path";
import { clearSessionCookie, createSessionToken, getCookie, getCurrentUser, hashPassword, isPasswordHashReady, setSessionCookie, toPublicUser, verifyGoogleIdToken, verifyPassword } from "./auth.js";
import { config } from "./config.js";
import { cacheService } from "./cache.js";
import { readJson, sendBuffer, sendFile, sendHtml, sendJson, sendNoContent, serveStatic } from "./http.js";
import { sendPasswordResetEmail } from "./mailer.js";
import { canDownloadToLibrary, canSyncLibrary, getPugotiSyncStatus, isPugotiSyncBusy, startPugotiSync } from "./pugoti-sync.js";
import { getContentCoverPath, getContentCoverThumbnail, getContentEpubAsset, getContentEpubChapterHtml, getContentEpubTextLengths, getContentPagePath, scanLibrary as scanMediaLibrary, searchEpubText, startLibraryWatchers } from "./media.js";
import { normalizeReadingDefaults, normalizeVaultTimeoutMinutes, store } from "./store.js";
// ---- campos calculados das fichas (início) ----
// Fichas como a de Mutantes & Malfeitores somam totais com scripts do próprio PDF (ação /AA /C), em campos somente leitura.
// O servidor só descreve esses campos e grava os valores que o navegador calculou; os scripts rodam no navegador, isolados.
const MAX_CALC_SCRIPT = 20 * 1024, MAX_CALC_TOTAL = 512 * 1024, MAX_CALC_VALUE = 200;
const calculationCache = new Map();
function pdfScriptText(object) {
    if (object instanceof PDFString || object instanceof PDFHexString)
        return object.decodeText();
    if (object instanceof PDFStream) {
        const raw = Buffer.from(object.getContents());
        try {
            return inflateSync(raw).toString("latin1");
        }
        catch {
            return raw.toString("latin1");
        }
    }
    return "";
}
function calculationScript(field) {
    for (const dict of [field.acroField.dict, ...field.acroField.getWidgets().map(widget => widget.dict)]) {
        const actions = dict.lookup(PDFName.of("AA"));
        const action = actions instanceof PDFDict ? actions.lookup(PDFName.of("C")) : null;
        if (action instanceof PDFDict && action.lookup(PDFName.of("S"))?.toString() === "/JavaScript")
            return pdfScriptText(action.lookup(PDFName.of("JS")));
    }
    return "";
}
function describeCalculations(document) {
    const form = document.getForm();
    const fields = Object.create(null);
    const byRef = new Map();
    let total = 0;
    for (const field of form.getFields()) {
        if (!(field instanceof PDFTextField) || !field.isReadOnly())
            continue;
        const script = calculationScript(field);
        if (!script || script.length > MAX_CALC_SCRIPT || (total += script.length) > MAX_CALC_TOTAL)
            continue;
        const appearance = field.acroField.getDefaultAppearance() ?? "";
        const alignment = field.getAlignment();
        fields[field.getName()] = { script, value: field.getText() ?? "", fontSize: Number(appearance.match(/\/[^\s/]+\s+([\d.]+)\s+Tf/)?.[1]) || 0, alignment: alignment === 1 ? "center" : alignment === 2 ? "right" : "left" };
        byRef.set(field.ref.toString(), field.getName());
    }
    const listed = form.acroForm.dict.lookup(PDFName.of("CO"));
    const order = [];
    for (const ref of listed?.asArray?.() ?? []) {
        const name = byRef.get(ref.toString());
        if (name && !order.includes(name))
            order.push(name);
    }
    for (const name of Object.keys(fields))
        if (!order.includes(name))
            order.push(name);
    return order.length ? { order, fields } : null;
}
async function pdfCalculations(file) {
    try {
        const info = await fs.stat(file);
        const cached = calculationCache.get(file);
        if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size)
            return cached.calculations;
        const calculations = describeCalculations(await PDFDocument.load(await fs.readFile(file), { updateMetadata: false }));
        calculationCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, calculations });
        return calculations;
    }
    catch {
        return null;
    }
}
// Separa dos valores enviados os campos calculados (a biblioteca de formulários recusa campos somente leitura).
function splitCalculatedValues(values, calculations) {
    if (!calculations || !values || typeof values !== "object" || Array.isArray(values))
        return { values, computed: {} };
    const rest = {}, computed = {};
    for (const [name, value] of Object.entries(values)) {
        if (!(name in calculations.fields)) {
            rest[name] = value;
            continue;
        }
        if (typeof value !== "string" || value.length > MAX_CALC_VALUE)
            throw new FormError(`Valor calculado inválido: ${name}`);
        computed[name] = value;
    }
    return { values: rest, computed };
}
async function applyCalculatedValues(bytes, computed) {
    const names = Object.keys(computed);
    if (!names.length)
        return bytes;
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    const form = document.getForm();
    const font = await document.embedFont(StandardFonts.Helvetica);
    for (const name of names) {
        const field = form.getFieldMaybe(name);
        if (!(field instanceof PDFTextField))
            continue; // a página do campo pode ter sido apagada na edição
        try {
            field.setText(computed[name]);
            field.updateAppearances(font);
        }
        catch {
            throw new FormError(`Valor calculado inválido: ${name}`);
        }
    }
    return document.save();
}
// Campos de foto: botões com /PugotiAvatar (ex.: o hexágono "NEN" da ficha de M&M) ou com "importar ícone" do Acrobat.
// O navegador manda a foto já enquadrada (data URL JPEG/PNG); aqui ela vira a aparência do botão, recortada no formato.
const MAX_IMAGE_BYTES = 2 * 1024 * 1024;
const imageFieldCache = new Map();
function describeImageFields(document) {
    const fields = Object.create(null);
    for (const field of document.getForm().getFields()) {
        if (!(field instanceof PDFButton))
            continue;
        const shape = field.acroField.dict.lookup(PDFName.of("PugotiAvatar"))?.toString() === "/Hexagon" ? "hexagon" : null;
        const action = field.acroField.getWidgets()[0]?.dict.lookup(PDFName.of("A"));
        const imports = action instanceof PDFDict && /buttonImportIcon/.test(pdfScriptText(action.lookup(PDFName.of("JS"))));
        if (!shape && !imports)
            continue;
        const normal = field.acroField.getWidgets()[0]?.getAppearances()?.normal;
        const stream = normal instanceof PDFStream ? normal : normal ? document.context.lookup(normal) : null;
        const xobjects = stream instanceof PDFStream ? stream.dict.lookup(PDFName.of("Resources"))?.lookup?.(PDFName.of("XObject")) : null;
        fields[field.getName()] = { shape: shape ?? "rect", hasImage: xobjects instanceof PDFDict && xobjects.keys().length > 0 };
    }
    return Object.keys(fields).length ? fields : null;
}
async function pdfImageFields(file) {
    try {
        const info = await fs.stat(file);
        const cached = imageFieldCache.get(file);
        if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size)
            return cached.images;
        const images = describeImageFields(await PDFDocument.load(await fs.readFile(file), { updateMetadata: false }));
        imageFieldCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, images });
        return images;
    }
    catch {
        return null;
    }
}
function splitImageValues(values, images) {
    if (!images || !values || typeof values !== "object" || Array.isArray(values))
        return { values, photos: {} };
    const rest = {}, photos = {};
    for (const [name, value] of Object.entries(values)) {
        if (!(name in images)) {
            rest[name] = value;
            continue;
        }
        if (!value || typeof value !== "object" || !("image" in value))
            throw new FormError(`Foto inválida: ${name}`);
        if (value.image === null) {
            photos[name] = null;
            continue;
        }
        const match = typeof value.image === "string" ? value.image.match(/^data:image\/(jpeg|png);base64,([A-Za-z0-9+/=]+)$/) : null;
        const bytes = match ? Buffer.from(match[2], "base64") : null;
        const isJpeg = bytes && bytes[0] === 0xff && bytes[1] === 0xd8, isPng = bytes && bytes.subarray(0, 4).toString("hex") === "89504e47";
        if (!bytes || bytes.length > MAX_IMAGE_BYTES || !(match[1] === "jpeg" ? isJpeg : isPng))
            throw new FormError("Use uma foto JPG ou PNG de até 2 MB.");
        // Cópia com memória própria: o pdf-lib lê a imagem por imageData.buffer e ignora o deslocamento de um Buffer do
        // pool do Node (dava "SOI not found" de vez em quando, conforme onde a foto caía na memória).
        photos[name] = { bytes: Uint8Array.from(bytes), kind: match[1] };
    }
    return { values: rest, photos };
}
// Hexágono de ponta para cima inscrito na caixa w × h.
function hexagonPath(width, height) {
    const r = Math.min(height / 2, width / Math.sqrt(3)), cx = width / 2, cy = height / 2, half = r * Math.sqrt(3) / 2;
    return [[cx, cy + r], [cx + half, cy + r / 2], [cx + half, cy - r / 2], [cx, cy - r], [cx - half, cy - r / 2], [cx - half, cy + r / 2]];
}
async function applyImageValues(bytes, photos, images) {
    const names = Object.keys(photos);
    if (!names.length)
        return bytes;
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    const form = document.getForm();
    for (const name of names) {
        const field = form.getFieldMaybe(name);
        if (!(field instanceof PDFButton))
            continue;
        const widget = field.acroField.getWidgets()[0];
        const { width, height } = widget.getRectangle();
        const photo = photos[name];
        if (!photo) {
            widget.setNormalAppearance(document.context.register(document.context.formXObject([], { BBox: [0, 0, width, height] })));
            continue;
        }
        let image;
        try {
            image = photo.kind === "png" ? await document.embedPng(photo.bytes) : await document.embedJpg(photo.bytes);
        }
        catch {
            throw new FormError("Não foi possível ler a foto. Tente outra imagem JPG ou PNG.");
        }
        if (images[name]?.shape !== "hexagon") {
            field.setImage(image, ImageAlignment.Center);
            continue;
        }
        // Avatar: a foto cobre o hexágono (recorte central) e a borda verde da ficha é redesenhada por cima.
        const points = hexagonPath(width, height);
        const scale = Math.max(width / image.width, height / image.height);
        const [w, h] = [image.width * scale, image.height * scale];
        const path = () => [moveTo(...points[0]), ...points.slice(1).map(point => lineTo(...point)), closePath()];
        const operators = [pushGraphicsState(), ...path(), clip(), endPath(), concatTransformationMatrix(w, 0, 0, h, (width - w) / 2, (height - h) / 2), drawObject("Foto"), popGraphicsState(),
            pushGraphicsState(), setStrokingRgbColor(86 / 255, 111 / 255, 96 / 255), setLineWidth(1.2), ...path(), stroke(), popGraphicsState()];
        widget.setNormalAppearance(document.context.register(document.context.formXObject(operators, { BBox: [0, 0, width, height], Resources: { XObject: { Foto: image.ref } } })));
    }
    return document.save();
}
// Texto que não cabe na célula: a aparência gravada usa uma fonte menor (nunca maior que a da ficha); linha única fica
// centralizada na vertical (layout do pdf-lib). O /DA continua com o tamanho original, então um texto curto volta ao
// normal na próxima gravação. Tamanho 0 no /DA já é automático e fica como está.
// Leitores (pdf.js inclusive) ignoram a aparência gravada e redesenham com o /DA enquanto o formulário tiver
// /NeedAppearances true (vem do modelo da ficha). Quando todos os campos de texto preenchidos têm aparência gerada aqui
// (ou texto rico com aparência própria), a marcação sai e os leitores mostram a fonte reduzida.
const MIN_FIT_FONT = 4;
const RICH_TEXT_KEY = PDFName.of("PugotiRichText");
function decodedAppearance(appearance) {
    // Algumas fichas guardam o /DA com escapes octais (\057Helv = /Helv).
    return appearance.replace(/\\([0-7]{3})/g, (_, octal) => String.fromCharCode(parseInt(octal, 8)));
}
function fitFontFor(appearance) {
    const name = decodedAppearance(appearance).match(/\/([^\s/]+)\s+[\d.]+\s+Tf/)?.[1] ?? "";
    // Só as fontes padrão que o editor grava; fonte própria do PDF (ex.: Comic Sans) fica intocada.
    if (/^(helv|helvetica)$/i.test(name))
        return StandardFonts.Helvetica;
    if (/^(tiro|times-roman|timesroman)$/i.test(name))
        return StandardFonts.TimesRoman;
    if (/^(cour|courier)$/i.test(name))
        return StandardFonts.Courier;
    return undefined;
}
function fittingFontSize(field, text, font, size, width, height) {
    // Mesmo recuo do gerador de aparência do pdf-lib (borda + 1 pt de cada lado).
    const border = field.acroField.getWidgets()[0]?.getBorderStyle?.()?.getWidth?.() ?? 0;
    const inner = { x: 0, y: 0, width: Math.max(1, width - (border + 1) * 2), height: Math.max(1, height - (border + 1) * 2) };
    if (field.isCombed())
        return size;
    if (!field.isMultiline()) {
        // 1 pt de folga para a última letra não encostar na borda.
        const room = Math.max(1, inner.width - 1);
        const wide = font.widthOfTextAtSize(text, size);
        return wide <= room ? size : Math.max(MIN_FIT_FONT, Math.floor(size * room / wide * 10) / 10);
    }
    for (let current = size; current > MIN_FIT_FONT; current = Math.round((current - 0.5) * 10) / 10) {
        const layout = layoutMultilineText(text, { alignment: TextAlignment.Left, fontSize: current, font, bounds: inner });
        if (layout.lines.length * layout.lineHeight <= inner.height)
            return current;
    }
    return MIN_FIT_FONT;
}
async function fitTextAppearances(bytes) {
    const document = await PDFDocument.load(bytes, { updateMetadata: false });
    const form = document.getForm();
    const fonts = new Map();
    let changed = false;
    let allGenerated = true;
    for (const field of form.getFields()) {
        if (!(field instanceof PDFTextField)) {
            const selected = typeof field.getSelected === "function" ? field.getSelected() : [];
            if (Array.isArray(selected) && selected.length)
                allGenerated = false; // lista/menu preenchido: deixa o leitor desenhar
            continue;
        }
        const text = field.getText() ?? "";
        if (!text)
            continue; // vazio: a aparência existente (fundo/borda) já está certa
        if (field.acroField.dict.has(RICH_TEXT_KEY) || field.isRichFormatted() || field.getName().startsWith("pugoti_body_"))
            continue; // texto rico: aparência própria gravada pelo pdf-rich-text
        const appearance = field.acroField.getDefaultAppearance() ?? "";
        const size = Number(decodedAppearance(appearance).match(/([\d.]+)\s+Tf/)?.[1]);
        const widget = field.acroField.getWidgets()[0];
        const fontName = fitFontFor(appearance);
        if (field.isFileSelector() || !size || !widget || !fontName) {
            allGenerated = false;
            continue;
        }
        if (!fonts.has(fontName))
            fonts.set(fontName, await document.embedFont(fontName));
        const font = fonts.get(fontName);
        // Campo repetido em mais de um lugar: vale a menor célula.
        const fit = Math.min(...field.acroField.getWidgets().map(each => { const { width, height } = each.getRectangle(); return fittingFontSize(field, text, font, size, width, height); }));
        if (fit < size)
            field.setFontSize(fit);
        field.updateAppearances(font);
        field.acroField.setDefaultAppearance(appearance);
        changed = true;
    }
    const need = PDFName.of("NeedAppearances");
    if (allGenerated && form.acroForm.dict.has(need)) {
        form.acroForm.dict.delete(need);
        changed = true;
    }
    return changed ? document.save() : bytes;
}
async function fillWithCalculations(source, body, calculations) {
    const images = await pdfImageFields(source);
    const { values: withoutPhotos, photos } = splitImageValues(body.values, images);
    const { values, computed } = splitCalculatedValues(withoutPhotos, calculations);
    return applyImageValues(await fitTextAppearances(await applyCalculatedValues(await fillCopyBytes(source, values, body.styles, body.edits), computed)), photos, images ?? {});
}
async function describeFormWithCalculations(file) {
    return { ...await describeForm(file), calculations: await pdfCalculations(file), images: await pdfImageFields(file) };
}
// ---- campos calculados das fichas (fim) ----
// ---- nome do personagem nas fichas preenchidas (início) ----
// Lê o nome do personagem dos campos do PDF. Nomes exatos primeiro; "ataque1_nome" e afins não contam.
const CHARACTER_NAME_FIELDS = ["nome do personagem", "nome personagem", "personagem", "nome", "character name", "charactername", "character", "name"];
function normalizeFieldName(value) {
    return String(value).normalize("NFD").replace(/[\u0300-\u036f]/g, "").toLowerCase().replace(/[^a-z0-9]+/g, " ").trim();
}
function tidyCharacterName(value) {
    const text = String(value ?? "").replace(/\s+/g, " ").trim().slice(0, 80);
    // "MEPHISTO" vira "Mephisto"; nomes já com maiúsculas e minúsculas ficam como estão.
    if (!/\p{Ll}/u.test(text) && /\p{Lu}/u.test(text))
        return text.toLocaleLowerCase("pt-BR").replace(/(^|[\s'-])(\p{L})/gu, (match, before, letter) => before + letter.toLocaleUpperCase("pt-BR"));
    return text;
}
function characterNameFromFields(fields) {
    const filled = fields.filter(field => field.type === "text" && String(field.value ?? "").trim());
    for (const wanted of CHARACTER_NAME_FIELDS) {
        const field = filled.find(item => normalizeFieldName(item.name) === wanted);
        if (field)
            return tidyCharacterName(field.value);
    }
    const field = filled.find(item => /^(nome (do |da )?personagem|character name)\b/.test(normalizeFieldName(item.name)));
    return field ? tidyCharacterName(field.value) : "";
}
// ---- nome do personagem nas fichas preenchidas (fim) ----
const characterNameCache = new Map();
async function pdfCharacterName(file) {
    try {
        const info = await fs.stat(file);
        const cached = characterNameCache.get(file);
        if (cached && cached.mtimeMs === info.mtimeMs && cached.size === info.size)
            return cached.name;
        const name = characterNameFromFields((await describeForm(file)).fields);
        characterNameCache.set(file, { mtimeMs: info.mtimeMs, size: info.size, name });
        return name;
    }
    catch {
        return "";
    }
}
async function copyCharacterName(libraries, contentId) {
    const library = libraries.find(item => item.id === contentId.split(":")[0]);
    const source = library ? await getContentPagePath(library, contentId, 0).catch(() => null) : null;
    return source ? pdfCharacterName(source) : "";
}
function isPersonalLibrary(library) {
    return Boolean(library.isPersonal);
}
// ---- pastas de RPG (início) ----
// Organização de cada sistema na biblioteca de RPG (kind "other"):
//   <Sistema>/Módulos Básicos/*.pdf            → módulo
//   <Sistema>/Submódulos/*.pdf                 → material complementar (sem papel)
//   <Sistema>/Fichas Padrão/*.pdf              → modelo de ficha, ligado a todos os módulos básicos do sistema
//   <Sistema>/Fichas de Usuários/<usuário>/*.pdf → ficha pessoal desse usuário (módulo = o básico, se houver só um)
// Em Módulos Básicos e Fichas Padrão a pasta define o papel; vínculos manuais são mantidos e fichas já registradas
// (dono, compartilhamento, módulo escolhido) não mudam.
// As pastas servem só para classificar no disco: no PugotiRead a navegação continua como antes (rpgDisplaySystem) —
// módulos e submódulos na pasta do sistema, modelos e fichas de usuários juntos em <Sistema>/Fichas.
// Fichas novas são salvas em <Sistema>/Fichas de Usuários/<usuário>. A antiga pasta "Fichas" continua reconhecida.
const RPG_FOLDERS = { basic: 'Módulos Básicos', extra: 'Submódulos', template: 'Fichas Padrão', users: 'Fichas de Usuários' };
const folderKey = (name) => String(name ?? '').normalize('NFC').trim().toLocaleLowerCase('pt-BR');
const RPG_FOLDER_KEYS = new Map(Object.entries(RPG_FOLDERS).map(([category, name]) => [folderKey(name), category]));
const RPG_LEGACY_SHEETS = new Set(['fichas', 'ficha']);
function rpgFolderInfo(system) {
    const parts = String(system ?? '').split(/[\\/]+/).map(part => part.trim()).filter(Boolean);
    const index = parts.findIndex(part => RPG_FOLDER_KEYS.has(folderKey(part)) || RPG_LEGACY_SHEETS.has(folderKey(part)));
    if (index < 0)
        return { system: parts.join('/'), category: null, owner: null };
    const category = RPG_FOLDER_KEYS.get(folderKey(parts[index])) ?? 'legacySheets';
    return { system: parts.slice(0, index).join('/'), category, owner: category === 'users' ? parts[index + 1] ?? null : null };
}
// Caminho mostrado no PugotiRead: "Tormenta RPG/Submódulos" → "Tormenta RPG"; "Tormenta RPG/Fichas de Usuários/sekiro" e
// "Tormenta RPG/Fichas Padrão" → "Tormenta RPG/Fichas". Pastas fora da convenção ficam como estão.
function rpgDisplaySystem(system) {
    const info = rpgFolderInfo(system);
    if (info.category === 'basic' || info.category === 'extra')
        return info.system || null;
    if (info.category === 'template' || info.category === 'users')
        return [info.system, 'Fichas'].filter(Boolean).join('/');
    return system ?? null;
}
// Ficha de usuário só aparece para o dono, para quem ele compartilhou e para o admin. Um PDF em Fichas de Usuários cujo
// dono não foi reconhecido (pasta com nome errado, pessoa sem acesso à biblioteca) não tem registro de ficha e seria
// tratado como material público: fica visível só para o admin, que pode corrigir a pasta.
function rpgUnclaimedSheet(contentId, copies) {
    const relative = Buffer.from(String(contentId).slice(String(contentId).indexOf(':') + 1), 'base64url').toString('utf8');
    if (rpgFolderInfo(relative.split(/[\\/]+/).slice(0, -1).join('/')).category !== 'users')
        return false;
    return copies ? !copies.has(contentId) : !store.pdfFormCopies().some(copy => copy.contentId === contentId);
}
// "Tormenta RPG/Fichas" e "Tormenta RPG/Fichas de Usuários/sekiro" viram "Tormenta RPG" (igual à tela de fichas).
function sheetSystemLabel(system) {
    return rpgFolderInfo(system).system.split('/').filter(Boolean).join(" / ");
}
function rpgUserFolderName(user) {
    const name = String(user?.username || user?.id || '').normalize('NFC').replace(/[\\/:*?"<>|\u0000-\u001f]/g, '_').replace(/^\.+/, '').trim();
    return name || String(user?.id || 'usuario');
}
/** Pasta onde uma ficha nova (criada a partir do PDF em relativeSource) é publicada para este usuário. */
function rpgUserSheetFolder(relativeSource, user) {
    const folder = relativeSource.split(/[\\/]+/).filter(Boolean).slice(0, -1).join('/');
    return [rpgFolderInfo(folder).system, RPG_FOLDERS.users, rpgUserFolderName(user)].filter(Boolean).join('/');
}
async function syncRpgFolders(library, contents) {
    const data = await store.read();
    const users = data.users.filter(person => person.role === 'admin' || person.allowedLibraryIds?.includes(library.id));
    const copies = new Map(store.pdfFormCopies().map(copy => [copy.contentId, copy]));
    const pdfs = contents.filter(content => content.pageTypes?.includes('pdf')).map(content => ({ content, info: rpgFolderInfo(content.system) }));
    const documents = () => new Map(store.rpgDocuments().map(item => [item.contentId, item]));
    const linkedTemplates = (moduleId) => store.rpgLinks().filter(link => link.moduleId === moduleId).map(link => link.templateId);
    const attempt = (label, action) => { try { action(); } catch (error) { console.error(`Pastas de RPG: ${label}`, error instanceof Error ? error.message : error); } };
    // 1. Papéis de módulo e modelo.
    let current = documents();
    for (const { content, info } of pdfs) {
        if (copies.has(content.id))
            continue;
        const document = current.get(content.id);
        if (info.category === 'basic' && document?.role !== 'module')
            attempt(`módulo ${content.id}`, () => store.setRpgDocument(content.id, 'module', []));
        else if (info.category === 'template' && document?.role !== 'template')
            attempt(`modelo ${content.id}`, () => store.setRpgDocument(content.id, 'template', []));
    }
    current = documents();
    const roleIn = (role, category, system) => pdfs.filter(item => item.info.category === category && item.info.system === system && current.get(item.content.id)?.role === role).map(item => current.get(item.content.id));
    // 2. Cada módulo básico recebe os modelos da pasta Fichas Padrão do mesmo sistema (sem tirar vínculos manuais).
    for (const system of new Set(pdfs.map(item => item.info.system))) {
        const templates = roleIn('template', 'template', system).map(item => item.id);
        for (const module of roleIn('module', 'basic', system)) {
            const linked = linkedTemplates(module.id);
            if (templates.some(id => !linked.includes(id)))
                attempt(`vínculos ${module.contentId}`, () => store.setRpgDocument(module.contentId, 'module', [...new Set([...linked, ...templates])]));
        }
    }
    // 3. PDFs em Fichas de Usuários/<usuário> viram fichas pessoais desse usuário.
    for (const { content, info } of pdfs) {
        if (info.category !== 'users' || !info.owner || copies.has(content.id) || current.has(content.id))
            continue;
        const owner = users.find(person => folderKey(rpgUserFolderName(person)) === folderKey(info.owner))
            ?? users.find(person => folderKey(person.displayName) === folderKey(info.owner));
        if (!owner)
            continue;
        const source = await getContentPagePath(library, content.id, 0).catch(() => null);
        if (!source)
            continue;
        const templates = roleIn('template', 'template', info.system);
        const revision = await formRevision(source).catch(() => null);
        if (revision === null)
            continue;
        attempt(`ficha ${content.id}`, () => store.registerPdfCopy(content.id, templates.length === 1 ? templates[0].contentId : content.id, revision, owner.id, content.system ?? ''));
    }
    // 4. Ficha de usuário sem módulo: o módulo básico do sistema, quando ele é único.
    for (const copy of store.pdfFormCopies()) {
        const item = pdfs.find(entry => entry.content.id === copy.contentId);
        if (!item || copy.moduleId || item.info.category !== 'users')
            continue;
        const modules = roleIn('module', 'basic', item.info.system);
        if (modules.length === 1)
            attempt(`módulo da ficha ${copy.contentId}`, () => store.setPdfCopyModule(copy.contentId, modules[0].id));
    }
}
// Fichas preenchidas aparecem com o personagem: "Koga Onikawa (Mutantes Malfeitores 3E)". O nome do arquivo fica em fileTitle.
async function withCharacterTitle(library, content, copy) {
    const source = await getContentPagePath(library, content.id, 0).catch(() => null);
    const characterName = source ? await pdfCharacterName(source) : "";
    if (!characterName)
        return content;
    const system = sheetSystemLabel(copy.system || content.system);
    return { ...content, fileTitle: content.title, characterName, title: system ? `${characterName} (${system})` : characterName };
}
async function scanLibrary(library, options = {}) {
    const contents = await scanMediaLibrary(library, options);
    if (!['other', 'book', 'lightNovel'].includes(library.kind))
        return contents;
    // Primeiro segue os PDFs movidos (progresso, marcadores e papéis vão junto), depois aplica as pastas de RPG.
    const kept = [];
    for (const content of contents) {
        if (!content.pageTypes.includes('pdf') || await reconcilePdfLocation(library, content.id) === content.id)
            kept.push(content);
    }
    if (library.kind === 'other')
        await syncRpgFolders(library, kept).catch(error => console.error('Falha ao organizar as pastas de RPG', error));
    const copies = new Map(store.pdfFormCopies().map(copy => [copy.contentId, copy]));
    const result = [];
    for (const content of kept) {
        const shown = library.kind === 'other' ? { ...content, system: rpgDisplaySystem(content.system) } : content;
        result.push(copies.has(content.id) ? await withCharacterTitle(library, shown, copies.get(content.id)) : shown);
    }
    return result;
}
// ---- pastas de RPG (fim) ----
function getVisibleLibraries(user, libraries) {
    const regularLibraries = libraries.filter((library) => !isPersonalLibrary(library));
    return user.role === "admin"
        ? regularLibraries
        : regularLibraries.filter((library) => user.allowedLibraryIds.includes(library.id));
}
function getPersonalLibraries(user, libraries) {
    return libraries.filter((library) => isPersonalLibrary(library) && library.ownerUserId === user.id);
}
function findDownloadLibrary(libraries, kind) {
    const directMatch = libraries.find((library) => !library.isPersonal && library.kind === kind);
    if (directMatch) {
        return directMatch;
    }
    // Bibliotecas antigas de manhwa podem ter sido cadastradas como "manga".
    // Não alteramos seu schema aqui; apenas identificamos corretamente a pasta
    // de destino para o download individual.
    const normalizedKind = kind === "manhwa" ? "manhwa" : "manga";
    return libraries.find((library) => !library.isPersonal
        && canSyncLibrary(library)
        && `${library.name} ${library.path}`.normalize("NFD").replaceAll(/\p{Diacritic}/gu, "").toLowerCase().includes(normalizedKind));
}
function createVaultToken(userId, timeoutMinutes) {
    const payload = `${userId}.${Date.now() + timeoutMinutes * 60 * 1000}`;
    const signature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
    return `${payload}.${signature}`;
}
function hasValidVaultToken(req, user) {
    const token = req.headers["x-vault-token"] ?? getCookie(req, "pugotiread_vault");
    if (typeof token !== "string") {
        return false;
    }
    const [userId, expiresAt, signature] = token.split(".");
    if (userId !== user.id || !expiresAt || !signature || Number(expiresAt) < Date.now()) {
        return false;
    }
    const payload = `${userId}.${expiresAt}`;
    const expectedSignature = crypto.createHmac("sha256", config.sessionSecret).update(payload).digest("base64url");
    if (signature.length !== expectedSignature.length) {
        return false;
    }
    return crypto.timingSafeEqual(Buffer.from(signature), Buffer.from(expectedSignature));
}
function getRequestLibrary(user, libraries, libraryId, req) {
    const library = libraries.find((item) => item.id === libraryId) ?? null;
    if (!library) {
        return null;
    }
    if (isPersonalLibrary(library)) {
        return library.ownerUserId === user.id && hasValidVaultToken(req, user) ? library : null;
    }
    return user.role === "admin" || user.allowedLibraryIds.includes(library.id) ? library : null;
}
function findVisibleLibraryForContentId(user, libraries, contentId) {
    return getVisibleLibraries(user, libraries).find((item) => contentId.startsWith(`${item.id}:`)) ?? null;
}
// ---- foto do personagem (início) ----
// Ficha de usuário pode ter uma foto do personagem: fica fixa à esquerda no leitor e vira a capa do cartão. A imagem
// não entra no PDF (salvar a ficha não muda nada e o editor não acusa "O PDF mudou"); fica na pasta de dados e o hash
// fica em pdf_form_copies.characterPhoto, que acompanha a ficha quando o PDF é movido. Ver e trocar seguem a ficha:
// quem vê a ficha vê a foto; só o dono e administradores trocam ou removem.
const CHARACTER_PHOTO_DIR = path.join(path.dirname(config.dbFile), "fotos-personagens");
const CHARACTER_PHOTO_MAX_BYTES = 12 * 1024 * 1024;
if (!store.db.prepare("PRAGMA table_info(pdf_form_copies)").all().some(column => column.name === "characterPhoto"))
    store.db.exec("ALTER TABLE pdf_form_copies ADD COLUMN characterPhoto TEXT");
function characterPhotos() {
    return new Map(store.db.prepare("SELECT contentId, characterPhoto FROM pdf_form_copies WHERE characterPhoto IS NOT NULL").all().map(row => [row.contentId, row.characterPhoto]));
}
// "recorte" muda quando o jeito de recortar a capa muda: o endereço novo fura o cache imutável dos navegadores.
const CHARACTER_COVER_CROP = 2;
function characterPhotoUrls(contentId, hash) {
    const base = `/api/contents/${encodeURIComponent(contentId)}/foto-personagem`;
    return { characterPhotoUrl: `${base}?v=${hash}`, coverUrl: `${base}?tamanho=capa&v=${hash}&recorte=${CHARACTER_COVER_CROP}` };
}
// Capa do cartão (2:3): recorte fixo, centralizado na horizontal; em imagem mais alta que 2:3, guarda a parte de cima
// (rosto). O "attention" do sharp puxava o recorte para o ponto mais chamativo (fundo), tirando o personagem do centro.
async function characterPhotoCover(input) {
    const { width, height } = await sharp(input).metadata();
    const wide = width / height > 2 / 3;
    const cropWidth = wide ? Math.max(1, Math.round(height * 2 / 3)) : width;
    const cropHeight = wide ? height : Math.max(1, Math.round(width * 3 / 2));
    const left = wide ? Math.round((width - cropWidth) / 2) : 0;
    const top = wide ? 0 : Math.round((height - cropHeight) * 0.2);
    return sharp(input).extract({ left, top, width: Math.min(cropWidth, width - left), height: Math.min(cropHeight, height - top) }).resize(480, 720, { fit: "fill" }).webp({ quality: 80 }).toBuffer();
}
function characterPhotoFile(hash, size) {
    return path.join(CHARACTER_PHOTO_DIR, `${hash}${size === "capa" ? "-capa" : ""}.webp`);
}
async function removeUnusedCharacterPhoto(hash) {
    if (!hash || store.db.prepare("SELECT 1 FROM pdf_form_copies WHERE characterPhoto=?").get(hash))
        return;
    await Promise.all([fs.rm(characterPhotoFile(hash), { force: true }), fs.rm(characterPhotoFile(hash, "capa"), { force: true })]);
}
async function readImageBody(req) {
    const chunks = [];
    let size = 0;
    for await (const chunk of req) {
        size += chunk.length;
        if (size > CHARACTER_PHOTO_MAX_BYTES)
            throw new FormError("A imagem passa de 12 MB.");
        chunks.push(Buffer.isBuffer(chunk) ? chunk : Buffer.from(chunk));
    }
    return Buffer.concat(chunks);
}
async function handleCharacterPhoto(req, res, url, user, contentId) {
    const copy = store.pdfFormCopies().find(item => item.contentId === contentId);
    if (!copy || !store.canAccessPdfContent(contentId, user)) {
        sendJson(res, 404, { error: "Ficha não encontrada." });
        return;
    }
    const current = store.db.prepare("SELECT characterPhoto FROM pdf_form_copies WHERE contentId=?").get(contentId)?.characterPhoto ?? null;
    if (req.method === "GET" || req.method === "HEAD") {
        if (!current) {
            sendJson(res, 404, { error: "Esta ficha não tem foto." });
            return;
        }
        await sendFile(req, res, characterPhotoFile(current, url.searchParams.get("tamanho")), url.searchParams.get("v") === current ? "private, max-age=31536000, immutable" : "private, no-cache");
        return;
    }
    if (req.method !== "PUT" && req.method !== "DELETE") {
        sendJson(res, 405, { error: "Método inválido." });
        return;
    }
    if (user.role !== "admin" && copy.ownerUserId !== user.id) {
        sendJson(res, 403, { error: "Só o dono da ficha ou um administrador pode trocar a foto." });
        return;
    }
    if (req.headers["sec-fetch-site"] === "cross-site") {
        sendJson(res, 403, { error: "Origem inválida." });
        return;
    }
    if (req.method === "DELETE") {
        store.db.prepare("UPDATE pdf_form_copies SET characterPhoto=NULL WHERE contentId=?").run(contentId);
        await removeUnusedCharacterPhoto(current);
        sendJson(res, 200, { characterPhotoUrl: null });
        return;
    }
    try {
        const bytes = await readImageBody(req);
        let photo, cover;
        try {
            const upright = await sharp(bytes, { limitInputPixels: 60_000_000, animated: false }).rotate().png().toBuffer();
            photo = await sharp(upright).resize(900, 1200, { fit: "inside", withoutEnlargement: true }).webp({ quality: 84 }).toBuffer();
            cover = await characterPhotoCover(upright);
        }
        catch {
            throw new FormError("Envie uma imagem (JPG, PNG, WebP ou GIF).");
        }
        const hash = crypto.createHash("sha256").update(photo).digest("hex").slice(0, 32);
        await fs.mkdir(CHARACTER_PHOTO_DIR, { recursive: true });
        for (const [file, data] of [[characterPhotoFile(hash), photo], [characterPhotoFile(hash, "capa"), cover]]) {
            await fs.writeFile(`${file}.tmp`, data);
            await fs.rename(`${file}.tmp`, file);
        }
        store.db.prepare("UPDATE pdf_form_copies SET characterPhoto=? WHERE contentId=?").run(hash, contentId);
        if (current !== hash)
            await removeUnusedCharacterPhoto(current);
        sendJson(res, 200, characterPhotoUrls(contentId, hash));
    }
    catch (error) {
        sendJson(res, 400, { error: error instanceof FormError ? error.message : "Não foi possível salvar a foto." });
    }
}
// ---- foto do personagem (fim) ----
function visibleContents(user, contents) {
    const copies = new Map(store.pdfFormCopies().map(copy => [copy.contentId, copy]));
    const roles = new Map(store.rpgDocuments().map(item => [item.contentId, item.role]));
    const photos = characterPhotos();
    return contents.filter((content) => store.canAccessPdfContent(content.id, user) && (user.role === 'admin' || !rpgUnclaimedSheet(content.id, copies))).map(content => {
        const copy = copies.get(content.id);
        const photo = copy ? photos.get(content.id) : null;
        return { ...content, rpgRole: roles.get(content.id), ...(copy ? { system: rpgDisplaySystem(copy.system || content.system), formOwnerUserId: copy.ownerUserId || null, formVisibility: copy.visibility } : {}), ...(photo ? { pdfCoverUrl: content.coverUrl ?? null, ...characterPhotoUrls(content.id, photo) } : {}) };
    });
}
async function findVisibleContent(user, contentId) {
    if (!store.canAccessPdfContent(contentId, user))
        return null;
    const data = await store.read();
    const library = findVisibleLibraryForContentId(user, data.libraries, contentId);
    if (!library) {
        return null;
    }
    const contents = await scanLibrary(library);
    const content = contents.find((item) => item.id === contentId);
    return content ? { library, pageCount: content.pageCount } : null;
}
async function findRequestContent(user, contentId, req) {
    if (!store.canAccessPdfContent(contentId, user))
        return null;
    const data = await store.read();
    const libraryId = contentId.split(":")[0] ?? "";
    const library = getRequestLibrary(user, data.libraries, libraryId, req);
    if (!library) {
        return null;
    }
    const contents = await scanLibrary(library);
    const content = contents.find((item) => item.id === contentId);
    return content ? { library, pageCount: content.pageCount } : null;
}
function parseContentPagePath(pathname) {
    const match = pathname.match(/^\/api\/contents\/(.+)\/pages\/(\d+)$/);
    if (!match) {
        return null;
    }
    return {
        contentId: decodeURIComponent(match[1] ?? ""),
        pageIndex: Number(match[2])
    };
}
function parseContentEpubAssetPath(pathname) {
    const match = pathname.match(/^\/api\/contents\/(.+)\/epub-assets\/(.+)$/);
    if (!match) {
        return null;
    }
    return {
        contentId: decodeURIComponent(match[1] ?? ""),
        assetPath: (match[2] ?? "").split("/").map((part) => decodeURIComponent(part)).join("/")
    };
}
function waitForSyncCompletion() {
    return new Promise((resolve) => {
        const timer = setInterval(() => {
            if (!isPugotiSyncBusy()) {
                clearInterval(timer);
                resolve();
            }
        }, 1000);
    });
}
let automaticSyncCycleRunning = false;
async function runAutomaticSyncCycle() {
    if (automaticSyncCycleRunning || isPugotiSyncBusy()) {
        console.log("[SYNC] Ciclo automático ignorado: já existe uma sincronização em andamento.");
        return;
    }
    automaticSyncCycleRunning = true;
    try {
        const data = await store.read();
        const libraries = data.libraries.filter(canSyncLibrary);
        console.log(`[SYNC] Iniciando ciclo automático de ${libraries.length} biblioteca(s).`);
        for (const library of libraries) {
            try {
                await startPugotiSync(library, null, async () => {
                    await invalidateLibraryScanCache(library.id);
                    await scanLibrary(library, { refresh: true });
                    await store.markLibraryScanned(library.id, new Date().toISOString());
                }, "automatic");
                await waitForSyncCompletion();
                const status = getPugotiSyncStatus();
                console.log(`[SYNC] ${library.name}: ${status.state} - ${status.message}`);
            }
            catch (error) {
                console.error(`[SYNC] ${library.name}:`, error);
            }
        }
        console.log("[SYNC] Ciclo automático finalizado.");
    }
    finally {
        automaticSyncCycleRunning = false;
    }
}
function parseContentCoverPath(pathname) {
    const match = pathname.match(/^\/api\/contents\/(.+)\/cover$/);
    if (!match) {
        return null;
    }
    return { contentId: decodeURIComponent(match[1] ?? "") };
}
function slugify(value) {
    return value
        .normalize("NFD")
        .replaceAll(/\p{Diacritic}/gu, "")
        .toLowerCase()
        .replace(/[^a-z0-9]+/g, "-")
        .replace(/(^-|-$)/g, "");
}
function makeLibraryId(name, existing) {
    const base = slugify(name) || "biblioteca";
    let next = base;
    let counter = 2;
    while (existing.some((library) => library.id === next)) {
        next = `${base}-${counter}`;
        counter += 1;
    }
    return next;
}
function makeUserId(base, existing) {
    const normalized = slugify(base) || "user";
    let next = normalized;
    let counter = 2;
    while (existing.some((user) => user.id === next)) {
        next = `${normalized}-${counter}`;
        counter += 1;
    }
    return next;
}
function makeInviteToken() {
    return crypto.randomBytes(18).toString("hex");
}
function makePasswordResetTokenValue() {
    return crypto.randomBytes(18).toString("hex");
}
function hashPasswordResetToken(token) {
    return crypto.createHash("sha256").update(token).digest("hex");
}
function makePasswordResetLink(token) {
    return `${config.publicUrl.replace(/\/$/, "")}/reset-password/${encodeURIComponent(token)}`;
}
async function issuePasswordResetToken(user) {
    const token = makePasswordResetTokenValue();
    const tokenHash = hashPasswordResetToken(token);
    const now = Date.now();
    const createdAt = new Date(now).toISOString();
    const expiresAt = new Date(now + 30 * 60 * 1000).toISOString();
    const resetToken = {
        token: tokenHash,
        userId: user.id,
        email: user.email,
        purpose: "password-reset",
        createdAt,
        expiresAt,
        usedAt: null
    };
    await store.createPasswordResetToken(resetToken);
    await sendPasswordResetEmail(user.email, makePasswordResetLink(token));
    return resetToken;
}
function normalizeEmail(email) {
    return email.trim().toLowerCase();
}
function sanitizeLibraryIds(libraryIds, libraries) {
    const allowed = new Set(libraries.map((library) => library.id));
    return Array.from(new Set(libraryIds.filter((id) => allowed.has(id))));
}
function sanitizeUserRole(role) {
    if (role === "admin" || role === "superuser")
        return role;
    return "user";
}
function hasConfiguredAdmin(users) {
    return users.some((item) => item.role === "admin" && isPasswordHashReady(item.passwordHash));
}
function buildUserFromInput(body, existingUsers, libraries) {
    const username = body.username?.trim() ?? "";
    const displayName = body.displayName?.trim() || username;
    const email = body.email?.trim() ?? "";
    const allowedLibraryIds = sanitizeLibraryIds(body.allowedLibraryIds ?? [], libraries);
    if (!username) {
        throw new Error("Informe o usuário.");
    }
    if (!email) {
        throw new Error("Informe o e-mail.");
    }
    return {
        id: makeUserId(username, existingUsers),
        username,
        displayName,
        email,
        avatarUrl: "",
        nickname: "",
        biography: "",
        location: "",
        favoriteContentIds: [],
        canLogin: body.canLogin ?? true,
        canDownload: body.canDownload ?? true,
        canChangePassword: body.canChangePassword ?? true,
        passwordChangeRequiresEmailConfirmation: body.passwordChangeRequiresEmailConfirmation ?? true,
        lastActiveAt: null,
        role: body.role ?? "user",
        passwordHash: body.passwordHash ?? hashPassword(body.password ?? ""),
        allowedLibraryIds
    };
}
function makeCollectionId(name, userId, existing) {
    const base = slugify(name) || "colecao";
    let next = base;
    let counter = 2;
    while (existing.some((collection) => collection.userId === userId && collection.id === next)) {
        next = `${base}-${counter}`;
        counter += 1;
    }
    return next;
}
function makePublicReview(review, user) {
    return {
        userId: review.userId,
        contentId: review.contentId,
        displayName: user.displayName,
        role: user.role,
        rating: review.rating,
        comment: review.comment,
        createdAt: review.createdAt,
        updatedAt: review.updatedAt
    };
}
function getVisibleReviewCountForUser(viewer, data, userId) {
    return data.reviews.filter((review) => review.userId === userId && Boolean(findVisibleLibraryForContentId(viewer, data.libraries, review.contentId))).length;
}
function makePublicCollection(collection, owner) {
    return {
        id: collection.id,
        userId: collection.userId,
        name: collection.name,
        description: collection.description,
        sharedWithUserIds: collection.sharedWithUserIds,
        ownerDisplayName: owner?.displayName ?? "Usuário",
        contentIds: collection.contentIds
    };
}
function isLibraryKind(value) {
    return value === "manga" || value === "manhwa" || value === "book" || value === "comic" || value === "lightNovel" || value === "other";
}
function isSyncSkippedLibraryKind(kind) {
    return kind === "book" || kind === "lightNovel";
}
async function invalidateLibraryScanCache(libraryId) {
    cacheService.invalidateScan(libraryId);
    await cacheService.invalidateLibraryCovers(libraryId);
}
function getNoDetectedContentMessage(kind) {
    if (kind === "book" || kind === "lightNovel") {
        return "Nenhuma obra detectada. Para livros, coloque arquivos .epub ou .pdf na pasta da biblioteca ou dentro de pastas de obras.";
    }
    if (kind === "other") {
        return "Nenhuma obra detectada. A pasta deve conter PDFs diretamente ou pastas de obras com imagens ou PDFs.";
    }
    return "Nenhuma obra detectada. A pasta deve conter pastas de obras com imagens ou PDFs.";
}
function isInsideMediaRoot(candidatePath) {
    const relative = path.relative(path.resolve(config.mediaRoot), path.resolve(candidatePath));
    return relative === "" || (!relative.startsWith("..") && !path.isAbsolute(relative));
}
async function readMediaDirectory(requestedPath) {
    const safePath = path.resolve(requestedPath || config.mediaRoot);
    if (!isInsideMediaRoot(safePath)) {
        throw new Error("Pasta fora da raiz de mídia.");
    }
    const entries = await fs.readdir(safePath, { withFileTypes: true });
    const directories = entries
        .filter((entry) => entry.isDirectory())
        .map((entry) => ({
        name: entry.name,
        path: path.join(safePath, entry.name)
    }))
        .sort((a, b) => a.name.localeCompare(b.name, "pt-BR", { numeric: true }));
    const parent = path.resolve(safePath) === path.resolve(config.mediaRoot) ? null : path.dirname(safePath);
    return { path: safePath, parent, directories };
}
async function handleApi(req, res) {
    const url = new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`);
    const user = await getCurrentUser(req, res);
    if (url.pathname === "/api/setup/status" && req.method === "GET") {
        const data = await store.read();
        sendJson(res, 200, { setupRequired: !hasConfiguredAdmin(data.users) });
        return;
    }
    if (url.pathname === "/api/setup/admin" && req.method === "POST") {
        const body = await readJson(req);
        const username = body.username?.trim() ?? "";
        const displayName = body.displayName?.trim() ?? "";
        const email = normalizeEmail(body.email ?? "");
        const password = body.password?.trim() ?? "";
        if (!username || !displayName || !email || !password) {
            sendJson(res, 400, { error: "Preencha usuário, nome, e-mail e senha." });
            return;
        }
        if (password.length < 12) {
            sendJson(res, 400, { error: "A senha inicial deve ter pelo menos 12 caracteres." });
            return;
        }
        const data = await store.read();
        if (hasConfiguredAdmin(data.users)) {
            sendJson(res, 409, { error: "Já existe um administrador configurado." });
            return;
        }
        const now = new Date().toISOString();
        const existingAdminIndex = data.users.findIndex((item) => item.role === "admin");
        const userRecord = {
            id: existingAdminIndex >= 0 ? data.users[existingAdminIndex].id : makeUserId(username, data.users),
            username,
            displayName,
            email,
            avatarUrl: "",
            nickname: "",
            biography: "",
            location: "",
            favoriteContentIds: [],
            canLogin: true,
            canDownload: true,
            canChangePassword: true,
            passwordChangeRequiresEmailConfirmation: false,
            lastActiveAt: now,
            role: "admin",
            passwordHash: hashPassword(password),
            allowedLibraryIds: []
        };
        if (existingAdminIndex >= 0) {
            data.users[existingAdminIndex] = userRecord;
        }
        else {
            data.users.push(userRecord);
        }
        await store.write(data);
        setSessionCookie(res, createSessionToken(userRecord.id));
        sendJson(res, 201, { user: toPublicUser(userRecord) });
        return;
    }
    if (url.pathname === "/api/login" && req.method === "POST") {
        const body = await readJson(req);
        const data = await store.read();
        const found = data.users.find((item) => item.username === body.username);
        if (!found || !verifyPassword(found, body.password)) {
            sendJson(res, 401, { error: "Usuário ou senha inválidos." });
            return;
        }
        if (!found.canLogin) {
            sendJson(res, 403, { error: "Esta conta está bloqueada para login." });
            return;
        }
        found.lastActiveAt = new Date().toISOString();
        await store.write(data);
        setSessionCookie(res, createSessionToken(found.id));
        sendJson(res, 200, { user: toPublicUser(found) });
        return;
    }
    if (url.pathname === "/api/auth/google/config" && req.method === "GET") {
        sendJson(res, 200, {
            enabled: Boolean(config.googleClientId),
            clientId: config.googleClientId
        });
        return;
    }
    if (url.pathname === "/api/auth/pugotilab/config" && req.method === "GET") {
        sendJson(res, 200, {
            authUrl: config.pugotilabAuthUrl,
            logoutUrl: config.pugotilabLogoutUrl
        });
        return;
    }
    if (url.pathname === "/api/auth/google" && req.method === "POST") {
        const body = await readJson(req);
        try {
            const inviteToken = body.inviteToken?.trim() ?? "";
            if (!inviteToken) {
                sendJson(res, 403, { error: "Login com Google disponível apenas por convite." });
                return;
            }
            const googleProfile = await verifyGoogleIdToken(body.credential ?? "");
            const email = normalizeEmail(googleProfile.email);
            const data = await store.read();
            const now = new Date().toISOString();
            const invitation = data.invitations.find((item) => item.token === inviteToken && !item.usedAt);
            if (!invitation) {
                sendJson(res, 404, { error: "Convite não encontrado ou já utilizado." });
                return;
            }
            if (invitation.email && normalizeEmail(invitation.email) !== email) {
                sendJson(res, 403, { error: "Use a conta Google do e-mail convidado." });
                return;
            }
            let found = data.users.find((item) => item.googleSub === googleProfile.sub) ?? data.users.find((item) => normalizeEmail(item.email) === email);
            if (!found) {
                const usernameBase = invitation.username.trim() || googleProfile.email.split("@")[0]?.trim() || googleProfile.name?.trim() || "user";
                const username = data.users.some((item) => item.username === usernameBase) ? makeUserId(usernameBase, data.users) : usernameBase;
                found = {
                    id: makeUserId(username, data.users),
                    username,
                    displayName: googleProfile.name?.trim() || invitation.displayName || email,
                    email,
                    avatarUrl: googleProfile.picture ?? "",
                    googleSub: googleProfile.sub,
                    nickname: "",
                    biography: "",
                    location: "",
                    favoriteContentIds: [],
                    canLogin: invitation.canLogin,
                    canDownload: invitation.canDownload,
                    canChangePassword: false,
                    passwordChangeRequiresEmailConfirmation: true,
                    lastActiveAt: now,
                    role: "user",
                    passwordHash: "google-only",
                    allowedLibraryIds: invitation.allowedLibraryIds
                };
                data.users.push(found);
            }
            if (!found.canLogin) {
                sendJson(res, 403, { error: "Esta conta está bloqueada para login." });
                return;
            }
            found.googleSub = googleProfile.sub;
            found.email = email;
            found.avatarUrl = googleProfile.picture ?? found.avatarUrl;
            found.displayName = googleProfile.name?.trim() || found.displayName;
            found.lastActiveAt = now;
            invitation.usedAt = now;
            await store.write(data);
            setSessionCookie(res, createSessionToken(found.id));
            sendJson(res, 200, { user: toPublicUser(found) });
        }
        catch (error) {
            sendJson(res, 401, { error: error instanceof Error ? error.message : "Falha no login com Google." });
        }
        return;
    }
    if (url.pathname === "/api/logout" && req.method === "POST") {
        clearSessionCookie(res);
        sendNoContent(res);
        return;
    }
    if (url.pathname.startsWith("/api/invites/") && req.method === "GET") {
        const token = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const data = await store.read();
        const invitation = data.invitations.find((item) => item.token === token && !item.usedAt);
        if (!invitation) {
            sendJson(res, 404, { error: "Convite não encontrado." });
            return;
        }
        sendJson(res, 200, { invitation });
        return;
    }
    if (url.pathname.startsWith("/api/invites/") && req.method === "POST") {
        const token = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        const data = await store.read();
        const invitation = data.invitations.find((item) => item.token === token && !item.usedAt);
        if (!invitation) {
            sendJson(res, 404, { error: "Convite não encontrado." });
            return;
        }
        const email = normalizeEmail(body.email ?? "");
        const nickname = body.nickname?.trim() ?? "";
        const password = body.password?.trim() ?? "";
        if (!email || !nickname || !password) {
            sendJson(res, 400, { error: "Preencha nickname, e-mail e senha." });
            return;
        }
        if (nickname.length > 40) {
            sendJson(res, 400, { error: "O nickname deve ter até 40 caracteres." });
            return;
        }
        if (invitation.email && normalizeEmail(invitation.email) !== email) {
            sendJson(res, 403, { error: "Use o e-mail convidado." });
            return;
        }
        if (data.users.some((item) => normalizeEmail(item.email) === email)) {
            sendJson(res, 400, { error: "Já existe uma conta com este e-mail." });
            return;
        }
        const usernameBase = invitation.username.trim() || email.split("@")[0] || nickname || "user";
        const username = data.users.some((item) => item.username === usernameBase) ? makeUserId(usernameBase, data.users) : usernameBase;
        const now = new Date().toISOString();
        const user = {
            id: makeUserId(username, data.users),
            username,
            displayName: invitation.displayName || nickname,
            email,
            avatarUrl: "",
            nickname,
            biography: "",
            location: "",
            favoriteContentIds: [],
            canLogin: invitation.canLogin,
            canDownload: invitation.canDownload,
            canChangePassword: true,
            passwordChangeRequiresEmailConfirmation: true,
            lastActiveAt: now,
            role: sanitizeUserRole(invitation.role),
            passwordHash: hashPassword(password),
            allowedLibraryIds: invitation.allowedLibraryIds
        };
        data.users.push(user);
        invitation.usedAt = now;
        await store.write(data);
        setSessionCookie(res, createSessionToken(user.id));
        sendJson(res, 201, { user: toPublicUser(user) });
        return;
    }
    if (url.pathname === "/api/password-reset/request" && req.method === "POST") {
        const body = await readJson(req);
        const email = normalizeEmail(body.email ?? "");
        if (!email) {
            sendJson(res, 400, { error: "Informe o e-mail cadastrado." });
            return;
        }
        const data = await store.read();
        const target = data.users.find((item) => normalizeEmail(item.email) === email);
        if (target && target.email) {
            await issuePasswordResetToken(target);
        }
        sendJson(res, 200, { message: "Se o e-mail estiver cadastrado, você receberá um link para trocar a senha." });
        return;
    }
    if (url.pathname.startsWith("/api/password-reset/") && req.method === "POST") {
        const token = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        const newPassword = body.newPassword?.trim() ?? "";
        if (!token || !newPassword) {
            sendJson(res, 400, { error: "Token ou nova senha inválidos." });
            return;
        }
        if (newPassword.length < 12) {
            sendJson(res, 400, { error: "A senha deve ter pelo menos 12 caracteres." });
            return;
        }
        const resetToken = await store.consumePasswordResetToken(token);
        if (!resetToken || resetToken.purpose !== "password-reset" || Number(new Date(resetToken.expiresAt)) < Date.now()) {
            sendJson(res, 404, { error: "Link de confirmação inválido ou expirado." });
            return;
        }
        const data = await store.read();
        const target = data.users.find((item) => item.id === resetToken.userId && normalizeEmail(item.email) === normalizeEmail(resetToken.email));
        if (!target) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        const updated = await store.updateUser(target.id, {
            passwordHash: hashPassword(newPassword),
            passwordChangeRequiresEmailConfirmation: target.passwordChangeRequiresEmailConfirmation
        });
        if (!updated) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        sendNoContent(res);
        return;
    }
    if (!user) {
        sendJson(res, 401, { error: "Login necessário." });
        return;
    }
    const directContent = url.pathname.match(/^\/api\/contents\/([^/]+)/);
    if (directContent) {
        const id = decodeURIComponent(directContent[1]);
        const library = getRequestLibrary(user, (await store.read()).libraries, id.split(':')[0], req);
        if (library) {
            const canonical = await reconcilePdfLocation(library, id);
            if (canonical !== id) {
                sendJson(res, 404, { error: 'Use o material original da biblioteca.' });
                return;
            }
        }
        if (user.role !== 'admin' && rpgUnclaimedSheet(id)) {
            sendJson(res, 404, { error: 'Conteúdo não encontrado.' });
            return;
        }
        if (url.pathname === `/api/contents/${directContent[1]}/foto-personagem`) {
            await handleCharacterPhoto(req, res, url, user, id);
            return;
        }
    }
    if (url.pathname === "/api/me/reading-settings" && req.method === "GET") {
        const data = await store.read();
        sendJson(res, 200, { readingDefaults: data.settings.readingDefaults });
        return;
    }
    if (url.pathname === "/api/me/startup" && req.method === "GET") {
        const data = await store.read();
        const selected = data.settings.startupLibraries?.[user.id];
        const libraryId = getVisibleLibraries(user, data.libraries).find(item => item.id === selected)?.id ?? null;
        sendJson(res, 200, { libraryId });
        return;
    }
    if (url.pathname === "/api/me" && req.method === "GET") {
        sendJson(res, 200, { user: toPublicUser(user) });
        return;
    }
    if (url.pathname === "/api/me/password" && req.method === "PATCH") {
        const body = await readJson(req);
        if (!user.canChangePassword) {
            sendJson(res, 403, { error: "Esta conta não pode alterar a própria senha." });
            return;
        }
        if (user.passwordChangeRequiresEmailConfirmation) {
            sendJson(res, 403, { error: "Esta conta precisa confirmar a troca por e-mail." });
            return;
        }
        if (!verifyPassword(user, body.currentPassword ?? "") || !body.newPassword?.trim()) {
            sendJson(res, 400, { error: "Senha atual inválida." });
            return;
        }
        await store.updateUser(user.id, { passwordHash: hashPassword(body.newPassword.trim()) });
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/me/password/request" && req.method === "POST") {
        if (!user.canChangePassword) {
            sendJson(res, 403, { error: "Esta conta não pode alterar a própria senha." });
            return;
        }
        if (!user.passwordChangeRequiresEmailConfirmation) {
            sendJson(res, 400, { error: "Esta conta pode trocar a senha diretamente." });
            return;
        }
        if (!user.email) {
            sendJson(res, 400, { error: "Esta conta não possui e-mail cadastrado." });
            return;
        }
        await issuePasswordResetToken(user);
        sendJson(res, 200, { message: "Enviamos um link para confirmar a troca da senha." });
        return;
    }
    if (url.pathname === "/api/personal-vault/unlock" && req.method === "POST") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem acessar o cofre pessoal." });
            return;
        }
        const body = await readJson(req);
        if (!verifyPassword(user, body.password ?? "")) {
            sendJson(res, 400, { error: "Senha inválida." });
            return;
        }
        const data = await store.read();
        const vaultTimeoutMinutes = normalizeVaultTimeoutMinutes(data.settings.vaultTimeoutMinutes);
        const vaultToken = createVaultToken(user.id, vaultTimeoutMinutes);
        res.setHeader("Set-Cookie", `pugotiread_vault=${encodeURIComponent(vaultToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${vaultTimeoutMinutes * 60}`);
        sendJson(res, 200, {
            libraries: getPersonalLibraries(user, data.libraries),
            vaultToken,
            vaultTimeoutMinutes
        });
        return;
    }
    if (url.pathname === "/api/personal-vault/lock" && req.method === "POST") {
        res.setHeader("Set-Cookie", "pugotiread_vault=; HttpOnly; SameSite=Lax; Path=/; Max-Age=0");
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/personal-vault/touch" && req.method === "POST") {
        if (user.role !== "admin" || !hasValidVaultToken(req, user)) {
            sendJson(res, 403, { error: "Cofre bloqueado." });
            return;
        }
        const data = await store.read();
        const vaultTimeoutMinutes = normalizeVaultTimeoutMinutes(data.settings.vaultTimeoutMinutes);
        const vaultToken = createVaultToken(user.id, vaultTimeoutMinutes);
        res.setHeader("Set-Cookie", `pugotiread_vault=${encodeURIComponent(vaultToken)}; HttpOnly; SameSite=Lax; Path=/; Max-Age=${vaultTimeoutMinutes * 60}`);
        sendJson(res, 200, { vaultToken, vaultTimeoutMinutes });
        return;
    }
    if (url.pathname === "/api/me/profile" && req.method === "PATCH") {
        const body = await readJson(req);
        const avatarUrl = body.avatarUrl?.trim() ?? "";
        const nickname = body.nickname?.trim() ?? "";
        const biography = body.biography?.trim() ?? "";
        const location = body.location?.trim() ?? "";
        const favoriteContentIds = Array.from(new Set(body.favoriteContentIds ?? [])).slice(0, 3);
        if (avatarUrl.length > 500_000) {
            sendJson(res, 400, { error: "A imagem do avatar é muito grande." });
            return;
        }
        if (nickname.length > 40 || biography.length > 280 || location.length > 80) {
            sendJson(res, 400, { error: "Confira os limites dos campos do perfil." });
            return;
        }
        const data = await store.read();
        const visibleLibraryIds = new Set(getVisibleLibraries(user, data.libraries).map((library) => library.id));
        if (favoriteContentIds.some((contentId) => !visibleLibraryIds.has(contentId.split(":")[0] ?? ""))) {
            sendJson(res, 400, { error: "Uma das obras favoritas não está disponível para este usuário." });
            return;
        }
        const updated = await store.updateUserProfile(user.id, {
            avatarUrl,
            nickname,
            biography,
            location,
            favoriteContentIds
        });
        if (!updated) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        sendJson(res, 200, { user: toPublicUser(updated) });
        return;
    }
    if (url.pathname === "/api/me/reviews" && req.method === "GET") {
        const data = await store.read();
        const reviews = data.reviews
            .filter((review) => review.userId === user.id)
            .filter((review) => Boolean(findVisibleLibraryForContentId(user, data.libraries, review.contentId)))
            .map((review) => makePublicReview(review, user))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        sendJson(res, 200, { reviews });
        return;
    }
    if (url.pathname === "/api/users" && req.method === "GET") {
        const data = await store.read();
        sendJson(res, 200, {
            users: data.users.map((item) => ({
                id: item.id,
                username: item.username,
                displayName: item.displayName,
                avatarUrl: item.avatarUrl,
                nickname: item.nickname,
                biography: item.biography,
                location: item.location,
                favoriteContentIds: item.favoriteContentIds,
                lastActiveAt: item.lastActiveAt,
                role: item.role,
                reviewCount: getVisibleReviewCountForUser(user, data, item.id)
            }))
        });
        return;
    }
    if (url.pathname === "/api/admin/users" && req.method === "GET") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem ver usuários." });
            return;
        }
        const data = await store.read();
        sendJson(res, 200, { users: data.users.map(toPublicUser), libraries: getVisibleLibraries(user, data.libraries) });
        return;
    }
    if (url.pathname === "/api/admin/settings" && req.method === "GET") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem ver configurações do servidor." });
            return;
        }
        const data = await store.read();
        sendJson(res, 200, { settings: data.settings });
        return;
    }
    if (url.pathname === "/api/admin/settings" && req.method === "PATCH") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem editar configurações do servidor." });
            return;
        }
        const body = await readJson(req);
        if (body.vaultTimeoutMinutes !== undefined && (!Number.isInteger(Number(body.vaultTimeoutMinutes)) || Number(body.vaultTimeoutMinutes) < 1)) {
            sendJson(res, 400, { error: "O tempo do cofre deve ser um número inteiro maior que zero." });
            return;
        }
        if (body.startupLibraries !== undefined) {
            const data = await store.read();
            if (!body.startupLibraries || typeof body.startupLibraries !== "object" || Array.isArray(body.startupLibraries) || Object.entries(body.startupLibraries).some(([id, libraryId]) => {
                const target = data.users.find(item => item.id === id);
                return !target || typeof libraryId !== "string" || (libraryId !== "" && !getVisibleLibraries(target, data.libraries).some(item => item.id === libraryId));
            })) {
                sendJson(res, 400, { error: "Selecione uma biblioteca acessível ao usuário." });
                return;
            }
        }
        const settings = await store.updateSettings({
            startupLibraries: body.startupLibraries,
            vaultTimeoutMinutes: body.vaultTimeoutMinutes === undefined ? undefined : Number(body.vaultTimeoutMinutes),
            readingDefaults: body.readingDefaults === undefined ? undefined : normalizeReadingDefaults(body.readingDefaults)
        });
        sendJson(res, 200, { settings });
        return;
    }
    if (url.pathname === "/api/admin/sync/status" && req.method === "GET") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem acompanhar sincronizações." });
            return;
        }
        sendJson(res, 200, { sync: getPugotiSyncStatus() });
        return;
    }
    if (url.pathname === "/api/admin/sync" && req.method === "POST") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem sincronizar bibliotecas." });
            return;
        }
        const body = await readJson(req);
        const data = await store.read();
        const library = data.libraries.find((item) => item.id === body.libraryId && !item.isPersonal);
        if (!library) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        if (!canSyncLibrary(library)) {
            sendJson(res, 400, { error: "Este tipo de biblioteca não participa da sincronização." });
            return;
        }
        await invalidateLibraryScanCache(library.id);
        const currentContents = await scanLibrary(library, { refresh: true });
        const content = body.contentId
            ? currentContents.find((item) => item.id === body.contentId) ?? null
            : null;
        if (body.contentId && !content) {
            sendJson(res, 404, { error: "Obra não encontrada na biblioteca selecionada." });
            return;
        }
        try {
            const sync = await startPugotiSync(library, content, async () => {
                await invalidateLibraryScanCache(library.id);
                await scanLibrary(library, { refresh: true });
                await store.markLibraryScanned(library.id, new Date().toISOString());
            });
            sendJson(res, 202, { sync });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Não foi possível sincronizar a biblioteca.";
            sendJson(res, message === "Já existe uma sincronização em andamento." ? 409 : 500, { error: message });
        }
        return;
    }
    if (url.pathname === "/api/admin/download" && req.method === "POST") {
        if (user.role !== "admin" && user.role !== "superuser") {
            sendJson(res, 403, { error: "Apenas administradores e superusers podem iniciar downloads." });
            return;
        }
        const body = await readJson(req);
        const requestedKind = body.kind === "manga" || body.kind === "manhwa" || body.kind === "vault" ? body.kind : null;
        const link = String(body.url ?? "").trim();
        if (!requestedKind) {
            sendJson(res, 400, { error: "Selecione Mangá, Manhwa ou Cofre." });
            return;
        }
        let parsedLink;
        try {
            parsedLink = new URL(link);
        }
        catch {
            sendJson(res, 400, { error: "Informe um link válido." });
            return;
        }
        if (!/^https?:$/.test(parsedLink.protocol) || !parsedLink.hostname || !parsedLink.pathname || parsedLink.username || parsedLink.password) {
            sendJson(res, 400, { error: "Informe um link HTTP ou HTTPS válido." });
            return;
        }
        const data = await store.read();
        const vaultLibrary = requestedKind === "vault"
            ? getPersonalLibraries(user, data.libraries).find(canDownloadToLibrary)
            : undefined;
        if (requestedKind === "vault" && !hasValidVaultToken(req, user)) {
            sendJson(res, 403, { error: "Desbloqueie o cofre antes de adicionar uma obra a ele." });
            return;
        }
        const library = vaultLibrary ?? (requestedKind === "vault" ? undefined : findDownloadLibrary(data.libraries, requestedKind));
        if (!library) {
            const label = requestedKind === "vault" ? "cofre pessoal" : requestedKind === "manga" ? "mangás" : "manhwas";
            sendJson(res, 404, { error: `Nenhuma biblioteca de ${label} está configurada.` });
            return;
        }
        const downloadKind = requestedKind === "vault"
            ? (library.kind === "manhwa" ? "manhwa" : "manga")
            : requestedKind;
        try {
            const sync = await startPugotiSync(library, null, async () => {
                await invalidateLibraryScanCache(library.id);
                await scanLibrary(library, { refresh: true });
                await store.markLibraryScanned(library.id, new Date().toISOString());
            }, "manual", { kind: downloadKind, url: parsedLink.toString() });
            const queuePosition = sync.queuedDownloads.length;
            sendJson(res, 202, { sync, queued: queuePosition > 0, queuePosition });
        }
        catch (error) {
            const message = error instanceof Error ? error.message : "Não foi possível iniciar o download.";
            sendJson(res, message === "Já existe uma sincronização em andamento." ? 409 : 500, { error: message });
        }
        return;
    }
    if (url.pathname === "/api/admin/users" && req.method === "POST") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem criar usuários." });
            return;
        }
        const body = await readJson(req);
        const data = await store.read();
        if (data.users.some((item) => item.username === body.username?.trim())) {
            sendJson(res, 400, { error: "Usuário já existe." });
            return;
        }
        try {
            const created = await store.createUser(buildUserFromInput({
                email: body.email,
                displayName: body.displayName,
                username: body.username,
                password: body.password,
                role: sanitizeUserRole(body.role),
                allowedLibraryIds: body.allowedLibraryIds,
                canLogin: body.canLogin,
                canDownload: body.canDownload,
                canChangePassword: body.canChangePassword,
                passwordChangeRequiresEmailConfirmation: false
            }, data.users, data.libraries));
            sendJson(res, 201, { user: toPublicUser(created) });
        }
        catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Não foi possível criar o usuário." });
        }
        return;
    }
    if (url.pathname === "/api/admin/invites" && req.method === "POST") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem criar convites." });
            return;
        }
        const body = await readJson(req);
        const data = await store.read();
        try {
            const token = makeInviteToken();
            const linkOnly = Boolean(body.linkOnly);
            const invitation = {
                token,
                email: linkOnly ? "" : body.email?.trim() ?? "",
                displayName: linkOnly ? "" : body.displayName?.trim() ?? body.username?.trim() ?? "",
                username: linkOnly ? "" : body.username?.trim() ?? "",
                role: sanitizeUserRole(body.role),
                allowedLibraryIds: sanitizeLibraryIds(body.allowedLibraryIds ?? [], data.libraries),
                canLogin: body.canLogin ?? true,
                canDownload: body.canDownload ?? true,
                canChangePassword: body.canChangePassword ?? true,
                createdAt: new Date().toISOString(),
                usedAt: null
            };
            if (!linkOnly && (!invitation.email || !invitation.displayName || !invitation.username)) {
                sendJson(res, 400, { error: "Preencha e-mail, nome e usuário." });
                return;
            }
            await store.createInvitation(invitation);
            sendJson(res, 201, { invitation, inviteUrl: `${new URL(req.url ?? "/", `http://${req.headers.host ?? "localhost"}`).origin}/invite/${token}` });
        }
        catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Não foi possível gerar o convite." });
        }
        return;
    }
    if (url.pathname.startsWith("/api/admin/users/") && req.method === "PATCH") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem editar usuários." });
            return;
        }
        const userId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
        const body = await readJson(req);
        const data = await store.read();
        const existing = data.users.find((item) => item.id === userId);
        if (!existing) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        const updates = {};
        if (body.email !== undefined)
            updates.email = body.email.trim();
        if (body.displayName !== undefined)
            updates.displayName = body.displayName.trim();
        if (body.username !== undefined)
            updates.username = body.username.trim();
        if (body.role !== undefined)
            updates.role = sanitizeUserRole(body.role);
        if (body.allowedLibraryIds !== undefined)
            updates.allowedLibraryIds = sanitizeLibraryIds(body.allowedLibraryIds, data.libraries);
        if (body.canLogin !== undefined)
            updates.canLogin = Boolean(body.canLogin);
        if (body.canDownload !== undefined)
            updates.canDownload = Boolean(body.canDownload);
        if (body.canChangePassword !== undefined)
            updates.canChangePassword = Boolean(body.canChangePassword);
        if (body.password?.trim())
            updates.passwordHash = hashPassword(body.password.trim());
        const updated = await store.updateUser(userId, updates);
        if (!updated) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        sendJson(res, 200, { user: toPublicUser(updated) });
        return;
    }
    if (url.pathname.startsWith("/api/admin/users/") && req.method === "DELETE") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem remover usuários." });
            return;
        }
        const userId = decodeURIComponent(url.pathname.split("/")[4] ?? "");
        if (userId === user.id) {
            sendJson(res, 400, { error: "Você não pode remover sua própria conta." });
            return;
        }
        const deleted = await store.deleteUser(userId);
        if (!deleted) {
            sendJson(res, 404, { error: "Usuário não encontrado." });
            return;
        }
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/libraries" && req.method === "GET") {
        const data = await store.read();
        const libraries = getVisibleLibraries(user, data.libraries);
        sendJson(res, 200, { libraries });
        return;
    }
    if (url.pathname === "/api/libraries" && req.method === "POST") {
        const body = await readJson(req);
        const isPersonal = Boolean(body.isPersonal);
        if (isPersonal && user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem criar bibliotecas pessoais." });
            return;
        }
        if (user.role !== "admin" && !isPersonal) {
            sendJson(res, 403, { error: "Apenas administradores podem criar bibliotecas públicas." });
            return;
        }
        const name = body.name?.trim();
        const libraryPath = body.path?.trim();
        if (!name || !libraryPath || !isLibraryKind(body.kind)) {
            sendJson(res, 400, { error: "Nome, tipo e pasta são obrigatórios." });
            return;
        }
        if (!isInsideMediaRoot(libraryPath)) {
            sendJson(res, 400, { error: `A pasta deve estar dentro de ${config.mediaRoot}.` });
            return;
        }
        const stat = await fs.stat(libraryPath).catch(() => null);
        if (!stat?.isDirectory()) {
            sendJson(res, 400, { error: "A pasta selecionada não existe ou não é um diretório." });
            return;
        }
        const data = await store.read();
        const candidateLibrary = {
            id: makeLibraryId(name, data.libraries),
            name,
            kind: body.kind,
            path: libraryPath,
            isPersonal,
            ownerUserId: isPersonal ? user.id : null
        };
        const detectedContents = await scanLibrary(candidateLibrary, { refresh: true });
        if (detectedContents.length === 0) {
            sendJson(res, 400, { error: getNoDetectedContentMessage(body.kind) });
            return;
        }
        const library = await store.createLibrary({
            id: candidateLibrary.id,
            name,
            kind: body.kind,
            path: libraryPath,
            isPersonal,
            ownerUserId: isPersonal ? user.id : null
        });
        startLibraryWatchers([...data.libraries, library]);
        sendJson(res, 201, { library });
        return;
    }
    if (url.pathname.startsWith("/api/libraries/") && req.method === "PATCH") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem editar bibliotecas." });
            return;
        }
        const libraryId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, libraryId, req);
        if (!library) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        const name = body.name?.trim();
        const libraryPath = body.path?.trim();
        if (!name || !libraryPath || !isLibraryKind(body.kind)) {
            sendJson(res, 400, { error: "Nome, tipo e pasta são obrigatórios." });
            return;
        }
        if (!isInsideMediaRoot(libraryPath)) {
            sendJson(res, 400, { error: `A pasta deve estar dentro de ${config.mediaRoot}.` });
            return;
        }
        const stat = await fs.stat(libraryPath).catch(() => null);
        if (!stat?.isDirectory()) {
            sendJson(res, 400, { error: "A pasta selecionada não existe ou não é um diretório." });
            return;
        }
        const candidateLibrary = {
            ...library,
            name,
            kind: body.kind,
            path: libraryPath
        };
        const detectedContents = await scanLibrary(candidateLibrary, { refresh: true });
        if (detectedContents.length === 0) {
            sendJson(res, 400, { error: getNoDetectedContentMessage(body.kind) });
            return;
        }
        const updated = await store.updateLibrary(library.id, {
            name,
            kind: body.kind,
            path: libraryPath
        });
        if (!updated) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        startLibraryWatchers(data.libraries.map((item) => item.id === updated.id ? updated : item));
        sendJson(res, 200, { library: updated });
        return;
    }
    if (url.pathname.startsWith("/api/libraries/") && req.method === "DELETE") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem apagar bibliotecas." });
            return;
        }
        const libraryId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, libraryId, req);
        if (!library) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        const deleted = await store.deleteLibrary(library.id);
        if (!deleted) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        startLibraryWatchers(data.libraries.filter((item) => item.id !== library.id));
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/admin/folders" && req.method === "GET") {
        try {
            const requestedPath = url.searchParams.get("path") ?? (url.searchParams.get("scope") === "vault" ? config.vaultMediaRoot : config.mediaRoot);
            sendJson(res, 200, await readMediaDirectory(requestedPath));
        }
        catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Não foi possível ler a pasta." });
        }
        return;
    }
    if (url.pathname === "/api/admin/pdf-form-copies" && req.method === "GET") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem gerenciar fichas." });
            return;
        }
        const data = await store.read();
        const contents = (await Promise.all(data.libraries.map(library => scanLibrary(library)))).flat();
        const contentById = new Map(contents.map(content => [content.id, content]));
        const copies = [];
        for (const copy of store.pdfFormCopies())
            copies.push({
                ...copy,
                title: contentById.get(copy.contentId)?.fileTitle ?? contentById.get(copy.contentId)?.title,
                system: rpgDisplaySystem(copy.system || contentById.get(copy.contentId)?.system || "") || "",
                characterName: await copyCharacterName(data.libraries, copy.contentId)
            });
        sendJson(res, 200, { copies });
        return;
    }
    if (url.pathname.startsWith("/api/admin/pdf-form-copies/") && req.method === "PATCH") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem gerenciar fichas." });
            return;
        }
        const contentId = decodeURIComponent(url.pathname.slice("/api/admin/pdf-form-copies/".length));
        const body = await readJson(req);
        try {
            const copy = store.updatePdfFormCopy(contentId, {
                ownerUserId: body.ownerUserId ?? "",
                visibility: body.visibility ?? "private",
                sharedWithUserIds: Array.isArray(body.sharedWithUserIds) ? body.sharedWithUserIds : [],
                system: body.system ?? ""
            });
            if (!copy) {
                sendJson(res, 404, { error: "Ficha não encontrada." });
                return;
            }
            sendJson(res, 200, { copy });
        }
        catch (error) {
            sendJson(res, 400, { error: error instanceof Error ? error.message : "Não foi possível atualizar a ficha." });
        }
        return;
    }
    // Uma obra só: guias abertas direto no título ou no leitor não baixam a biblioteca inteira.
    const obraDaBiblioteca = req.method === "GET" ? url.pathname.match(/^\/api\/libraries\/([^/]+)\/contents\/([^/]+)$/) : null;
    if (obraDaBiblioteca) {
        const contentId = decodeURIComponent(obraDaBiblioteca[2]);
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, decodeURIComponent(obraDaBiblioteca[1]), req);
        const [content] = library ? visibleContents(user, (await scanLibrary(library)).filter((item) => item.id === contentId)) : [];
        if (!content) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        sendJson(res, 200, { content });
        return;
    }
    if (url.pathname.startsWith("/api/libraries/") && url.pathname.endsWith("/contents") && req.method === "GET") {
        const libraryId = url.pathname.split("/")[3];
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, libraryId, req);
        if (!library) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        const contents = visibleContents(user, await scanLibrary(library));
        const limitValue = Number(url.searchParams.get("limit"));
        const offsetValue = Number(url.searchParams.get("offset"));
        const hasPagination = Number.isInteger(limitValue) && limitValue > 0;
        if (!hasPagination) {
            sendJson(res, 200, { contents });
            return;
        }
        const offset = Number.isInteger(offsetValue) && offsetValue >= 0 ? offsetValue : 0;
        const limit = Math.min(limitValue, 100);
        sendJson(res, 200, {
            contents: contents.slice(offset, offset + limit),
            pagination: {
                offset,
                limit,
                total: contents.length,
                hasMore: offset + limit < contents.length
            }
        });
        return;
    }
    if (url.pathname.startsWith("/api/libraries/") && url.pathname.endsWith("/scan") && req.method === "POST") {
        if (user.role !== "admin") {
            sendJson(res, 403, { error: "Apenas administradores podem escanear bibliotecas." });
            return;
        }
        const libraryId = url.pathname.split("/")[3];
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, libraryId, req);
        if (!library) {
            sendJson(res, 404, { error: "Biblioteca não encontrada." });
            return;
        }
        await invalidateLibraryScanCache(library.id);
        if (isSyncSkippedLibraryKind(library.kind)) {
            const contents = await scanLibrary(library, { refresh: true });
            sendJson(res, 200, {
                contents,
                scannedAt: library.lastScannedAt ?? null,
                skipped: true,
                reason: "Livros não participam da sincronização de novos capítulos."
            });
            return;
        }
        const contents = await scanLibrary(library, { refresh: true });
        const scannedAt = new Date().toISOString();
        await store.markLibraryScanned(library.id, scannedAt);
        sendJson(res, 200, { contents, scannedAt });
        return;
    }
    if (url.pathname.startsWith("/api/contents/") && url.pathname.endsWith("/scan") && req.method === "POST") {
        const contentId = decodeURIComponent(url.pathname.replace(/^\/api\/contents\//, "").replace(/\/scan$/, ""));
        const visible = await findVisibleContent(user, contentId);
        if (!visible) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await invalidateLibraryScanCache(visible.library.id);
        if (isSyncSkippedLibraryKind(visible.library.kind)) {
            const contents = await scanLibrary(visible.library, { refresh: true });
            const content = contents.find((item) => item.id === contentId);
            sendJson(res, 200, {
                content,
                scannedAt: visible.library.lastScannedAt ?? null,
                skipped: true,
                reason: "Livros não participam da sincronização de novos capítulos."
            });
            return;
        }
        const contents = await scanLibrary(visible.library, { refresh: true });
        const content = contents.find((item) => item.id === contentId);
        const scannedAt = new Date().toISOString();
        await store.markLibraryScanned(visible.library.id, scannedAt);
        sendJson(res, 200, { content, scannedAt });
        return;
    }
    const rpgMatch = url.pathname.match(/^\/api\/contents\/([^/]+)\/rpg$/);
    if (rpgMatch) {
        const contentId = decodeURIComponent(rpgMatch[1]);
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, contentId.split(':')[0], req);
        if (!library || library.kind !== 'other' || !store.canAccessPdfContent(contentId, user)) {
            sendJson(res, 404, { error: 'Material não encontrado.' });
            return;
        }
        let contents = visibleContents(user, await scanLibrary(library));
        if (!contents.some(item => item.id === contentId))
            contents = visibleContents(user, await scanLibrary(library, { refresh: true }));
        const content = contents.find(item => item.id === contentId && item.pageTypes.includes('pdf'));
        if (!content) {
            sendJson(res, 404, { error: 'PDF não encontrado.' });
            return;
        }
        await handleRpg(req, res, user, library, content, contents);
        return;
    }
    const formMatch = url.pathname.match(/^\/api\/contents\/([^/]+)\/pdf-form(?:\/(copies|save|rename|preview))?$/);
    if (formMatch && (req.method === "GET" || req.method === "POST")) {
        const contentId = decodeURIComponent(formMatch[1]);
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, contentId.split(":")[0], req);
        if (!library || !store.canAccessPdfContent(contentId, user)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const isTemplate = store.rpgDocuments().some(item => item.contentId === contentId && item.role === 'template');
        const canEdit = store.canEditPdfContent(contentId, user);
        // Só administradores e o dono de uma ficha gravam no próprio arquivo. Para os outros, um PDF da biblioteca
        // (modelo registrado ou não, livro com formulário) é sempre preservado: salvar cria a ficha privada da pessoa.
        const ownCopy = store.pdfFormCopies().some(item => item.contentId === contentId && item.ownerUserId === user.id);
        const savesInPlace = !isTemplate && (user.role === 'admin' || ownCopy);
        const permissions = { canSave: canEdit, canEdit, saveCreatesCopy: !savesInPlace };
        if (req.method === 'POST' && !canEdit) {
            sendJson(res, 403, { error: 'Esta ficha foi compartilhada apenas para leitura.' });
            return;
        }
        if (formMatch[2] === 'rename' && !savesInPlace) {
            sendJson(res, 403, { error: isTemplate ? 'O modelo original é preservado. Salve uma cópia pessoal.' : 'Só o proprietário da ficha ou um administrador pode renomear este PDF.' });
            return;
        }
        if (!["other", "book", "lightNovel"].includes(library.kind)) {
            sendJson(res, 400, { error: "Preenchimento disponível nas bibliotecas de livros e RPG." });
            return;
        }
        const source = await getContentPagePath(library, contentId, 0);
        if (!source) {
            sendJson(res, 404, { error: "PDF não encontrado." });
            return;
        }
        try {
            const root = await fs.realpath(library.path);
            const realSource = await fs.realpath(source);
            if (!realSource.startsWith(root + path.sep)) {
                sendJson(res, 403, { error: "Arquivo fora da biblioteca." });
                return;
            }
            if (req.method === "GET" && !formMatch[2]) {
                const revision = await formRevision(realSource), schema = await describeFormWithCalculations(realSource);
                if (revision !== await formRevision(realSource))
                    throw new FormError('A ficha mudou enquanto era aberta. Tente novamente.');
                sendJson(res, 200, { ...schema, ...permissions, revision });
                return;
            }
            if (req.method !== "POST" || !formMatch[2]) {
                sendJson(res, 405, { error: "Método inválido." });
                return;
            }
            if (req.headers["sec-fetch-site"] === "cross-site") {
                sendJson(res, 403, { error: "Origem inválida." });
                return;
            }
            const chunks = [];
            let size = 0;
            for await (const chunk of req) {
                size += Buffer.byteLength(chunk);
                if (size > 4 * 1024 * 1024) {
                    sendJson(res, 413, { error: "Formulário grande demais." });
                    return;
                }
                chunks.push(Buffer.from(chunk));
            }
            const body = JSON.parse(Buffer.concat(chunks).toString());
            if (formMatch[2] === 'preview') {
                const revision = await formRevision(realSource);
                if (revision !== body.revision)
                    throw new FormError('O PDF mudou. Reabra antes de continuar.');
                const calculations = await pdfCalculations(realSource);
                const previewBytes = await fillWithCalculations(realSource, body, calculations);
                const preview = { pdf: Buffer.from(previewBytes).toString('base64'), schema: { ...describePdf(await PDFDocument.load(previewBytes), path.basename(realSource, path.extname(realSource))), calculations, images: await pdfImageFields(realSource) } };
                if (revision !== await formRevision(realSource))
                    throw new FormError('O PDF mudou durante a prévia. Reabra antes de continuar.');
                sendJson(res, 200, { ...preview, schema: { ...preview.schema, revision, ...permissions } });
                return;
            }
            if (formMatch[2] !== 'copies' && savesInPlace) {
                await withFormLock(realSource, async () => {
                    if (await formRevision(realSource) !== body.revision)
                        throw new FormError('A ficha mudou. Reabra antes de salvar ou renomear.');
                    let filename = path.relative(root, realSource), id = contentId;
                    const target = path.join(path.dirname(realSource), body.name === undefined || body.name === '' ? path.basename(realSource) : fullFormName(body.name));
                    const bytes = formMatch[2] === 'save' ? await fillWithCalculations(realSource, body, await pdfCalculations(realSource)) : null;
                    if (target === realSource) {
                        if (bytes)
                            await updateForm(realSource, bytes, body.revision);
                    }
                    else {
                        try {
                            await fs.link(realSource, target);
                        }
                        catch (error) {
                            if (error.code === 'EEXIST')
                                throw new FormError('Já existe uma ficha com esse nome.');
                            throw error;
                        }
                        filename = path.relative(root, target);
                        id = `${library.id}:${Buffer.from(filename).toString('base64url')}`;
                        try {
                            if (bytes)
                                await updateForm(target, bytes, body.revision);
                            if (await formRevision(realSource) !== body.revision)
                                throw new FormError('A ficha mudou. Reabra antes de salvar.');
                            store.renamePdfReferences(contentId, id);
                        }
                        catch (error) {
                            await fs.unlink(target);
                            throw error;
                        }
                        try {
                            await fs.unlink(realSource);
                        }
                        catch (error) {
                            store.renamePdfReferences(id, contentId);
                            await fs.unlink(target);
                            throw error;
                        }
                    }
                    store.updatePdfCopyRevision(id, await formRevision(target));
                    const contents = await scanLibrary(library, { refresh: true });
                    sendJson(res, 200, { filename, previousId: contentId, content: contents.find(item => item.id === id) ?? null, revision: await formRevision(path.join(root, filename)), ...await describeFormWithCalculations(path.join(root, filename)) });
                });
                return;
            }
            const parentCopy = store.pdfFormCopies().find(item => item.contentId === contentId);
            const template = store.rpgDocuments().find(item => item.contentId === contentId && item.role === 'template');
            const links = store.rpgLinks().filter(link => link.templateId === template?.id);
            const moduleId = body.moduleId ?? parentCopy?.moduleId ?? (links.length === 1 ? links[0].moduleId : null);
            if (moduleId && !store.rpgDocuments().some(item => item.id === moduleId && item.role === 'module' && item.contentId.startsWith(library.id + ':') && (parentCopy?.moduleId === moduleId || links.some(link => link.moduleId === moduleId))))
                throw new FormError('Módulo inválido para este modelo.');
            const base = body.name === undefined || body.name === '' ? copyName(source, undefined) : fullFormName(body.name).slice(0, -4);
            if (body.revision !== undefined && body.revision !== await formRevision(realSource))
                throw new FormError('O PDF mudou. Reabra antes de salvar.');
            const bytes = await fillWithCalculations(realSource, body, await pdfCalculations(realSource));
            const destination = library.kind === 'other' ? path.join(root, rpgUserSheetFolder(path.relative(root, realSource), user)) : path.dirname(realSource);
            await fs.mkdir(destination, { recursive: true });
            const destinationPath = await fs.realpath(destination);
            if (destinationPath !== root && !destinationPath.startsWith(root + path.sep))
                throw new FormError('A pasta Fichas deve estar dentro da biblioteca.');
            const publishedName = await publishCopy(destination, base, bytes, name => {
                const relative = path.relative(root, path.join(destination, name));
                const newId = `${library.id}:${Buffer.from(relative).toString('base64url')}`;
                const folder = path.dirname(relative) === '.' ? '' : path.dirname(relative).split(path.sep).join('/');
                store.registerPdfCopy(newId, parentCopy?.sourceId ?? contentId, crypto.createHash('sha256').update(bytes).digest('hex'), user.id, folder);
                store.setPdfCopyModule(newId, moduleId);
            });
            const filename = path.relative(root, path.join(destination, publishedName));
            const id = `${library.id}:${Buffer.from(filename).toString("base64url")}`;
            // Force a completed scan (including a scan already running) so the new
            // item is immediately available through normal library navigation.
            let contents = await scanLibrary(library, { refresh: true });
            if (!contents.some(item => item.id === id))
                contents = await scanLibrary(library, { refresh: true });
            sendJson(res, 201, { filename, content: visibleContents(user, contents).find(item => item.id === id) ?? null });
        }
        catch (error) {
            console.error("Falha no formulário PDF", error);
            sendJson(res, 400, { error: error instanceof FormError ? error.message : "Não foi possível salvar a cópia. Verifique o arquivo e a permissão de escrita da biblioteca." });
        }
        return;
    }
    const epubMetricsMatch = url.pathname.match(/^\/api\/contents\/(.+)\/epub-metrics$/);
    if (epubMetricsMatch && req.method === "GET") {
        const contentId = decodeURIComponent(epubMetricsMatch[1]);
        const data = await store.read();
        const library = getRequestLibrary(user, data.libraries, contentId.split(":")[0] ?? "", req);
        if (!library || !store.canAccessPdfContent(contentId, user)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const lengths = await getContentEpubTextLengths(library, contentId);
        if (!lengths)
            sendJson(res, 404, { error: "EPUB não encontrado." });
        else
            sendJson(res, 200, { lengths });
        return;
    }
    const epubSearchMatch = url.pathname.match(/^\/api\/contents\/(.+)\/epub-search$/);
    if (epubSearchMatch && req.method === "GET") {
        const contentId = decodeURIComponent(epubSearchMatch[1]);
        const termo = (url.searchParams.get("q") ?? "").trim();
        const data = await store.read();
        const libraryId = contentId.split(":")[0] ?? "";
        const library = getRequestLibrary(user, data.libraries, libraryId, req);
        if (!library || !store.canAccessPdfContent(contentId, user)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const resultado = await searchEpubText(library, contentId, termo);
        sendJson(res, 200, resultado);
        return;
    }
    if (url.pathname.startsWith("/api/contents/") && (req.method === "GET" || req.method === "HEAD")) {
        const epubAssetRequest = parseContentEpubAssetPath(url.pathname);
        if (epubAssetRequest) {
            const data = await store.read();
            const libraryId = epubAssetRequest.contentId.split(":")[0] ?? "";
            const library = getRequestLibrary(user, data.libraries, libraryId, req);
            if (!library || !store.canAccessPdfContent(epubAssetRequest.contentId, user)) {
                sendJson(res, 404, { error: "Conteúdo não encontrado." });
                return;
            }
            const asset = await getContentEpubAsset(library, epubAssetRequest.contentId, epubAssetRequest.assetPath);
            if (!asset) {
                sendJson(res, 404, { error: "Arquivo do EPUB não encontrado." });
                return;
            }
            sendBuffer(req, res, asset.path, asset.data);
            return;
        }
        const coverRequest = parseContentCoverPath(url.pathname);
        if (coverRequest) {
            const data = await store.read();
            const libraryId = coverRequest.contentId.split(":")[0] ?? "";
            const library = getRequestLibrary(user, data.libraries, libraryId, req);
            if (!library || !store.canAccessPdfContent(coverRequest.contentId, user)) {
                sendJson(res, 404, { error: "Conteúdo não encontrado." });
                return;
            }
            const thumbPath = await getContentCoverThumbnail(library, coverRequest.contentId);
            if (thumbPath) {
                await sendFile(req, res, thumbPath, url.searchParams.has("v") ? "private, max-age=31536000, immutable" : "private, no-cache, must-revalidate");
                return;
            }
            const coverPath = await getContentCoverPath(library, coverRequest.contentId);
            if (!coverPath) {
                sendJson(res, 404, { error: "Capa não encontrada." });
                return;
            }
            await sendFile(req, res, coverPath, url.searchParams.has("v") ? "private, max-age=31536000, immutable" : "private, no-cache, must-revalidate");
            return;
        }
        const pageRequest = parseContentPagePath(url.pathname);
        if (!pageRequest) {
            sendJson(res, 404, { error: "Página não encontrada." });
            return;
        }
        const data = await store.read();
        const libraryId = pageRequest.contentId.split(":")[0] ?? "";
        const library = getRequestLibrary(user, data.libraries, libraryId, req);
        if (!library || !store.canAccessPdfContent(pageRequest.contentId, user)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const bookTheme = url.searchParams.get("theme") === "dark" ? "dark" : url.searchParams.get("theme") === "sepia" ? "sepia" : "light";
        const readDirection = url.searchParams.get("direction") === "rtl" ? "rtl" : "ltr";
        const epubHtml = await getContentEpubChapterHtml(library, pageRequest.contentId, pageRequest.pageIndex, bookTheme, readDirection);
        if (epubHtml) {
            sendHtml(req, res, epubHtml);
            return;
        }
        const pagePath = await getContentPagePath(library, pageRequest.contentId, pageRequest.pageIndex);
        if (!pagePath) {
            sendJson(res, 404, { error: "Página não encontrada." });
            return;
        }
        // Access checks above run for every request, including cached variants.
        // Range requests always address the original file's byte representation.
        if (!req.headers.range) {
            const variant = await pageImageVariant(pagePath, url.searchParams.get("width")).catch(() => null);
            if (variant) {
                const headers = { "Content-Type": "image/webp", "Cache-Control": "private, max-age=3600", "ETag": variant.etag };
                if (req.headers["if-none-match"] === variant.etag) {
                    res.writeHead(304, headers);
                    res.end();
                    return;
                }
                res.writeHead(200, { ...headers, "Content-Length": String(variant.data.length) });
                res.end(req.method === "HEAD" ? undefined : variant.data);
                return;
            }
        }
        await sendFile(req, res, pagePath, path.extname(pagePath).toLowerCase() === '.pdf' ? 'no-cache, private, must-revalidate' : undefined);
        return;
    }
    if (url.pathname === "/api/continue" && req.method === "GET") {
        const data = await store.read();
        const progress = data.progress.filter((item) => item.userId === user.id);
        sendJson(res, 200, { progress });
        return;
    }
    if (url.pathname === "/api/user-lists" && req.method === "GET") {
        const data = await store.read();
        const wantToRead = data.wantToRead.filter((item) => item.userId === user.id).map((item) => item.contentId);
        const readingList = data.readingList.filter((item) => item.userId === user.id).map((item) => item.contentId);
        const collections = data.collections
            .filter((item) => item.userId === user.id || item.sharedWithUserIds.includes(user.id))
            .map((collection) => makePublicCollection(collection, data.users.find((item) => item.id === collection.userId)));
        sendJson(res, 200, { wantToRead, readingList, collections });
        return;
    }
    if (url.pathname === "/api/collections" && req.method === "POST") {
        const body = await readJson(req);
        const name = body.name?.trim();
        const description = body.description?.trim() ?? "";
        if (!name) {
            sendJson(res, 400, { error: "Informe o nome da coleção." });
            return;
        }
        if (name.length > 80) {
            sendJson(res, 400, { error: "O nome da coleção deve ter até 80 caracteres." });
            return;
        }
        if (description.length > 240) {
            sendJson(res, 400, { error: "A descrição deve ter até 240 caracteres." });
            return;
        }
        const data = await store.read();
        const collection = await store.createCollection({
            id: makeCollectionId(name, user.id, data.collections),
            userId: user.id,
            name,
            description,
            sharedWithUserIds: [],
            contentIds: [],
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        });
        sendJson(res, 201, { collection: makePublicCollection(collection, user) });
        return;
    }
    if (url.pathname.startsWith("/api/collections/") && url.pathname.endsWith("/sharing") && req.method === "PUT") {
        const collectionId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        const data = await store.read();
        const allowedUserIds = new Set(data.users.map((item) => item.id));
        const sharedWithUserIds = Array.from(new Set((body.userIds ?? []).filter((userId) => userId !== user.id && allowedUserIds.has(userId))));
        const collection = await store.updateCollectionSharing(user.id, collectionId, sharedWithUserIds);
        if (!collection) {
            sendJson(res, 404, { error: "Coleção não encontrada." });
            return;
        }
        sendJson(res, 200, { collection: makePublicCollection(collection, user) });
        return;
    }
    if (url.pathname.startsWith("/api/collections/") && !url.pathname.endsWith("/contents") && req.method === "PATCH") {
        const collectionId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        const name = body.name?.trim();
        const description = body.description?.trim() ?? "";
        if (!collectionId) {
            sendJson(res, 400, { error: "Coleção não informada." });
            return;
        }
        if (!name) {
            sendJson(res, 400, { error: "Informe o nome da coleção." });
            return;
        }
        if (name.length > 80) {
            sendJson(res, 400, { error: "O nome da coleção deve ter até 80 caracteres." });
            return;
        }
        if (description.length > 240) {
            sendJson(res, 400, { error: "A descrição deve ter até 240 caracteres." });
            return;
        }
        const collection = await store.updateCollection(user.id, collectionId, { name, description });
        if (!collection) {
            sendJson(res, 404, { error: "Coleção não encontrada." });
            return;
        }
        sendJson(res, 200, { collection: makePublicCollection(collection, user) });
        return;
    }
    if (url.pathname.startsWith("/api/collections/") && !url.pathname.endsWith("/contents") && !url.pathname.endsWith("/sharing") && req.method === "DELETE") {
        const collectionId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const deleted = await store.deleteCollection(user.id, collectionId);
        if (!deleted) {
            sendJson(res, 404, { error: "Coleção não encontrada." });
            return;
        }
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/bookmarks" && req.method === "GET") {
        const data = await store.read();
        const bookmarks = data.bookmarks.filter((item) => item.userId === user.id);
        if (url.searchParams.get("includeContents") === "1") {
            const libraryIds = new Set(bookmarks.map((item) => item.contentId.split(":")[0]));
            const libraries = data.libraries.filter((library) => libraryIds.has(library.id) && getRequestLibrary(user, data.libraries, library.id, req));
            const scanned = (await Promise.all(libraries.map(async (library) => {
                const libraryMarks = bookmarks.filter(item => item.contentId.startsWith(library.id + ':'));
                const missing = await Promise.all(libraryMarks.map(item => pdfLocationMissing(library, item.contentId)));
                return scanLibrary(library, { refresh: missing.some(Boolean) });
            }))).flat();
            // Scanning can migrate IDs after a file move. Read marks AFTER reconciliation.
            const currentBookmarks = (await store.read()).bookmarks.filter((item) => item.userId === user.id);
            const ids = new Set(currentBookmarks.map((item) => item.contentId));
            const contents = scanned.filter((content) => ids.has(content.id) && store.canAccessPdfContent(content.id, user));
            const accessible = new Set(contents.map((content) => content.id));
            sendJson(res, 200, { bookmarks: currentBookmarks.filter((item) => accessible.has(item.contentId)), contents });
            return;
        }
        sendJson(res, 200, { bookmarks });
        return;
    }
    if (url.pathname === "/api/reviews" && req.method === "GET") {
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId) {
            sendJson(res, 400, { error: "Conteúdo não informado." });
            return;
        }
        const data = await store.read();
        if (!await findVisibleContent(user, contentId)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const visibleReviews = data.reviews
            .filter((item) => item.contentId === contentId)
            .map((review) => {
            const author = data.users.find((item) => item.id === review.userId);
            if (!author) {
                return null;
            }
            return makePublicReview(review, author);
        })
            .filter((item) => Boolean(item))
            .sort((a, b) => b.updatedAt.localeCompare(a.updatedAt));
        sendJson(res, 200, { reviews: visibleReviews });
        return;
    }
    if (url.pathname === "/api/progress" && req.method === "PUT") {
        const body = await readJson(req);
        const visible = await findRequestContent(user, body.contentId, req);
        if (!visible) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.upsertProgress({
            userId: user.id,
            contentId: body.contentId,
            currentPage: Math.min(Math.max(Number(body.currentPage), 0), Math.max(visible.pageCount - 1, 0)),
            epubOffset: Number.isFinite(body.epubOffset)
                ? Math.min(Math.max(Number(body.epubOffset), 0), 1) : 0,
            updatedAt: new Date().toISOString()
        });
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/progress" && req.method === "DELETE") {
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId) {
            sendJson(res, 400, { error: "Conteúdo não informado." });
            return;
        }
        const data = await store.read();
        if (!findVisibleLibraryForContentId(user, data.libraries, contentId)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.removeProgress(user.id, contentId);
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/bookmarks" && (req.method === "POST" || req.method === "PATCH")) {
        const body = await readJson(req);
        if (!body || typeof body.contentId !== "string" || !body.contentId ||
            typeof body.page !== "number" || !Number.isSafeInteger(body.page) || body.page < 0) {
            sendJson(res, 400, { error: "Informe uma obra e uma página válida." });
            return;
        }
        if (req.method === "PATCH" && (typeof body.name !== "string" || body.name.trim().length > 120)) {
            sendJson(res, 400, { error: "O nome deve ter até 120 caracteres." });
            return;
        }
        if (!await findRequestContent(user, body.contentId, req)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        if (req.method === "PATCH") {
            const bookmark = await store.renameBookmark(user.id, body.contentId, body.page, body.name.trim());
            if (!bookmark) {
                sendJson(res, 404, { error: "Página marcada não encontrada." });
                return;
            }
            sendJson(res, 200, { bookmark });
            return;
        }
        const result = await store.toggleBookmark({
            userId: user.id, contentId: body.contentId, page: body.page,
            createdAt: new Date().toISOString()
        });
        sendJson(res, 200, result);
        return;
    }
    if (url.pathname === "/api/reviews" && req.method === "POST") {
        const body = await readJson(req);
        const contentId = body.contentId?.trim();
        const rating = Number(body.rating);
        const comment = body.comment?.trim();
        if (!contentId || !Number.isFinite(rating) || rating < 0 || rating > 10 || !comment) {
            sendJson(res, 400, { error: "Conteúdo, nota e comentário são obrigatórios." });
            return;
        }
        const data = await store.read();
        if (!findVisibleLibraryForContentId(user, data.libraries, contentId)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const review = {
            userId: user.id,
            contentId,
            rating,
            comment,
            createdAt: new Date().toISOString(),
            updatedAt: new Date().toISOString()
        };
        await store.upsertReview(review);
        sendJson(res, 200, { review: makePublicReview(review, user) });
        return;
    }
    if (url.pathname === "/api/series-marks" && req.method === "GET") {
        const data = await store.read();
        const seriesMarks = data.seriesMarks.filter((item) => item.userId === user.id).map((item) => item.contentId);
        sendJson(res, 200, { seriesMarks });
        return;
    }
    if (url.pathname === "/api/series-marks" && req.method === "POST") {
        const body = await readJson(req);
        const result = await store.toggleSeriesMark({
            userId: user.id,
            contentId: body.contentId,
            createdAt: new Date().toISOString()
        });
        sendJson(res, 200, result);
        return;
    }
    if (url.pathname === "/api/want-to-read" && req.method === "POST") {
        const body = await readJson(req);
        if (!(await findVisibleContent(user, body.contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.addToWantToRead({
            userId: user.id,
            contentId: body.contentId,
            createdAt: new Date().toISOString()
        });
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/want-to-read" && req.method === "DELETE") {
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId || !(await findVisibleContent(user, contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.removeFromWantToRead(user.id, contentId);
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/reading-list" && req.method === "POST") {
        const body = await readJson(req);
        if (!(await findVisibleContent(user, body.contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.addToReadingList({
            userId: user.id,
            contentId: body.contentId,
            createdAt: new Date().toISOString()
        });
        sendNoContent(res);
        return;
    }
    if (url.pathname === "/api/reading-list" && req.method === "DELETE") {
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId || !(await findVisibleContent(user, contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.removeFromReadingList(user.id, contentId);
        sendNoContent(res);
        return;
    }
    if (url.pathname.startsWith("/api/collections/") && url.pathname.endsWith("/contents") && req.method === "POST") {
        const collectionId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const body = await readJson(req);
        if (!(await findVisibleContent(user, body.contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const collection = await store.addToCollection(user.id, collectionId, body.contentId);
        if (!collection) {
            sendJson(res, 404, { error: "Coleção não encontrada." });
            return;
        }
        sendJson(res, 200, { collection: makePublicCollection(collection, user) });
        return;
    }
    if (url.pathname.startsWith("/api/collections/") && url.pathname.endsWith("/contents") && req.method === "DELETE") {
        const collectionId = decodeURIComponent(url.pathname.split("/")[3] ?? "");
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId || !(await findVisibleContent(user, contentId))) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        const collection = await store.removeFromCollection(user.id, collectionId, contentId);
        if (!collection) {
            sendJson(res, 404, { error: "Coleção não encontrada." });
            return;
        }
        sendJson(res, 200, { collection: makePublicCollection(collection, user) });
        return;
    }
    if (url.pathname === "/api/content-state" && req.method === "DELETE") {
        const contentId = url.searchParams.get("contentId") ?? "";
        if (!contentId) {
            sendJson(res, 400, { error: "Conteúdo não informado." });
            return;
        }
        const data = await store.read();
        if (!findVisibleLibraryForContentId(user, data.libraries, contentId)) {
            sendJson(res, 404, { error: "Conteúdo não encontrado." });
            return;
        }
        await store.removeContentForUser(user.id, contentId);
        sendNoContent(res);
        return;
    }
    sendJson(res, 404, { error: "Rota não encontrada." });
}
// ---- fichas automatizadas de RPG (PQA-292 a 295) ----
// O código fica em data/fichas-app (pasta montada: sobrevive à recriação do contêiner). Se faltar ou falhar ao
// carregar, o Pugotiread segue normal.
let fichasModulo;
const fichasDataDir = path.dirname(config.dbFile);
async function carregarFichas() {
    if (fichasModulo === undefined) {
        try {
            fichasModulo = await import(pathToFileURL(path.join(fichasDataDir, "fichas-app/servidor/fichas.js")).href);
        }
        catch (error) {
            console.error("[fichas] módulo indisponível:", error?.message ?? error);
            fichasModulo = null;
        }
    }
    return fichasModulo;
}
const fichasDeps = { dataDir: fichasDataDir, webDir: path.join(fichasDataDir, "fichas-app"), sendJson, readJson, sendFile, Database: FichasDatabase };
async function nomesUsuariosFichas() {
    return new Map((await store.read()).users.map((item) => [item.id, item.displayName || item.username || item.id]));
}
const server = http.createServer(async (req, res) => {
    try {
        if (/^\/(?:api\/)?fichas(?:[/?]|$)/.test(req.url ?? "")) {
            const fichas = await carregarFichas();
            if (fichas) {
                const url = new URL(req.url ?? "/", "http://localhost");
                const user = url.pathname.startsWith("/api/") ? await getCurrentUser(req, res) : null;
                if (await fichas.tratarFichas(req, res, url, user, fichasDeps, nomesUsuariosFichas))
                    return;
            }
        }
        if (req.url === "/health") {
            sendJson(res, 200, {
                status: "ok",
                uptimeSeconds: Math.round(process.uptime()),
                timestamp: new Date().toISOString()
            });
            return;
        }
        if (req.url?.startsWith("/api/")) {
            await handleApi(req, res);
            return;
        }
        // JS/CSS sem ?v= são módulos importados por outros arquivos (series-card.js, views/*.js…): com max-age de 1 h o
        // navegador podia continuar com a versão antiga depois de uma atualização. Agora ele sempre confere (ETag/304).
        const staticUrl = new URL(req.url ?? "/", "http://localhost");
        if (/\.(?:js|mjs|css)$/i.test(staticUrl.pathname) && !staticUrl.searchParams.has("v")) {
            // O Cloudflare comprime e devolve o ETag como fraco (W/"…"); sem isso a revalidação nunca dava 304.
            if (typeof req.headers["if-none-match"] === "string")
                req.headers["if-none-match"] = req.headers["if-none-match"].replace(/W\//g, "");
            const writeHead = res.writeHead.bind(res);
            res.writeHead = (status, ...rest) => {
                const headers = rest.find(item => item && typeof item === "object" && !Array.isArray(item));
                if (headers && "Cache-Control" in headers)
                    headers["Cache-Control"] = "private, no-cache";
                return writeHead(status, ...rest);
            };
        }
        await serveStatic(req, res);
    }
    catch (error) {
        console.error(error);
        sendJson(res, 500, { error: "Erro interno do Pugotiread." });
    }
});
// Backfill filesystem identities before accepting requests, including pre-existing sheets.
const initialLibraries = (await store.read()).libraries;
for (const item of [...store.rpgDocuments(), ...store.pdfFormCopies()]) {
    const library = initialLibraries.find(library => item.contentId.startsWith(library.id + ':'));
    if (library)
        await reconcilePdfLocation(library, item.contentId);
}
server.listen(config.port, () => {
    if (!config.smtpHost) {
        console.warn("[SMTP] SMTP_HOST nao configurado. Recuperacao de senha vai cair no console.");
    }
    console.log(`Pugotiread rodando em http://localhost:${config.port}`);
    void store.read().then((data) => startLibraryWatchers(data.libraries)).catch((error) => {
        console.error("[MEDIA] Não foi possível iniciar os observadores de bibliotecas:", error);
    });
    if (config.pugotiAutoSyncEnabled) {
        console.log(`[SYNC] Sincronização automática ativa a cada ${Math.round(config.pugotiSyncIntervalMs / 60000)} minutos.`);
        const initialTimer = setTimeout(() => {
            void runAutomaticSyncCycle();
        }, 60 * 1000);
        initialTimer.unref();
        const interval = setInterval(() => {
            void runAutomaticSyncCycle();
        }, config.pugotiSyncIntervalMs);
        interval.unref();
    }
    else {
        console.log("[SYNC] Sincronização automática desativada.");
    }
});
