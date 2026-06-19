import React, { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import * as api from '../../lib/api';
import type { CatalogEntryDto } from '../../lib/api/cdn';
import { useModalStore, useNavigationStore } from '../../lib/stores';
import { useCdnManifestStore, filterManifests, type ArtifactFilter } from '../../lib/stores/cdnManifestStore';

const REGIONS = ['EUW1', 'NA1', 'EUN1', 'KR', 'BR1', 'JP1', 'LA1', 'LA2', 'OC1', 'RU', 'TR1', 'PBE1', 'SG2', 'TW2', 'VN2', 'PH2', 'TH2', 'ME1'];
const PLATFORMS: [string, string][] = [['windows', 'Windows'], ['macos', 'macOS']];
const FILTERS: [ArtifactFilter, string][] = [['game', 'Game'], ['client', 'Client'], ['all', 'All']];

export const LoadManifestModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const setView = useNavigationStore((s) => s.setView);
    const setActiveManifest = useNavigationStore((s) => s.setActiveManifest);
    const addSession = useCdnManifestStore((s) => s.addSession);

    const [region, setRegion] = useState('EUW1');
    const [platform, setPlatform] = useState('windows');
    const [filter, setFilter] = useState<ArtifactFilter>('game');
    const [entries, setEntries] = useState<CatalogEntryDto[]>([]);
    const [fetching, setFetching] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedPath, setSelectedPath] = useState<string>('');

    const visible = useMemo(() => filterManifests(entries, filter), [entries, filter]);

    // Keep the dropdown selection valid when the filter changes.
    useEffect(() => {
        if (visible.length === 0) { setSelectedPath(''); return; }
        if (!visible.some((e) => e.path === selectedPath)) {
            setSelectedPath(visible[0].path);
        }
    }, [visible, selectedPath]);

    const fetchVersions = async (refresh = false) => {
        setFetching(true);
        setError(null);
        if (!refresh) setEntries([]);
        try {
            setEntries(await api.cdnListVersions(region, platform, refresh));
        } catch (e) {
            setError((e as Error).message ?? String(e));
        } finally {
            setFetching(false);
        }
    };

    // Auto-fetch on open and whenever region/platform changes.
    useEffect(() => { fetchVersions(false); /* eslint-disable-next-line */ }, [region, platform]);

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
            <div className="dl-modal dl-modal--wide">
                <div className="dl-modal__head">
                    <span className="dl-modal__title">Load from CDN</span>
                    <button className="dl-modal__close" onClick={closeModal}>×</button>
                </div>
                <div className="dl-modal__body">
                    <div className="dl-row">
                        <span className="dl-row__label">Region</span>
                        <select className="dl-select" value={region} onChange={(e) => setRegion(e.target.value)}>
                            {REGIONS.map((r) => <option key={r} value={r}>{r}</option>)}
                        </select>
                        <span className="dl-row__label" style={{ marginLeft: 12 }}>Platform</span>
                        <select className="dl-select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                            {PLATFORMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                    </div>

                    {error && <div className="dl-badge--danger" style={{ marginTop: 8 }}>{error}</div>}

                    {/* Left: vertical kind buttons. Right: full version dropdown. */}
                    <div style={{ display: 'flex', gap: 16, marginTop: 14, alignItems: 'flex-start' }}>
                        <div style={{ display: 'flex', flexDirection: 'column', gap: 6, minWidth: 96 }}>
                            {FILTERS.map(([f, label]) => (
                                <button
                                    key={f}
                                    className={`dl-btn ${filter === f ? 'dl-btn--primary' : 'dl-btn--secondary'}`}
                                    style={{ justifyContent: 'flex-start' }}
                                    onClick={() => setFilter(f)}
                                >
                                    {label}
                                </button>
                            ))}
                        </div>

                        <div style={{ flex: 1, minWidth: 0 }}>
                            <div className="dl-row__label" style={{ marginBottom: 6, display: 'flex', alignItems: 'center', gap: 8 }}>
                                <span>{fetching ? 'Loading versions…' : `${visible.length} manifest${visible.length === 1 ? '' : 's'}`}</span>
                                <button
                                    className="dl-btn dl-btn--ghost dl-btn--sm"
                                    style={{ marginLeft: 'auto' }}
                                    disabled={fetching}
                                    title="Check the GitHub catalog for newly-shipped manifests"
                                    onClick={() => fetchVersions(true)}
                                >
                                    {fetching ? '…' : 'Refresh'}
                                </button>
                            </div>
                            <select
                                className="dl-select"
                                size={12}
                                style={{ width: '100%', height: 280 }}
                                value={selectedPath}
                                onChange={(e) => setSelectedPath(e.target.value)}
                            >
                                {visible.map((e) => (
                                    <option key={e.path} value={e.path}>
                                        {e.version}{filter === 'all' ? `  (${e.kind})` : ''}
                                    </option>
                                ))}
                            </select>
                        </div>
                    </div>
                </div>
                <div className="dl-modal__foot">
                    <button className="dl-btn dl-btn--ghost" onClick={closeModal}>Cancel</button>
                    <button className="dl-btn dl-btn--primary" disabled={!selectedPath || loading} onClick={load}>
                        {loading ? 'Loading…' : 'Load'}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};
