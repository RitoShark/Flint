import React from 'react';
import { useLspLogStore } from '../../lib/stores/lspLogStore';
import { useAppMetadataStore, useNotificationStore } from '../../lib/stores';
import { Button } from '../ui';

const requestName = (method: string) => ({
    initialize: 'Connecting', 'textDocument/completion': 'Autocomplete',
    'completionItem/resolve': 'Completion documentation', 'textDocument/hover': 'Hover help',
    'textDocument/formatting': 'Formatting',
}[method] ?? method);
const severity = (value = 1) => ['Error', 'Warning', 'Info', 'Hint'][value - 1] ?? 'Error';

export const LspLogView: React.FC = () => {
    const live = useLspLogStore(s => s.live);
    const showToast = useNotificationStore(s => s.showToast);
    if (!live) return null;
    const diagnosticStatus = live.state === 'error' ? 'Diagnostics unavailable'
        : live.diagnostics === null ? 'Waiting for diagnostics for the current text…'
        : live.diagnostics.length ? `${live.diagnostics.length} current diagnostics` : 'No current diagnostics';
    const errors = Object.entries(live.requestErrors);
    const copy = () => {
        const text = [live.filePath, `${live.state}: ${live.message}`, diagnosticStatus,
            ...live.requests.map(requestName), ...errors.map(([method, error]) => `${requestName(method)}: ${error}`),
            ...(live.output ? [live.output.message] : []),
            ...(live.bracketFix ? [live.bracketFix.title, live.bracketFix.explanation] : []),
            ...(live.diagnostics ?? []).map(d => `${severity(d.severity)} ${d.range.start.line + 1}:${d.range.start.character + 1} ${d.message}`),
        ].join('\n');
        void navigator.clipboard.writeText(text).then(() => showToast('info', 'LSP snapshot copied'))
            .catch(() => showToast('error', 'Failed to copy LSP snapshot'));
    };
    return <div className="log-panel__content lsp-log">
        <div className="lsp-log__heading">
            <div><strong>LSP · Current BIN</strong><div className="lsp-log__path">{live.filePath}</div></div>
            <Button size="sm" icon="copy" onClick={copy}>Copy current</Button>
        </div>
        <p className={`lsp-log__state${live.state === 'error' ? ' lsp-log__state--error' : ''}`} role="status">
            {live.state === 'starting' ? 'Starting' : live.state === 'error' ? 'Unavailable' : 'Connected'} · {live.message}
        </p>
        <p>{diagnosticStatus}</p>
        <p className="lsp-log__muted">Current state only. Diagnostics update after edits; server output expires after 8 seconds.</p>
        {live.requests.length > 0 && <div className="lsp-log__item">In progress: {[...new Set(live.requests)].map(requestName).join(', ')}</div>}
        {errors.map(([method, error]) => <div key={method} className="lsp-log__item lsp-log__state--error">
            <strong>{requestName(method)}</strong><div>{error}</div>
        </div>)}
        {live.output && <div className={`lsp-log__item lsp-log__output--${live.output.level}`}>
            <strong>Server output</strong><pre>{live.output.message}</pre>
        </div>}
        {live.bracketFix && <div className="lsp-log__item">
            <strong>Suggested closing bracket</strong>
            <p>{live.bracketFix.explanation}</p>
            <Button size="sm" onClick={() => {
                useAppMetadataStore.getState().toggleLogPanel();
                live.reveal(live.bracketFix!.edit.range.start.line + 1, 1);
            }}>Go to suggested location</Button>
            <Button size="sm" variant="primary" onClick={() => {
                if (live.bracketFix?.apply()) useAppMetadataStore.getState().toggleLogPanel();
                else showToast('info', 'The document changed. Wait for fresh LSP diagnostics.');
            }}>{live.bracketFix.title}</Button>
        </div>}
        <div aria-label="Current LSP diagnostics">
            {(live.diagnostics ?? []).map((d, i) => <div key={i} className={`lsp-log__item lsp-log__diagnostic--${d.severity ?? 1}`}>
                <Button size="sm" variant="ghost" onClick={() => {
                    useAppMetadataStore.getState().toggleLogPanel();
                    live.reveal(d.range.start.line + 1, d.range.start.character + 1);
                }}>
                    {severity(d.severity)} · Line {d.range.start.line + 1}:{d.range.start.character + 1}
                </Button>
                <div className="lsp-log__message">{d.message}{d.code !== undefined && ` (${d.code})`}</div>
                {d.rawMessage && <details><summary>Original server message</summary><pre>{d.rawMessage}</pre></details>}
            </div>)}
        </div>
    </div>;
};
