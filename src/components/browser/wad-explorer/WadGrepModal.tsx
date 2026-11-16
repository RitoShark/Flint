import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { Button, Checkbox } from '../../ui';
import { HitRow } from '../WorkspaceSearch';
import { useUxStore } from '../../../lib/stores';
import type { WadExplorerWad } from '../../../lib/types';
import { beginWadGrep, cancelWadGrep, grepGameWads, type WadGrepFile, type WadGrepResult } from '../../../lib/api/wadGrep';

export interface WadGrepRequest { wadPath?: string; query?: string; references?: boolean }

export const WadGrepModal: React.FC<{
    request: WadGrepRequest;
    wads: WadExplorerWad[];
    onClose: () => void;
    onOpen: (file: WadGrepFile, line: number) => Promise<void>;
}> = ({ request, wads, onClose, onOpen }) => {
    const [query, setQuery] = useState(request.query ?? '');
    const [scope, setScope] = useState(request.wadPath ? 'current' : 'all');
    const [options, setOptions] = useState({ caseSensitive: false, wholeWord: false, regex: false });
    const [types, setTypes] = useState(['bin', 'troybin', 'luabin']);
    const [result, setResult] = useState<WadGrepResult | null>(null);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const [progress, setProgress] = useState({ completed: 0, total: 0, scanned: 0 });
    const active = useRef<string | null>(null);
    const mounted = useRef(true);
    const running = useRef(false);
    const stopped = useRef(false);
    const theme = useUxStore(s => s.binEditorSyntaxTheme);

    useEffect(() => {
        mounted.current = true;
        return () => {
            mounted.current = false;
            stopped.current = true;
            if (active.current) void cancelWadGrep(active.current).catch(() => {});
        };
    }, []);
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    const search = async () => {
        if (running.current) return;
        const paths = wads.filter(w => scope === 'all' || (scope === 'current' ? w.path === request.wadPath : w.category.toLowerCase() === 'champions')).map(w => w.path);
        if (!paths.length) { setError('No WADs available in this scope'); return; }
        running.current = true;
        stopped.current = false;
        setBusy(true); setError(''); setResult(null);
        setProgress({ completed: 0, total: paths.length, scanned: 0 });
        let unlisten: (() => void) | undefined;
        let id: string | undefined;
        try {
            id = await beginWadGrep();
            active.current = id;
            if (!mounted.current || stopped.current) { await cancelWadGrep(id); return; }
            unlisten = await listen<{ id: string; completed: number; total: number; scanned: number }>('wad-grep-progress', event => {
                if (mounted.current && event.payload.id === id) setProgress(event.payload);
            });
            if (!mounted.current || stopped.current) { await cancelWadGrep(id); return; }
            const next = await grepGameWads(id, paths, query, options, types, !!request.references);
            if (mounted.current) setResult(next);
        } catch (e) {
            if (mounted.current && !stopped.current) setError(e instanceof Error ? e.message : String(e));
        } finally {
            unlisten?.();
            if (id) void cancelWadGrep(id).catch(() => {});
            active.current = null;
            running.current = false;
            if (mounted.current) setBusy(false);
        }
    };
    const stop = () => {
        stopped.current = true;
        if (active.current) void cancelWadGrep(active.current).catch(() => {});
    };
    const openHit = async (file: WadGrepFile, line: number) => {
        try { await onOpen(file, line); onClose(); }
        catch (e) { setError(e instanceof Error ? e.message : String(e)); }
    };

    return createPortal(<div className="dl-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget) onClose(); }}>
        <div className="dl-modal dl-modal--large wad-grep" role="dialog" aria-modal="true" aria-label="Search WAD contents">
            <div className="dl-modal__head"><h2 className="dl-modal__title">{request.references ? 'Check File References' : 'Search WAD Contents'}</h2></div>
            <div className="dl-modal__body">
                <form onSubmit={e => { e.preventDefault(); void search(); }}>
                    <div className="dl-row">
                        <input className="dl-input" aria-label="Search query" value={query} onChange={e => setQuery(e.target.value)} disabled={busy} autoFocus />
                        <select className="dl-select" aria-label="Search scope" value={scope} onChange={e => setScope(e.target.value)} disabled={busy}>
                            {request.wadPath && <option value="current">Current WAD</option>}
                            <option value="champions">All Champion WADs</option><option value="all">Whole Game Index</option>
                        </select>
                        <Button type="submit" disabled={busy || !query.trim() || !types.length}>Search</Button>
                    </div>
                    {!request.references && <div className="dl-row">
                        {(['caseSensitive', 'wholeWord', 'regex'] as const).map((key, i) => <Checkbox key={key} label={['Case sensitive', 'Whole word', 'Regex'][i]} checked={options[key]} disabled={busy} onChange={e => setOptions({ ...options, [key]: e.target.checked })} />)}
                    </div>}
                    <div className="dl-row">{['bin', 'troybin', 'luabin'].map(type => <Checkbox key={type} label={type === 'luabin' ? '.luabin / .luabin64' : `.${type}`} checked={types.includes(type)} disabled={busy} onChange={e => setTypes(e.target.checked ? [...types, type] : types.filter(t => t !== type))} />)}</div>
                </form>
                {request.references && <p>Matches paths, filenames, stems, and FNV-1a / XXH64 hashes. Filename matches may include unrelated files.</p>}
                {busy && <div role="status"><progress max={progress.total || 1} value={progress.completed} /> {progress.completed}/{progress.total} WADs / {progress.scanned} files scanned <Button size="sm" onClick={stop}>Stop</Button></div>}
                {error && <p role="alert">{error}</p>}
                {result && <p role="status">{result.files.length} matching files / {result.scanned} scanned / {result.failed} failed / {result.unresolved} unresolved chunks skipped{result.cancelled ? ' / Stopped; partial results' : ''}{result.truncated ? ' / Result limit reached; narrow your search' : ''}</p>}
                <div className="ws-search__results">{result?.files.map(file => <details key={`${file.wad_path}:${file.hash}`} open>
                    <summary className="wad-grep__file">{file.path} - {file.wad_path.split(/[\\/]/).pop()} ({file.matches.length}{file.extra ? ` + ${file.extra} more` : ''})</summary>
                    {file.matches.map((hit, i) => <HitRow key={i} hit={hit} presetId={theme} onOpen={() => void openHit(file, hit.line)} />)}
                </details>)}</div>
            </div>
            <div className="dl-modal__foot"><Button variant="secondary" onClick={onClose}>Close</Button></div>
        </div>
    </div>, document.body);
};
