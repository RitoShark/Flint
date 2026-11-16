import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { listen } from '@tauri-apps/api/event';
import { Button, Icon } from '../../ui';
import { WadGrepResults } from './WadGrepResults';
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
            <div className="dl-modal__head">
                <Icon name="search" className="wad-grep__heading-icon" />
                <div><h2 className="dl-modal__title">{request.references ? 'File references' : 'Search WAD contents'}</h2><p className="wad-grep__subtitle">Find a WAD, expand a file, then open a matching line.</p></div>
            </div>
            <div className="dl-modal__body">
                <form className="wad-grep__search" onSubmit={e => { e.preventDefault(); void search(); }}>
                    <div className="wad-grep__query-row">
                        <input className="dl-input" aria-label="Search query" placeholder="Search inside game files..." value={query} onChange={e => setQuery(e.target.value)} disabled={busy} autoFocus />
                        <select className="dl-select" aria-label="Search scope" value={scope} onChange={e => setScope(e.target.value)} disabled={busy}>
                            {request.wadPath && <option value="current">Current WAD</option>}
                            <option value="champions">Champion WADs</option><option value="all">Whole game</option>
                        </select>
                        {busy ? <Button type="button" variant="secondary" onClick={stop}>Stop</Button> : <Button type="submit" variant="primary" icon="search" disabled={!query.trim() || !types.length}>Search</Button>}
                    </div>
                    <div className="wad-grep__filters">
                        <div className="wad-grep__filter-group" aria-label="File types">
                            {['bin', 'troybin', 'luabin'].map(type => <Button key={type} size="sm" variant="ghost" active={types.includes(type)} aria-pressed={types.includes(type)} disabled={busy} onClick={() => setTypes(types.includes(type) ? types.filter(t => t !== type) : [...types, type])}>{type === 'luabin' ? 'Lua' : `.${type}`}</Button>)}
                        </div>
                        {!request.references && <div className="wad-grep__filter-group" aria-label="Matching options">
                            {(['caseSensitive', 'wholeWord', 'regex'] as const).map((key, i) => <Button key={key} size="sm" variant="ghost" active={options[key]} aria-pressed={options[key]} disabled={busy} onClick={() => setOptions({ ...options, [key]: !options[key] })}>{['Match case', 'Whole word', 'Regex'][i]}</Button>)}
                        </div>}
                    </div>
                    {request.references && <p className="wad-grep__subtitle">Searches paths, filenames, and hashes. Filename matches may include unrelated files.</p>}
                </form>
                {error && <p className="wad-grep__notice" role="alert">{error}</p>}
                {result?.cancelled && <p className="wad-grep__notice" role="status">Stopped; partial results</p>}
                {result?.truncated && <p className="wad-grep__notice">Result limit reached. Narrow your search to find more.</p>}
                {result && result.files.length > 0 ? <WadGrepResults files={result.files} theme={theme} onOpen={(file, line) => void openHit(file, line)} /> :
                    <div className="wad-grep__empty">
                        <Icon name={busy ? 'search' : 'folder'} />
                        <strong>{busy ? 'Searching game files' : result ? 'No matches found' : 'Search inside your WADs'}</strong>
                        <p>{busy ? 'You can stop at any time and keep partial results.' : result ? 'Try another query, file type, or search scope.' : 'Results are grouped by WAD. Open a folder to explore its files.'}</p>
                    </div>}
            </div>
            <div className="dl-modal__foot wad-grep__footer">
                <div className="wad-grep__status" role="status">
                    {busy ? <><progress max={progress.total || 1} value={progress.completed} /><span>{progress.completed} / {progress.total} WADs <span className="wad-grep__muted">/ {progress.scanned.toLocaleString()} files scanned</span></span></> : result ? <span>{result.files.length} matching files <span className="wad-grep__muted">/ {result.scanned.toLocaleString()} scanned</span></span> : <span className="wad-grep__muted">.bin, .troybin, .luabin, .luabin64</span>}
                    {result && (result.failed > 0 || result.unresolved > 0) && <span className="wad-grep__muted">{result.failed > 0 ? `${result.failed} failed. ` : ''}{result.unresolved > 0 ? `${result.unresolved.toLocaleString()} unresolved chunks skipped.` : ''}</span>}
                </div>
                <Button variant="secondary" onClick={onClose}>Close</Button>
            </div>
        </div>
    </div>, document.body);
};
