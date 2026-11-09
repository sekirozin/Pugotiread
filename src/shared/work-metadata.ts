/** Publication completion is independent of the user's reading progress. */
export function isPublicationCompleted(status: unknown): boolean {
  if (typeof status !== 'string') return false;
  const value = status.normalize('NFD').replace(/[\u0300-\u036f]/g, '').trim().toLowerCase();
  return /^(completed|complete|finished|concluido|concluida|completo|completa|finalizado|finalizada|encerrado|encerrada|terminado|terminada)$/.test(value);
}

export function validRating(raw: unknown): string | null {
  if (typeof raw !== 'number' && typeof raw !== 'string') return null;
  const value = String(raw).trim().replace(',', '.');
  const match = /^(\d+(?:\.\d+)?)(?:\s*\/\s*(5|10))?$/.exec(value);
  if (!match) return null;
  const number = Number(match[1]);
  return number <= Number(match[2] ?? 10) ? value : null;
}
