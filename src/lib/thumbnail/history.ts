import { Layer } from './layers';
export function createHistory(initial: Layer[]) {
  let current = JSON.stringify(initial);
  let pendingBaseline: string | null = null;
  const undo: string[] = [], redo: string[] = [];
  return {
    get: (): Layer[] => JSON.parse(current),
    set(next: Layer[], record = false) {
      const s = JSON.stringify(next);
      if (record && s !== current) { undo.push(current); if (undo.length > 100) undo.shift(); redo.length = 0; }
      current = s;
    },
    // Snapshot the state as the pending gesture baseline (call at drag/slider gesture start).
    begin() {
      pendingBaseline = current;
    },
    // Record the pre-gesture baseline against the now-current state (call on gesture release).
    commitGesture() {
      if (pendingBaseline !== null && pendingBaseline !== current) {
        undo.push(pendingBaseline);
        if (undo.length > 100) undo.shift();
        redo.length = 0;
      }
      pendingBaseline = null;
    },
    undo() { if (undo.length) { redo.push(current); current = undo.pop()!; } },
    redo() { if (redo.length) { undo.push(current); current = redo.pop()!; } },
    canUndo: () => undo.length > 0,
    canRedo: () => redo.length > 0,
  };
}
