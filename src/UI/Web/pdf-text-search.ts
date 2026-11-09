// Match offsets are mapped back to PDF.js TextLayer textDivs, as in Mozilla's
// TextHighlighter. A match expands to Unicode word boundaries, not item bounds.
export type TextItem = { str?: string; hasEOL?: boolean; transform?: number[]; width?: number; height?: number; dir?: string };
export type TextMatch = { start: number; end: number };
export type TextIndex = { text: string; segments: { start: number; end: number; index: number }[] };

export function indexText(items: TextItem[]): TextIndex {
  let text = "";
  const segments: TextIndex["segments"] = [];
  let previous: TextItem | undefined;
  for (const item of items) {
    if (typeof item.str !== "string") continue;
    if (previous && !/\s$/u.test(text) && !/^\s/u.test(item.str)) {
      const a = previous.transform, b = item.transform;
      const font = a ? Math.hypot(a[0], a[1]) : 0;
      const angle = a ? Math.atan2(a[1], a[0]) : 0;
      const dx = a && b ? b[4] - a[4] : 0, dy = a && b ? b[5] - a[5] : 0;
      const along = dx * Math.cos(angle) + dy * Math.sin(angle);
      const across = -dx * Math.sin(angle) + dy * Math.cos(angle);
      const gap = along - (previous.width ?? 0);
      const lineBreak = previous.hasEOL || (font > 0 && Math.abs(across) > font * .5);
      if (lineBreak || (font > 0 && gap > font * .15)) text += "\n";
    }
    segments.push({ start: text.length, end: text.length + item.str.length, index: segments.length });
    text += item.str;
    previous = item;
  }
  return { text, segments };
}

function fold(value: string): string {
  return value.normalize("NFKD").replace(/\p{M}/gu, "").toLocaleLowerCase("pt-BR");
}

export function findWords(text: string, query: string): TextMatch[] {
  // Preserve the original offsets when case folding, accents or ligatures change length.
  let normalized = "";
  const starts: number[] = [], ends: number[] = [];
  let offset = 0;
  for (const char of text) {
    const value = /[\u00ad\u200b]/u.test(char) ? "" : fold(char);
    for (const unit of value) {
      const normalizedUnit = /\s/u.test(unit) ? " " : unit;
      normalized += normalizedUnit;
      for (let n = 0; n < normalizedUnit.length; n++) { starts.push(offset); ends.push(offset + char.length); }
    }
    offset += char.length;
  }
  const term = fold(query).replace(/\s/gu, " ").trim();
  if (!term) return [];
  const wordChar = /[\p{L}\p{N}\p{M}\u00ad\u200b]/u;
  const matches: TextMatch[] = [];
  for (let at = normalized.indexOf(term); at !== -1; at = normalized.indexOf(term, at + term.length)) {
    let start = starts[at], end = ends[at + term.length - 1];
    while (start > 0 && wordChar.test(text[start - 1])) start--;
    while (end < text.length && wordChar.test(text[end])) end++;
    const last = matches[matches.length - 1];
    if (last && start < last.end) last.end = Math.max(last.end, end);
    else matches.push({ start, end });
  }
  return matches;
}

export function highlightWords(divs: HTMLElement[], items: TextItem[], query: string): number {
  const indexed = indexText(items);
  const matches = findWords(indexed.text, query);
  for (const segment of indexed.segments) {
    const div = divs[segment.index];
    if (!div) continue;
    const original = indexed.text.slice(segment.start, segment.end);
    div.replaceChildren();
    let cursor = 0;
    for (const match of matches) {
      const from = Math.max(segment.start, match.start) - segment.start;
      const to = Math.min(segment.end, match.end) - segment.start;
      if (from >= to) continue;
      div.append(document.createTextNode(original.slice(cursor, from)));
      const mark = document.createElement("span");
      mark.className = "pdf-text-match";
      mark.textContent = original.slice(from, to);
      div.append(mark);
      cursor = to;
    }
    div.append(document.createTextNode(original.slice(cursor)));
  }
  return matches.length;
}
