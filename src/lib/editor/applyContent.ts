import type * as monacoNs from 'monaco-editor';

/** Apply new content in a single undoable edit (preserves cursor). */
export function applyContentToEditor(
    ed: monacoNs.editor.IStandaloneCodeEditor,
    newContent: string,
) {
    const model = ed.getModel();
    if (!model) return;
    const full = model.getFullModelRange();
    model.pushEditOperations([], [{ range: full, text: newContent }], () => null);
}
