import { getDocument, GlobalWorkerOptions } from '/pdfjs/pdf.mjs';

GlobalWorkerOptions.workerSrc = '/pdfjs/pdf.worker.mjs';
const params = new URLSearchParams(location.search);
const status = document.querySelector('#status');
const pages = document.querySelector('#pages');
const prepare = document.querySelector('#prepare');
const print = document.querySelector('#print');
const sheets = document.querySelector('#sheets');
const original = document.querySelector('#original');
const objectUrls = [];
let pdf;
document.querySelector('#title').textContent = params.get('title') || 'Documento PDF';
document.title = params.get('title') || 'Imprimir PDF';

function selectedPages(value, total) {
  if (!value.trim()) return Array.from({ length: total }, (_, i) => i + 1);
  const result = new Set();
  for (const token of value.split(',')) {
    const match = token.trim().match(/^(\d+)(?:\s*-\s*(\d+))?$/);
    if (!match) throw new Error('Informe páginas como 1-4, 8.');
    const start = Number(match[1]);
    const end = Number(match[2] || match[1]);
    if (start < 1 || end < start || end > total) throw new Error(`Use páginas entre 1 e ${total}.`);
    for (let n = start; n <= end; n++) result.add(n);
  }
  return [...result].sort((a, b) => a - b);
}

try {
  const url = new URL(params.get('url') || '', location.origin);
  if (!params.get('url') || url.origin !== location.origin || !url.pathname.startsWith('/api/')) {
    throw new Error('Endereço do PDF inválido. Abra a impressão pelo leitor.');
  }
  original.href = url.href;
  original.hidden = false;
  pdf = await getDocument({ url: url.href }).promise;
  status.textContent = `${pdf.numPages} páginas. Escolha o intervalo e prepare a impressão.`;
  pages.disabled = prepare.disabled = false;
} catch (error) {
  status.textContent = `Não foi possível carregar o PDF: ${error.message}`;
}

print.addEventListener('click', () => window.print());
const pageStyle = document.createElement('style');
document.head.append(pageStyle);
document.querySelector('#options').addEventListener('submit', async (event) => {
  event.preventDefault();
  if (!pdf || prepare.disabled) return;
  try {
    const selection = selectedPages(pages.value, pdf.numPages);
    prepare.disabled = pages.disabled = true;
    print.hidden = true;
    sheets.replaceChildren();
    objectUrls.splice(0).forEach(url => URL.revokeObjectURL(url));
    pageStyle.textContent = '';
    for (const [index, number] of selection.entries()) {
      status.textContent = `Preparando página ${number} (${index + 1} de ${selection.length})…`;
      const page = await pdf.getPage(number);
      const natural = page.getViewport({ scale: 1 });
      const viewport = page.getViewport({ scale: 150 / 72 });
      const canvas = document.createElement('canvas');
      canvas.width = Math.ceil(viewport.width);
      canvas.height = Math.ceil(viewport.height);
      await page.render({ canvasContext: canvas.getContext('2d'), viewport, intent: 'print' }).promise;
      const blob = await new Promise(resolve => canvas.toBlob(resolve, 'image/jpeg', .95));
      if (!blob) throw new Error('Falha ao preparar a página.');
      const url = URL.createObjectURL(blob);
      objectUrls.push(url);
      const image = new Image();
      image.src = url;
      await image.decode();
      const sheet = document.createElement('section');
      sheet.className = 'sheet';
      sheet.style.cssText = `page: pdf${index}; width:${natural.width}pt; height:${natural.height}pt`;
      pageStyle.textContent += `@page pdf${index} { size: ${natural.width}pt ${natural.height}pt; margin: 0; }\n`;
      sheet.append(image);
      sheets.append(sheet);
      canvas.width = canvas.height = 0;
      page.cleanup();
    }
    print.hidden = false;
    status.textContent = 'Documento pronto. Se a janela não abrir automaticamente, clique em Imprimir.';
    await new Promise(resolve => requestAnimationFrame(() => requestAnimationFrame(resolve)));
    window.print();
  } catch (error) {
    status.textContent = `Não foi possível preparar a impressão: ${error.message}`;
  } finally {
    prepare.disabled = pages.disabled = false;
  }
});
window.addEventListener('pagehide', () => objectUrls.forEach(url => URL.revokeObjectURL(url)));
