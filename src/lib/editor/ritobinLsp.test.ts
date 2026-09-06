import { beforeEach, describe, expect, it, vi } from 'vitest';

const mock = vi.hoisted(() => ({
    channel: null as any, completion: null as any, hover: null as any, formatting: null as any, codeAction: null as any,
    noHashes: 1, invoke: vi.fn(), markers: vi.fn(), disposeProvider: vi.fn(), items: null as any,
}));
vi.mock('@tauri-apps/api/core', () => ({
    Channel: class { constructor() { mock.channel = this; } }, invoke: mock.invoke,
}));
vi.mock('monaco-editor', () => ({
    Uri: { file: (path: string) => ({ toString: () => `file:///${path}` }) },
    Range: class { constructor(public startLineNumber: number, public startColumn: number, public endLineNumber: number, public endColumn: number) {} },
    MarkerSeverity: { Error: 8, Warning: 4, Info: 2, Hint: 1 },
    editor: { setModelMarkers: mock.markers, OverviewRulerLane: { Right: 4 }, MinimapPosition: { Inline: 1 } },
    languages: {
        CompletionItemKind: { Text: 18 }, CompletionItemInsertTextRule: { InsertAsSnippet: 4 },
        registerCompletionItemProvider: (_: string, p: any) => { mock.completion = p; return { dispose: mock.disposeProvider }; },
        registerHoverProvider: (_: string, p: any) => { mock.hover = p; return { dispose: mock.disposeProvider }; },
        registerDocumentFormattingEditProvider: (_: string, p: any) => { mock.formatting = p; return { dispose: mock.disposeProvider }; },
        registerCodeActionProvider: (_: string, p: any) => { mock.codeAction = p; return { dispose: mock.disposeProvider }; },
    },
}));
import { attachRitobinLsp } from './ritobinLsp';
import { useLspLogStore } from '../stores/lspLogStore';

function fixture() {
    let change = () => {};
    let version = 1;
    const model = {
        getValue: () => 'entries: map[hash,embed] = {}', isDisposed: () => false,
        getVersionId: () => version, getLanguageId: () => 'ritobin',
        uri: 'file:///skin.bin', getLineCount: () => 7,
        getLineContent: () => 'mPath: string = "assets/skin.tex"',
        getWordUntilPosition: () => ({ startColumn: 1, endColumn: 4 }),
        onDidChangeContent: (fn: () => void) => { change = fn; return { dispose: vi.fn() }; },
    };
    const decorations = { set: vi.fn(), clear: vi.fn() };
    return { model, decorations, editor: { getModel: () => model, createDecorationsCollection: () => decorations } as any, change: () => { version++; change(); } };
}
const token = { isCancellationRequested: false, onCancellationRequested: () => ({ dispose() {} }) };
const position = { lineNumber: 1, column: 4 };

beforeEach(() => {
    vi.clearAllMocks();
    mock.noHashes = 1; mock.completion = mock.hover = mock.formatting = mock.codeAction = null;
    mock.items = null;
    mock.invoke.mockImplementation(async (command: string, args: any) => {
        if (command === 'ritobin_lsp_lookup_names') return { 305419896: 'mSkinName' };
        if (command !== 'ritobin_lsp_send' || args.message.id === undefined || !args.message.method) return;
        const { id, method } = args.message;
        const result = method === 'initialize' ? { capabilities: {
            experimental: { flintNoHashes: mock.noHashes }, completionProvider: { resolveProvider: true }, hoverProvider: true, documentFormattingProvider: true,
        } } : method === 'textDocument/completion' ? mock.items ?? [{
            label: 'Example', kind: 15, insertText: 'Example { $0 }', insertTextFormat: 2,
            command: { command: 'ritobin-lsp/unhash', title: 'Unhash' },
        }] : method === 'textDocument/formatting' ? [{
            range: { start: { line: 0, character: 0 }, end: { line: 0, character: 3 } }, newText: 'formatted',
        }] : null;
        queueMicrotask(() => mock.channel.onmessage({ id, result }));
    });
});

