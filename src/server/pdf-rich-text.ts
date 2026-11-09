import { PDFDocument, PDFTextField, PDFName, PDFHexString, StandardFonts, rgb, beginText, endText, setFontAndSize, setTextMatrix, showText, setFillingColor, setStrokingColor, setLineWidth, moveTo, lineTo, stroke, type PDFOperator, type PDFFont } from 'pdf-lib';
import { type TextRun, mergeRuns } from '../shared/pdf-rich-text.js';
const key = PDFName.of('PugotiRichText');
export function readRich(field: PDFTextField): TextRun[] | undefined {
  const value = field.acroField.dict.get(key);
  if (!(value instanceof PDFHexString)) return;
  try { return validateRuns(JSON.parse(value.decodeText()), field.getText() ?? ''); } catch { return; }
}
export function validateRuns(value: unknown, text: string): TextRun[] {
  if (!Array.isArray(value) || value.length > 10000) throw new Error('Formatação de texto inválida.');
  for (const r of value) {
    if (!r || typeof r !== 'object' || typeof r.text !== 'string' || !['helvetica','times','courier'].includes(r.font) || !Number.isFinite(r.fontSize) || r.fontSize < 4 || r.fontSize > 72 || typeof r.color !== 'string' || !/^#[\da-f]{6}$/i.test(r.color) || ['bold','italic','underline'].some(k => r[k] !== undefined && typeof r[k] !== 'boolean')) throw new Error('Formatação de texto inválida.');
  }
  if (text.length > 10000 || value.map(r => r.text).join('') !== text) throw new Error('Texto e formatação não correspondem.');
  return mergeRuns(value.map(r=>({text:r.text,font:r.font,fontSize:r.fontSize,color:r.color,bold:!!r.bold,italic:!!r.italic,underline:!!r.underline})));
}
function fontName(r: TextRun): StandardFonts {
  if (r.font === 'times') return r.bold ? (r.italic ? StandardFonts.TimesRomanBoldItalic : StandardFonts.TimesRomanBold) : (r.italic ? StandardFonts.TimesRomanItalic : StandardFonts.TimesRoman);
  if (r.font === 'courier') return r.bold ? (r.italic ? StandardFonts.CourierBoldOblique : StandardFonts.CourierBold) : (r.italic ? StandardFonts.CourierOblique : StandardFonts.Courier);
  return r.bold ? (r.italic ? StandardFonts.HelveticaBoldOblique : StandardFonts.HelveticaBold) : (r.italic ? StandardFonts.HelveticaOblique : StandardFonts.Helvetica);
}
/** Keep editable values and rich metadata, with an ordinary PDF appearance for other readers. */
export async function writeRich(doc: PDFDocument, field: PDFTextField, runs: TextRun[]) {
  field.acroField.dict.set(key, PDFHexString.fromText(JSON.stringify(runs)));
  const fonts = new Map<string, PDFFont>();
  for (const run of runs) if (!fonts.has(fontName(run))) fonts.set(fontName(run), await doc.embedFont(fontName(run)));
  for (const widget of field.acroField.getWidgets()) {
    const { width, height } = widget.getRectangle();
    type Part = { text: string; run: TextRun; font: PDFFont; width: number };
    const lines: Part[][] = [[]]; let used = 0;
    for (const run of runs) {
      const font = fonts.get(fontName(run))!;
      for (const token of run.text.split(/(\n|[^\S\n]+|[^\s]+)/).filter(Boolean)) {
        if (token === '\n') { lines.push([]); used = 0; continue; }
        const size = font.widthOfTextAtSize(token, run.fontSize);
        if (used && used + size > width) { lines.push([]); used = 0; }
        for (const char of token) {
          const w = font.widthOfTextAtSize(char, run.fontSize);
          if (used && used + w > width) { lines.push([]); used = 0; }
          lines.at(-1)!.push({text:char,run,font,width:w}); used += w;
        }
      }
    }
    const ops: PDFOperator[] = []; let top = height;
    for (const line of lines) {
      const size = Math.max(12, ...line.map(p=>p.run.fontSize));
      const lineHeight = size * 1.2; top -= lineHeight;
      if (top < -0.01) throw new Error('O texto ultrapassa a área da página. Adicione outra página ou reduza a fonte antes de salvar.');
      const total = line.reduce((n,p)=>n+p.width,0), alignment=field.getAlignment();
      let x = alignment === 1 ? (width-total)/2 : alignment === 2 ? width-total : 0;
      const y = top + size * .25;
      for (const p of line) {
        const color=rgb(parseInt(p.run.color.slice(1,3),16)/255,parseInt(p.run.color.slice(3,5),16)/255,parseInt(p.run.color.slice(5,7),16)/255);
        ops.push(beginText(),setFillingColor(color),setFontAndSize(p.font.name,p.run.fontSize),setTextMatrix(1,0,0,1,x,y),showText(p.font.encodeText(p.text)),endText());
        if(p.run.underline) ops.push(setStrokingColor(color),setLineWidth(Math.max(.5,p.run.fontSize/18)),moveTo(x,y-p.run.fontSize*.12),lineTo(x+p.width,y-p.run.fontSize*.12),stroke());
        x+=p.width;
      }
    }
    const stream=doc.context.formXObject(ops,{Resources:{Font:Object.fromEntries([...fonts.values()].map(f=>[f.name,f.ref]))},BBox:doc.context.obj([0,0,width,height]),Matrix:doc.context.obj([1,0,0,1,0,0])});
    widget.setNormalAppearance(doc.context.register(stream));
  }
  doc.getForm().markFieldAsClean(field.ref);
}
