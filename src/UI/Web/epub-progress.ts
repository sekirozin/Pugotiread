export function clampEpubOffset(value: number): number {
  return Number.isFinite(value) ? Math.min(Math.max(value, 0), 1) : 0;
}

export function epubBookPercent(lengths: number[], spineIndex: number, offset: number): number {
  if (lengths.length === 0) return 0;
  const weights = lengths.map(value => Number.isFinite(value) && value > 0 ? value : 1);
  const index = Math.min(Math.max(Math.trunc(spineIndex), 0), weights.length - 1);
  const total = weights.reduce((sum, value) => sum + value, 0);
  const preceding = weights.slice(0, index).reduce((sum, value) => sum + value, 0);
  return Math.min(100, Math.max(0, Math.round(100 * (preceding + weights[index] * clampEpubOffset(offset)) / total)));
}

export function epubViewportOffset(scroll: number, extent: number, viewport: number): number {
  const distance = Math.max(0, extent - viewport);
  return distance <= 0 ? 0 : clampEpubOffset(scroll / distance);
}