describe('ritobin LSP lifecycle', () => {
    it('offers a versioned local bracket fix and rejects stale fixes after edits', async () => {
        const f = fixture();
        f.model.getValue = () => 'entries: map[hash,embed] = {\n    "a" = Example {\n        values: list[f32] = {\n            1\n        next: u32 = 1\n    }\n}';
        f.editor.pushUndoStop = vi.fn();
        f.editor.executeEdits = vi.fn(() => { f.change(); return true; });
        f.editor.revealLineInCenter = vi.fn();
        f.editor.focus = vi.fn();
        const connection = attachRitobinLsp(f.editor, 'skin.bin', null, vi.fn());
        await vi.waitFor(() => expect(mock.completion).not.toBeNull());
        mock.channel.onmessage({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///skin.bin', version: 1,
            diagnostics: [{ message: "Missing '}' for block - got end of file", range: { start: { line: 6, character: 1 }, end: { line: 6, character: 1 } } }],
        } });
        const fix = useLspLogStore.getState().live?.bracketFix;
        expect(fix?.title).toBe("Insert '}' after line 4");
        expect(f.decorations.set).toHaveBeenLastCalledWith([
            expect.objectContaining({ range: expect.objectContaining({ startLineNumber: 4, startColumn: 14 }), options: expect.objectContaining({
                after: expect.objectContaining({ content: expect.stringContaining("insert '}' after this line") }),
            }) }),
        ]);
        expect(mock.codeAction.provideCodeActions(f.model, { startLineNumber: 3, endLineNumber: 3 }).actions).toEqual([]);
        const actions = mock.codeAction.provideCodeActions(f.model, { startLineNumber: 4, endLineNumber: 4 }).actions;
        expect(actions[0].edit.edits[0]).toMatchObject({ resource: 'file:///skin.bin', versionId: 1, textEdit: { text: '\n        }' } });
        expect(fix?.apply()).toBe(true);
        expect(f.editor.executeEdits).toHaveBeenCalledTimes(1);
        expect(f.editor.pushUndoStop).toHaveBeenCalledTimes(2);
        expect(useLspLogStore.getState().live?.bracketFix).toBeNull();
        expect(f.decorations.clear).toHaveBeenCalled();
        expect(fix?.apply()).toBe(false);
        expect(mock.codeAction.provideCodeActions(f.model, { startLineNumber: 3, endLineNumber: 3 }).actions).toEqual([]);
        connection.dispose();
    });

    it('shows only current diagnostics, clears on edits and removes the snapshot on close', async () => {
        const f = fixture(), status = vi.fn();
        const connection = attachRitobinLsp(f.editor, 'skin.bin', null, status);
        await vi.waitFor(() => expect(mock.completion).not.toBeNull());
        const live = () => useLspLogStore.getState().live;
        const diagnostic = { range: { start: { line: 0, character: 1 }, end: { line: 0, character: 2 } }, message: 'Missing brace', severity: 1 };
        const publish = (version: number, diagnostics: any[]) => mock.channel.onmessage({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///skin.bin', version, diagnostics } });
        expect(live()?.diagnostics).toBeNull();
        publish(1, [diagnostic]);
        expect(live()?.diagnostics).toEqual([diagnostic]);
        f.change();
        expect(live()?.diagnostics).toBeNull();
        expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ checking: true, diagnostics: 0 }));
        publish(1, [diagnostic]);
        expect(live()?.diagnostics).toBeNull();
        await mock.completion.provideCompletionItems(f.model, position, {}, token);
        publish(2, []);
        expect(live()?.diagnostics).toEqual([]);
        expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ checking: false, diagnostics: 0 }));
        connection.dispose();
        expect(live()).toBeNull();
    });

    it('replaces server output and expires it without retaining history', async () => {
        const f = fixture();
        const connection = attachRitobinLsp(f.editor, 'skin.bin', null, vi.fn());
        await vi.waitFor(() => expect(mock.completion).not.toBeNull());
        vi.useFakeTimers();
        try {
            mock.channel.onmessage({ method: 'window/logMessage', params: { type: 1, message: 'First error' } });
            expect(useLspLogStore.getState().live?.output).toEqual({ level: 'error', message: 'First error' });
            mock.channel.onmessage({ method: 'flint/stderr', params: { message: 'Next output' } });
            expect(useLspLogStore.getState().live?.output?.message).toBe('Next output');
            await vi.advanceTimersByTimeAsync(8000);
            expect(useLspLogStore.getState().live?.output).toBeNull();
        } finally { connection.dispose(); vi.useRealTimers(); }
    });

    it('shows pending requests and errors, clearing a request error when retried successfully', async () => {
        const f = fixture();
        const connection = attachRitobinLsp(f.editor, 'skin.bin', null, vi.fn());
        await vi.waitFor(() => expect(mock.completion).not.toBeNull());
        const normalInvoke = mock.invoke.getMockImplementation()!;
        let failNext = true;
        mock.invoke.mockImplementation(async (command, args) => {
            if (args.message?.method === 'textDocument/completion' && failNext) {
                expect(useLspLogStore.getState().live?.requests).toContain('textDocument/completion');
                failNext = false;
                queueMicrotask(() => mock.channel.onmessage({ id: args.message.id, error: { message: 'Metadata unavailable' } }));
            } else return normalInvoke(command, args);
        });
        await mock.completion.provideCompletionItems(f.model, position, {}, token);
        expect(useLspLogStore.getState().live?.requestErrors).toEqual({ 'textDocument/completion': 'Metadata unavailable' });
        expect(useLspLogStore.getState().live?.requests).toEqual([]);
        await mock.completion.provideCompletionItems(f.model, position, {}, token);
        expect(useLspLogStore.getState().live?.requestErrors).toEqual({});
        connection.dispose();
    });

    it('uses Flint names for visible suggestions, insertion and property documentation resolution', async () => {
        mock.items = [{ label: '0x12345678', kind: 10, data: '0x87654321', insertText: '0x12345678: string = ' }];
        const f = fixture();
        const connection = attachRitobinLsp(f.editor, 'skin.bin', null, vi.fn());
        await vi.waitFor(() => expect(mock.completion).not.toBeNull());
        const { suggestions } = await mock.completion.provideCompletionItems(f.model, position, {}, token);
        expect(suggestions[0]).toMatchObject({ label: 'mSkinName', insertText: 'mSkinName: string = ' });
        await mock.completion.resolveCompletionItem(suggestions[0], token);
        expect(mock.invoke).toHaveBeenCalledWith('ritobin_lsp_send', expect.objectContaining({ message: expect.objectContaining({
            method: 'completionItem/resolve', params: expect.objectContaining({ label: 'mSkinName', data: '0x87654321' }),
        }) }));
        connection.dispose();
    });

    it('suppresses disabled hovers and quoted asset hovers, and applies preferences without restarting', async () => {
        const f = fixture();
        let enabled = false;
        const connection = attachRitobinLsp(f.editor, 'skin.bin', null, vi.fn(), () => enabled);
        await vi.waitFor(() => expect(mock.hover).not.toBeNull());
        await mock.hover.provideHover(f.model, position, token);
        enabled = true;
        await mock.hover.provideHover(f.model, { lineNumber: 1, column: 22 }, token);
        expect(mock.invoke.mock.calls.some(([, a]) => a.message?.method === 'textDocument/hover')).toBe(false);
        await mock.hover.provideHover(f.model, position, token);
        expect(mock.invoke.mock.calls.filter(([, a]) => a.message?.method === 'textDocument/hover')).toHaveLength(1);
        connection.dispose();
    });

    it('refuses a server without the no-hashes handshake before opening any document', async () => {
        mock.noHashes = 0;
        const f = fixture(), status = vi.fn();
        const connection = attachRitobinLsp(f.editor, 'skin.bin', null, status);
        await vi.waitFor(() => expect(status).toHaveBeenLastCalledWith(expect.objectContaining({ state: 'error' })));
        expect(mock.invoke.mock.calls.some(([, a]) => a.message?.method === 'textDocument/didOpen')).toBe(false);
        expect(mock.invoke).toHaveBeenCalledWith('ritobin_lsp_stop', expect.anything());
        connection.dispose();
    });

    it('scopes completion, strips server commands, flushes edits first and disposes all providers', async () => {
        const f = fixture();
        const connection = attachRitobinLsp(f.editor, 'skin.bin', null, vi.fn());
        await vi.waitFor(() => expect(mock.completion).not.toBeNull());
        expect(await mock.completion.provideCompletionItems({}, position, {}, token)).toEqual({ suggestions: [] });
        f.change();
        const result = await mock.completion.provideCompletionItems(f.model, position, {}, token);
        expect(result.suggestions[0]).toMatchObject({ kind: 28, insertTextRules: 4 });
        expect(result.suggestions[0].command).toBeUndefined();
        const methods = mock.invoke.mock.calls.map(([, a]) => a.message?.method).filter(Boolean);
        expect(methods.indexOf('textDocument/didChange')).toBeLessThan(methods.indexOf('textDocument/completion'));
        expect(methods).not.toContain('ritobin-lsp/unhash');
        connection.dispose();
        expect(mock.disposeProvider).toHaveBeenCalledTimes(4);
        expect(mock.invoke).toHaveBeenCalledWith('ritobin_lsp_stop', expect.anything());
        expect(mock.markers).toHaveBeenLastCalledWith(f.model, 'flint-ritobin-lsp', []);
    });

    it('does not apply formatting returned after another edit', async () => {
        const f = fixture();
        const connection = attachRitobinLsp(f.editor, 'skin.bin', null, vi.fn());
        await vi.waitFor(() => expect(mock.formatting).not.toBeNull());
        const result = mock.formatting.provideDocumentFormattingEdits(f.model, { tabSize: 4, insertSpaces: true }, token);
        f.change();
        expect(await result).toEqual([]);
        connection.dispose();
    });

    it('ignores stale diagnostics and refuses server-initiated file edits', async () => {
        const f = fixture();
        const connection = attachRitobinLsp(f.editor, 'skin.bin', null, vi.fn());
        await vi.waitFor(() => expect(mock.completion).not.toBeNull());
        f.change();
        mock.markers.mockClear();
        mock.channel.onmessage({ method: 'textDocument/publishDiagnostics', params: { uri: 'file:///skin.bin', version: 1, diagnostics: [] } });
        expect(mock.markers).not.toHaveBeenCalled();
        mock.channel.onmessage({ id: 99, method: 'workspace/applyEdit', params: {} });
        await vi.waitFor(() => expect(mock.invoke).toHaveBeenCalledWith('ritobin_lsp_send', expect.objectContaining({
            message: expect.objectContaining({ id: 99, error: expect.objectContaining({ code: -32601 }) }),
        })));
        connection.dispose();
    });
});
