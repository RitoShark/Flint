export interface LspPosition { line: number; character: number }
export interface LspRange { start: LspPosition; end: LspPosition }
export interface LspEdit { range: LspRange; newText: string }
export interface LspDiagnostic { range: LspRange; message: string; rawMessage?: string; severity?: number; code?: string | number }

export function toMonacoRange(range: LspRange) {
    return {
        startLineNumber: range.start.line + 1, startColumn: range.start.character + 1,
        endLineNumber: range.end.line + 1, endColumn: range.end.character + 1,
    };
}

/** LSP/Monaco positions both count UTF-16 code units, not UTF-8 bytes. */
export function toLspPosition(position: { lineNumber: number; column: number }): LspPosition {
    return { line: position.lineNumber - 1, character: position.column - 1 };
}

/** LSP completion kinds are 1-based and differ from Monaco after Function. */
export const COMPLETION_KINDS = [18, 0, 1, 2, 3, 4, 5, 7, 8, 9, 12, 13, 15, 17, 28, 19, 20, 21, 23, 16, 14, 6, 10, 11, 24];

export function diagnosticsAreCurrent(receivedVersion: number | undefined, currentVersion: number, changed: boolean) {
    return !changed && receivedVersion === currentVersion;
}
