import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import * as api from '../../lib/api';
import type { CatalogEntryDto } from '../../lib/api/cdn';
import { useModalStore, useNavigationStore } from '../../lib/stores';
import { useCdnManifestStore, filterManifests, type ArtifactFilter } from '../../lib/stores/cdnManifestStore';

const REGIONS = ['EUW1', 'NA1', 'EUN1', 'KR', 'BR1', 'JP1', 'LA1', 'LA2', 'OC1', 'RU', 'TR1', 'PBE1', 'SG2', 'TW2', 'VN2', 'PH2', 'TH2', 'ME1'];
const PLATFORMS: [string, string][] = [['windows', 'Windows'], ['macos', 'macOS']];
const FILTERS: [ArtifactFilter, string][] = [['game', 'Game'], ['client', 'Client'], ['all', 'All']];

const CHEVRON = (
    <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
        <path d="m6 9 6 6 6-6" />
    </svg>
);

/** A single-select dropdown trigger + portal-free inline menu (design-lab styled). */
const SelectField: React.FC<{
    label: string;
    value: string;
    options: [string, string][]; // [value, display]
    onChange: (v: string) => void;
}> = ({ label, value, options, onChange }) => {
    const [open, setOpen] = useState(false);
    const ref = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!open) return;
        const onDoc = (e: MouseEvent) => {
            if (ref.current && !ref.current.contains(e.target as Node)) setOpen(false);
        };
        const onEsc = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
        document.addEventListener('mousedown', onDoc);
        document.addEventListener('keydown', onEsc);
        return () => { document.removeEventListener('mousedown', onDoc); document.removeEventListener('keydown', onEsc); };
    }, [open]);

    const display = options.find(([v]) => v === value)?.[1] ?? value;

    return (
        <div className="cdn-selfield" ref={ref}>
            <span className="cdn-field-label">{label}</span>
            <button
                type="button"
                className={`cdn-ddtrigger${open ? ' cdn-ddtrigger--open' : ''}`}
                onClick={() => setOpen((o) => !o)}
            >
                <span>{display}</span>
                {CHEVRON}
            </button>
            {open && (
                <div className="cdn-ddmenu">
                    {options.map(([v, d]) => (
                        <button
                            key={v}
                            type="button"
                            className={v === value ? 'cdn-ddmenu__item cdn-ddmenu__item--on' : 'cdn-ddmenu__item'}
                            onClick={() => { onChange(v); setOpen(false); }}
                        >
                            <span>{d}</span>
                            <svg className="cdn-ddmenu__tick" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3"><path d="M20 6 9 17l-5-5" /></svg>
                        </button>
                    ))}
                </div>
            )}
        </div>
    );
};

