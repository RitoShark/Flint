import { Channel, invoke } from '@tauri-apps/api/core';
import * as monaco from 'monaco-editor';
import { COMPLETION_KINDS, diagnosticsAreCurrent, toLspPosition, toMonacoRange, type LspDiagnostic, type LspEdit } from './ritobinLspProtocol';
import { isQuotedPosition, resolveCompletionNames, type Completion } from './ritobinLspNames';
import { useLspLogStore } from '../stores/lspLogStore';
import { readableDiagnostic, suggestLspBracket, type BracketFix } from './ritobinLspDiagnostics';

const OWNER = 'flint-ritobin-lsp';
type Rpc = { id?: number | string; method?: string; params?: any; result?: any; error?: { message: string } };

export interface LspStatus { state: 'starting' | 'ready' | 'error'; message: string; diagnostics: number; checking?: boolean }

/** One session per editor: scoped providers cannot leak suggestions into another BIN. */
export function attachRitobinLsp(ed: monaco.editor.IStandaloneCodeEditor, filePath: string, rootPath: string | null, onStatus: (status: LspStatus) => void, hoverEnabled: () => boolean = () => false): monaco.IDisposable {
    const model = ed.getModel()!;
    const session = crypto.randomUUID();
    const uri = monaco.Uri.file(filePath).toString();
    const rootUri = rootPath ? monaco.Uri.file(rootPath).toString() : null;
    const pending = new Map<number, { method: string; resolve: (v: any) => void; reject: (e: Error) => void }>();
    const disposables: monaco.IDisposable[] = [];
    const bracketDecorations = ed.createDecorationsCollection();
    let disposed = false;
    let failed = false;
    let ready = false;
    let sequence = 0;
    let version = 1;
    let dirty = false;
    let serverMessage = 'LSP connected';
    let diagnosticCount = 0;
    let checking = true;
    let bracketFix: { fix: BracketFix; version: number } | null = null;
    let timer: ReturnType<typeof setTimeout> | undefined;
    let outputTimer: ReturnType<typeof setTimeout> | undefined;
    let writes = Promise.resolve();
    const live = useLspLogStore.getState();
    live.begin(session, filePath, (lineNumber, column) => {
        if (disposed || model.isDisposed()) return;
        ed.revealLineInCenter(lineNumber);
        ed.setPosition({ lineNumber, column });
        ed.focus();
    });
    const requestErrors: Record<string, string> = {};
    const showRequests = () => {
        if (!disposed) live.update(session, { requests: [...pending.values()].map(p => p.method), requestErrors: { ...requestErrors } });
    };
    const showOutput = (message: string, level: 'info' | 'warning' | 'error') => {
        clearTimeout(outputTimer);
        live.update(session, { output: { message: message.slice(-16384), level } });
        outputTimer = setTimeout(() => live.update(session, { output: null }), 8000);
    };

    const status = (state: LspStatus['state'], message: string, diagnostics = 0) => {
        if (!disposed) {
            onStatus({ state, message, diagnostics, checking });
            live.update(session, { state, message });
        }
    };
    const clearMarkers = () => {
        bracketDecorations.clear();
        if (!model.isDisposed()) monaco.editor.setModelMarkers(model, OWNER, []);
    };
    const fail = (error: unknown) => {
        if (disposed || failed) return;
        failed = true;
        ready = false;
        clearMarkers();
        bracketFix = null;
        live.update(session, { diagnostics: null, bracketFix: null });
        for (const request of pending.values()) request.reject(new Error(String(error)));
        pending.clear();
        status('error', String(error));
        void invoke('ritobin_lsp_stop', { session }).catch(() => {});
    };
    const send = (message: Rpc) => {
        if (disposed || failed) return Promise.reject(new Error('LSP session closed'));
        writes = writes.then(() => invoke<void>('ritobin_lsp_send', { session, message: { jsonrpc: '2.0', ...message } }));
        void writes.catch(fail);
        return writes;
    };
    const request = (method: string, params: unknown, token?: monaco.CancellationToken): Promise<any> => {
        if (disposed || failed || token?.isCancellationRequested) return Promise.resolve(null);
        const id = ++sequence;
        const atVersion = model.getVersionId();
        return new Promise((resolve, reject) => {
            let cancellation: monaco.IDisposable | undefined;
            const timeout = setTimeout(() => finish(new Error(`LSP request timed out: ${method}`)), 20000);
            const finish = (error?: Error, value?: unknown) => {
                if (!pending.has(id)) return;
                clearTimeout(timeout); cancellation?.dispose(); pending.delete(id);
                if (error && model.getVersionId() === atVersion) requestErrors[method] = error.message;
                showRequests();
                if (error) reject(error); else resolve(value);
            };
            pending.set(id, { method, resolve: v => finish(undefined, v), reject: e => finish(e) });
            delete requestErrors[method];
            showRequests();
            cancellation = token?.onCancellationRequested(() => {
                void send({ method: '$/cancelRequest', params: { id } }).catch(() => {});
                finish(undefined, null);
            });
            void send({ id, method, params }).catch(e => finish(e));
        });
    };
    const notify = (method: string, params: unknown) => { void send({ method, params }).catch(() => {}); };
    const flush = () => {
        clearTimeout(timer);
        if (!ready || !dirty || model.isDisposed()) return;
        dirty = false;
        version++;
        notify('textDocument/didChange', { textDocument: { uri, version }, contentChanges: [{ text: model.getValue() }] });
    };
    const owns = (m: monaco.editor.ITextModel) => ready && !disposed && m === model;
    const doc = { uri };
    const markdown = (value: string | { value: string } | undefined) => value ? { value: typeof value === 'string' ? value : value.value, isTrusted: false } : undefined;
    const textEdit = (edit: LspEdit) => ({ range: toMonacoRange(edit.range), text: edit.newText });
    const completion = (item: Completion, position: monaco.Position): monaco.languages.CompletionItem => {
        const word = model.getWordUntilPosition(position);
        const edit = item.textEdit;
        return {
            label: item.label, kind: COMPLETION_KINDS[(item.kind ?? 1) - 1] ?? monaco.languages.CompletionItemKind.Text,
            detail: item.detail ?? item.labelDetails?.detail, documentation: markdown(item.documentation),
            insertText: edit?.newText ?? item.insertText ?? item.label,
            insertTextRules: item.insertTextFormat === 2 ? monaco.languages.CompletionItemInsertTextRule.InsertAsSnippet : undefined,
            range: edit ? ('range' in edit ? toMonacoRange(edit.range) : { insert: toMonacoRange(edit.insert), replace: toMonacoRange(edit.replace) })
                : new monaco.Range(position.lineNumber, word.startColumn, position.lineNumber, word.endColumn),
            additionalTextEdits: item.additionalTextEdits?.map(textEdit),
            sortText: item.sortText, filterText: item.filterText, preselect: item.preselect,
            // Deliberately never expose LSP commands, including unhash actions.
        };
    };
    const channel = new Channel<Rpc>();
    channel.onmessage = message => {
        if (disposed || failed) return;
        if (message.method === 'flint/exited') { fail(message.params?.message ?? 'Language server exited'); return; }
        if (message.method && message.id !== undefined) {
            // Server edits/commands are never applied. Only harmless protocol bookkeeping.
            if (message.method === 'workspace/configuration') {
                void send({ id: message.id, result: (message.params?.items ?? []).map(() => null) }).catch(() => {});
            } else {
                void send({ id: message.id, error: { code: -32601, message: 'Unsupported server request' } } as Rpc).catch(() => {});
            }
            return;
        }
        if (message.id !== undefined) {
            const p = pending.get(Number(message.id));
            if (message.error) p?.reject(new Error(message.error.message)); else p?.resolve(message.result);
        } else if (message.method === 'experimental/serverStatus') {
            serverMessage = message.params?.message || 'LSP connected';
            status('ready', serverMessage, diagnosticCount);
        } else if (message.method === 'window/logMessage' || message.method === 'window/showMessage' || message.method === 'flint/stderr') {
            const level = message.params?.type === 1 ? 'error' : message.params?.type === 2 ? 'warning' : 'info';
            if (typeof message.params?.message === 'string') showOutput(message.params.message, level);
        } else if (message.method === 'textDocument/publishDiagnostics') {
            const p = message.params as { uri: string; version?: number; diagnostics: LspDiagnostic[] };
            if (p.uri !== uri || !diagnosticsAreCurrent(p.version, version, dirty) || model.isDisposed()) return;
            p.diagnostics = p.diagnostics.map(readableDiagnostic);
            monaco.editor.setModelMarkers(model, OWNER, p.diagnostics.map(d => ({
                ...toMonacoRange(d.range), message: d.message, source: 'ritobin-lsp',
                code: d.code === undefined ? undefined : String(d.code),
                severity: [monaco.MarkerSeverity.Error, monaco.MarkerSeverity.Warning, monaco.MarkerSeverity.Info, monaco.MarkerSeverity.Hint][(d.severity ?? 1) - 1] ?? monaco.MarkerSeverity.Error,
            })));
            diagnosticCount = p.diagnostics.length;
            checking = false;
            const fix = suggestLspBracket(model.getValue(), p.diagnostics);
            const candidate = fix ? { fix, version: model.getVersionId() } : null;
            bracketFix = candidate;
            if (fix) {
                const insertionLine = fix.edit.range.start.line + 1;
                const insertionColumn = fix.edit.range.start.character + 1;
                const closer = fix.edit.newText.trim();
                bracketDecorations.set([
                    {
                        range: new monaco.Range(insertionLine, insertionColumn, insertionLine, insertionColumn),
                        options: {
                            isWholeLine: true, className: 'bracket-suggest-line',
                            after: { content: `  ← Suggested: insert '${closer}' after this line · Quick Fix (Ctrl+.)`, inlineClassName: 'lsp-bracket-suggestion' },
                            overviewRuler: { color: '#f0a020', position: monaco.editor.OverviewRulerLane.Right },
                            minimap: { color: '#f0a020', position: monaco.editor.MinimapPosition.Inline },
                        },
                    },
                ]);
            } else bracketDecorations.clear();
            live.update(session, { diagnostics: p.diagnostics, bracketFix: candidate ? {
                ...candidate.fix,
                apply: () => {
                    if (!ready || disposed || dirty || model.isDisposed() || bracketFix !== candidate || model.getVersionId() !== candidate.version) return false;
                    ed.pushUndoStop();
                    const applied = ed.executeEdits('flint-lsp-bracket-fix', [textEdit(candidate.fix.edit)]);
                    ed.pushUndoStop();
                    if (applied) {
                        ed.revealLineInCenter(candidate.fix.edit.range.start.line + 2);
                        ed.focus();
                    }
                    return applied;
                },
            } : null });
            status('ready', serverMessage, diagnosticCount);
        }
    };
    status('starting', 'Installing or starting LSP…');
    disposables.push(model.onDidChangeContent(() => {
        dirty = true; clearMarkers(); clearTimeout(timer);
        checking = true;
        diagnosticCount = 0;
        for (const method of Object.keys(requestErrors)) delete requestErrors[method];
        bracketFix = null;
        live.update(session, { diagnostics: null, bracketFix: null, requestErrors: {} });
        if (ready) status('ready', serverMessage);
        timer = setTimeout(flush, 200);
    }));

    void (async () => {
        await invoke('ritobin_lsp_start', { session, messages: channel });
        if (disposed) { await invoke('ritobin_lsp_stop', { session }); return; }
        const initialized = await request('initialize', {
            processId: null, rootUri, workspaceFolders: rootUri ? [{ uri: rootUri, name: 'Flint project' }] : null,
            clientInfo: { name: 'Flint' },
            initializationOptions: { hashPath: '', metaDumpPath: '', diagnosticLimit: 500 },
            capabilities: { general: { positionEncodings: ['utf-16'] }, textDocument: {
                completion: { completionItem: { snippetSupport: true, documentationFormat: ['markdown', 'plaintext'] } },
                hover: { contentFormat: ['markdown', 'plaintext'] }, publishDiagnostics: { versionSupport: true },
            } },
        });
        if (disposed) return;
        const caps = initialized?.capabilities;
        if (caps?.experimental?.flintNoHashes !== 1) throw new Error('Server does not confirm Flint hash isolation');
        if (caps.positionEncoding && caps.positionEncoding !== 'utf-16') throw new Error('Unsupported LSP position encoding');
        notify('initialized', {});
        notify('textDocument/didOpen', { textDocument: { uri, languageId: 'ritobin', version, text: model.getValue() } });
        dirty = false;
        ready = true;
        status('ready', 'LSP connected');
        const selector = model.getLanguageId();
        disposables.push(monaco.languages.registerCodeActionProvider(selector, {
            provideCodeActions(m, range) {
                const candidate = bracketFix;
                if (!owns(m) || dirty || !candidate || model.getVersionId() !== candidate.version) return { actions: [], dispose() {} };
                const { fix } = candidate;
                const nearFix = [fix.edit.range.start.line + 1, fix.edit.range.start.line + 2, model.getLineCount()]
                    .some(line => line >= range.startLineNumber && line <= range.endLineNumber);
                return { actions: nearFix ? [{
                    title: `${fix.title} (suggested)`, kind: 'quickfix',
                    edit: { edits: [{ resource: model.uri, versionId: candidate.version, textEdit: textEdit(fix.edit) }] },
                }] : [], dispose() {} };
            },
        }, { providedCodeActionKinds: ['quickfix'] }));
        if (caps.completionProvider) {
            const originals = new WeakMap<monaco.languages.CompletionItem, { item: Completion; position: monaco.Position; version: number }>();
            disposables.push(monaco.languages.registerCompletionItemProvider(selector, {
                triggerCharacters: caps.completionProvider.triggerCharacters,
                async provideCompletionItems(m, position, context, token) {
                    if (!owns(m)) return { suggestions: [] };
                    flush(); const atVersion = model.getVersionId();
                    const result = await request('textDocument/completion', { textDocument: doc, position: toLspPosition(position), context }, token).catch(() => null);
                    if (!owns(m) || token.isCancellationRequested || model.getVersionId() !== atVersion) return { suggestions: [] };
                    const items: Completion[] = Array.isArray(result) ? result : result?.items ?? [];
                    delete requestErrors['Local hash lookup'];
                    showRequests();
                    const named = await resolveCompletionNames(items, hashes => invoke<Record<string, string>>('ritobin_lsp_lookup_names', { hashes })).catch(error => {
                        if (!disposed && model.getVersionId() === atVersion) {
                            requestErrors['Local hash lookup'] = String(error);
                            showRequests();
                        }
                        console.warn('[ritobin-lsp] Local hash lookup failed:', error);
                        return items;
                    });
                    if (!owns(m) || token.isCancellationRequested || model.getVersionId() !== atVersion) return { suggestions: [] };
                    return { incomplete: result?.isIncomplete, suggestions: named.map((item: Completion) => {
                        const converted = completion(item, position); originals.set(converted, { item, position, version: atVersion }); return converted;
                    }) };
                },
                async resolveCompletionItem(item, token) {
                    const original = originals.get(item);
                    if (!original || !ready || !caps.completionProvider.resolveProvider || model.getVersionId() !== original.version) return item;
                    // Upstream resolves property docs only; other kinds never receive a response.
                    if (original.item.kind !== 10) return item;
                    const resolved = await request('completionItem/resolve', original.item, token).catch(() => null);
                    return resolved && !disposed && !model.isDisposed() && model.getVersionId() === original.version ? completion({ ...original.item, ...resolved }, original.position) : item;
                },
            }));
        }
        if (caps.hoverProvider) disposables.push(monaco.languages.registerHoverProvider(selector, {
            async provideHover(m, position, token) {
                if (!owns(m) || !hoverEnabled() || isQuotedPosition(m.getLineContent(position.lineNumber), position.column)) return null;
                flush(); const atVersion = model.getVersionId();
                const result = await request('textDocument/hover', { textDocument: doc, position: toLspPosition(position) }, token).catch(() => null);
                if (!result || !owns(m) || !hoverEnabled() || m.getVersionId() !== atVersion) return null;
                const contents = Array.isArray(result.contents) ? result.contents : [result.contents];
                return { range: result.range ? toMonacoRange(result.range) : undefined, contents: contents.map(markdown).filter(Boolean) };
            },
        }));
        if (caps.documentFormattingProvider) disposables.push(monaco.languages.registerDocumentFormattingEditProvider(selector, {
            async provideDocumentFormattingEdits(m, options, token) {
                if (!owns(m)) return [];
                flush(); const atVersion = m.getVersionId();
                const result: LspEdit[] | null = await request('textDocument/formatting', { textDocument: doc, options }, token).catch(() => null);
                return owns(m) && m.getVersionId() === atVersion ? (result ?? []).map(textEdit) : [];
            },
        }));
    })().catch(fail);

    return { dispose() {
        disposed = true; ready = false; clearTimeout(timer); clearTimeout(outputTimer);
        live.end(session);
        disposables.forEach(d => d.dispose()); clearMarkers();
        for (const p of pending.values()) p.resolve(null);
        pending.clear();
        void invoke('ritobin_lsp_stop', { session }).catch(() => {});
    } };
}
