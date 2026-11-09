/** Bounded snapshots, independent of the renderer and its page virtualization. */
export class EditHistory {
    limit;
    past = [];
    future = [];
    constructor(limit = 50) {
        this.limit = limit;
    }
    get canUndo() { return this.past.length > 0; }
    get canRedo() { return this.future.length > 0; }
    record(state) {
        this.past.push(structuredClone(state));
        if (this.past.length > this.limit)
            this.past.shift();
        this.future = [];
    }
    undo(current) {
        if (!this.canUndo)
            return;
        this.future.push(structuredClone(current));
        return this.past.pop();
    }
    redo(current) {
        if (!this.canRedo)
            return;
        this.past.push(structuredClone(current));
        return this.future.pop();
    }
    clear() { this.past = []; this.future = []; }
}