export const LoadManifestModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const setView = useNavigationStore((s) => s.setView);
    const setActiveManifest = useNavigationStore((s) => s.setActiveManifest);
    const addSession = useCdnManifestStore((s) => s.addSession);

    const [region, setRegion] = useState('EUW1');
    const [platform, setPlatform] = useState('windows');
    const [filter, setFilter] = useState<ArtifactFilter>('game');
    const [entries, setEntries] = useState<CatalogEntryDto[]>([]);
    const [cached, setCached] = useState<Set<string>>(new Set());
    const [fetching, setFetching] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedPath, setSelectedPath] = useState<string>('');
    const [search, setSearch] = useState('');

    const visible = useMemo(() => {
        const byKind = filterManifests(entries, filter);
        const q = search.trim().toLowerCase();
        if (!q) return byKind;
        return byKind.filter((e) => e.version.toLowerCase().includes(q) || e.patch.toLowerCase().includes(q));
    }, [entries, filter, search]);

    // Keep the selection valid when the filtered list changes.
    useEffect(() => {
        if (visible.length === 0) { setSelectedPath(''); return; }
        if (!visible.some((e) => e.path === selectedPath)) {
            setSelectedPath(visible[0].path);
        }
    }, [visible, selectedPath]);

    const refreshCached = async (list: CatalogEntryDto[]) => {
        try {
            const hits = await api.cdnCachedVersions(list.map((e) => e.path));
            setCached(new Set(hits));
        } catch {
            setCached(new Set());
        }
    };

    const fetchVersions = async (refresh = false) => {
        setFetching(true);
        setError(null);
        if (!refresh) setEntries([]);
        try {
            const list = await api.cdnListVersions(region, platform, refresh);
            setEntries(list);
            refreshCached(list);
        } catch (e) {
            setError((e as Error).message ?? String(e));
        } finally {
            setFetching(false);
        }
    };

    // Auto-fetch on open and whenever region/platform changes.
    useEffect(() => { fetchVersions(false); /* eslint-disable-next-line */ }, [region, platform]);

    const selectedVersion = entries.find((e) => e.path === selectedPath)?.version;

    const load = async () => {
        if (!selectedPath) return;
        const entry = entries.find((e) => e.path === selectedPath);
        setLoading(true);
        setError(null);
        try {
            const res = await api.cdnLoadManifestByPath(selectedPath);
            addSession({
                sessionId: res.session_id,
                label: `${entry?.version ?? 'manifest'} · ${region}`,
                region,
                tree: res.tree,
                fileCount: res.file_count,
                expandedFolders: new Set(),
                expandedWads: new Set(),
                searchQuery: '',
                checkedFiles: new Set(),
                selected: null,
                wadInner: new Map(),
            });
            setActiveManifest(res.session_id);
            setView('manifest');
            closeModal();
        } catch (e) {
            setError((e as Error).message ?? String(e));
            setLoading(false);
        }
    };

    return createPortal(
        <div className="dl-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) closeModal(); }}>
            <div className="dl-modal dl-modal--wide cdn-modal">
                <div className="dl-modal__head">
                    <span className="dl-modal__title">
                        <svg className="cdn-title-glyph" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                            <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" />
                        </svg>
                        Load from CDN
                    </span>
                </div>
                <div className="dl-modal__body cdn-modal__body">
                    {/* One-row selectors: Platform · Kind · Region */}
                    <div className="cdn-selrow">
                        <SelectField label="Platform" value={platform} options={PLATFORMS} onChange={setPlatform} />
                        <SelectField label="Kind" value={filter} options={FILTERS.map(([v, l]) => [v, l])} onChange={(v) => setFilter(v as ArtifactFilter)} />
                        <SelectField label="Region" value={region} options={REGIONS.map((r) => [r, r])} onChange={setRegion} />
                    </div>

                    {error && <div className="dl-badge--danger cdn-error">{error}</div>}

                    <div className="cdn-verhead">
                        <span className="cdn-count">
                            {fetching ? 'Loading…' : search.trim()
                                ? `${visible.length} of ${filterManifests(entries, filter).length} manifests`
                                : `${visible.length} manifest${visible.length === 1 ? '' : 's'}`}
                        </span>
                        <button
                            className="cdn-refresh"
                            disabled={fetching}
                            title="Check the GitHub catalog for newly-shipped manifests"
                            onClick={() => fetchVersions(true)}
                        >
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><path d="M21 12a9 9 0 1 1-2.64-6.36" /><path d="M21 3v6h-6" /></svg>
                        </button>
                        <div className="cdn-search">
                            <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"><circle cx="11" cy="11" r="7" /><path d="m21 21-4.3-4.3" /></svg>
                            <input type="text" placeholder="Filter version / patch…" value={search} onChange={(e) => setSearch(e.target.value)} />
                        </div>
                    </div>

                    <div className="cdn-verlist">
                        {fetching && (
                            <div className="cdn-overlay"><div className="cdn-spinner cdn-spinner--lg" />Fetching version history…</div>
                        )}
                        {!fetching && visible.length === 0 && (
                            <div className="cdn-empty">No manifests match.</div>
                        )}
                        {visible.map((e) => (
                            <button
                                type="button"
                                key={e.path}
                                className={`cdn-vcard${e.path === selectedPath ? ' cdn-vcard--sel' : ''}`}
                                onClick={() => setSelectedPath(e.path)}
                                onDoubleClick={() => { setSelectedPath(e.path); load(); }}
                            >
                                <div className="cdn-vcard__main">
                                    <span className="cdn-vcard__ver">{e.version}</span>
                                    <span className="cdn-vcard__sub">
                                        patch {e.patch}{e.build ? ` · build ${e.build}` : ''}
                                    </span>
                                </div>
                                {cached.has(e.path) && (
                                    <span className="cdn-dlbadge">
                                        <svg viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2.4" strokeLinecap="round" strokeLinejoin="round"><path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4" /><path d="M7 10l5 5 5-5" /><path d="M12 15V3" /></svg>
                                        Downloaded
                                    </span>
                                )}
                                <span className={`cdn-kindbadge${e.kind === 'client' ? ' cdn-kindbadge--client' : ''}`}>
                                    <span className="cdn-kindbadge__dot" />{e.kind}
                                </span>
                            </button>
                        ))}
                    </div>
                </div>
                <div className="dl-modal__foot cdn-modal__foot">
                    <span className="cdn-footnote">
                        {selectedVersion ? `Selected: ${selectedVersion} · ${region}` : 'Select a version'}
                    </span>
                    <div className="cdn-foot-actions">
                        <button className="dl-btn dl-btn--ghost" onClick={closeModal}>Cancel</button>
                        <button className="dl-btn dl-btn--primary" disabled={!selectedPath || loading} onClick={load}>
                            {loading ? <><span className="cdn-spinner" /><span>Loading manifest…</span></> : 'Load'}
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
};
