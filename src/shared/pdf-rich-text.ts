export type RunStyle = { font: 'helvetica' | 'times' | 'courier'; fontSize: number; color: string; bold?: boolean; italic?: boolean; underline?: boolean };
export type TextRun = RunStyle & { text: string };
export const bodyStyle: RunStyle = { font: 'helvetica', fontSize: 12, color: '#000000' };
export function mergeRuns(runs: TextRun[]): TextRun[] {
  const result: TextRun[] = [];
  for (const run of runs) {
    if (!run.text) continue;
    const last = result.at(-1);
    if (last && last.font === run.font && last.fontSize === run.fontSize && last.color === run.color && !!last.bold === !!run.bold && !!last.italic === !!run.italic && !!last.underline === !!run.underline) last.text += run.text;
    else result.push({ ...run });
  }
  return result;
}
export function formatRuns(runs: TextRun[], start: number, end: number, patch: Partial<RunStyle>): TextRun[] {
  let offset = 0;
  return mergeRuns(runs.flatMap(run => {
    const a = Math.max(0, start - offset), b = Math.min(run.text.length, end - offset); offset += run.text.length;
    if (a >= b) return [run];
    return [{ ...run, text: run.text.slice(0, a) }, { ...run, ...patch, text: run.text.slice(a, b) }, { ...run, text: run.text.slice(b) }];
  }));
}
