export type PdfEdit =
  | { kind: 'insert'; position: 'start' | 'end'; name?: string }
  | { kind: 'delete'; page: number }
  | { kind: 'text'; page: number; name: string; rect: number[] };

/** Bounded snapshots, independent of the renderer and its page virtualization. */
export class EditHistory<T> {
  private past: T[] = [];
  private future: T[] = [];
  constructor(private limit = 50) {}
  get canUndo() { return this.past.length > 0; }
  get canRedo() { return this.future.length > 0; }
  record(state: T) {
    this.past.push(structuredClone(state));
    if (this.past.length > this.limit) this.past.shift();
    this.future = [];
  }
  undo(current: T): T | undefined {
    if (!this.canUndo) return;
    this.future.push(structuredClone(current));
    return this.past.pop();
  }
  redo(current: T): T | undefined {
    if (!this.canRedo) return;
    this.past.push(structuredClone(current));
    return this.future.pop();
  }
  clear() { this.past = []; this.future = []; }
}
