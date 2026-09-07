import { extract, patch, type Mask, type Rect } from './ops';

interface Entry {
  rect: Rect;
  before: Uint8ClampedArray;
  after: Uint8ClampedArray;
  label: string;
}

/**
 * Undo/redo stack storing only the changed rectangle of each edit.
 * Total memory is bounded by `budgetBytes`; the oldest entries are dropped.
 */
export class MaskHistory {
  private undoStack: Entry[] = [];
  private redoStack: Entry[] = [];
  private bytes = 0;
  private open: { rect: Rect; before: Uint8ClampedArray; label: string } | null = null;

  constructor(private budgetBytes = 160 * 1024 * 1024) {}

  get canUndo() {
    return this.undoStack.length > 0;
  }
  get canRedo() {
    return this.redoStack.length > 0;
  }

  /** Snapshot `rect` before an edit. Call `commit` after the edit. */
  begin(mask: Mask, rect: Rect, label: string) {
    if (rect.w === 0 || rect.h === 0) return;
    this.open = { rect, before: extract(mask, rect), label };
  }

  commit(mask: Mask) {
    if (!this.open) return;
    const { rect, before, label } = this.open;
    this.open = null;
    const after = extract(mask, rect);
    // Skip no-op edits.
    let changed = false;
    for (let i = 0; i < before.length; i++) {
      if (before[i] !== after[i]) {
        changed = true;
        break;
      }
    }
    if (!changed) return;
    this.push({ rect, before, after, label });
  }

  /** Records an edit whose before-state is already known. */
  push(entry: Entry) {
    this.undoStack.push(entry);
    this.bytes += entry.before.byteLength + entry.after.byteLength;
    for (const e of this.redoStack) this.bytes -= e.before.byteLength + e.after.byteLength;
    this.redoStack = [];
    while (this.bytes > this.budgetBytes && this.undoStack.length > 1) {
      const e = this.undoStack.shift()!;
      this.bytes -= e.before.byteLength + e.after.byteLength;
    }
  }

  undo(mask: Mask): Rect | null {
    const e = this.undoStack.pop();
    if (!e) return null;
    patch(mask, e.rect, e.before);
    this.redoStack.push(e);
    return e.rect;
  }

  redo(mask: Mask): Rect | null {
    const e = this.redoStack.pop();
    if (!e) return null;
    patch(mask, e.rect, e.after);
    this.undoStack.push(e);
    return e.rect;
  }

  clear() {
    this.undoStack = [];
    this.redoStack = [];
    this.bytes = 0;
    this.open = null;
  }
}
