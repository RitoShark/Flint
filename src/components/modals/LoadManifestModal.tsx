import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import * as api from '../../lib/api';
import type { ManifestEntryDto } from '../../lib/api/cdn';
import { useModalStore, useNavigationStore } from '../../lib/stores';
import { useCdnManifestStore, filterManifests, type ArtifactFilter } from '../../lib/stores/cdnManifestStore';

const REGIONS = ['NA1', 'EUW1', 'EUN1', 'KR', 'BR1', 'JP1', 'LA1', 'LA2', 'OC1', 'RU', 'TR1', 'PBE1', 'SG2', 'TW2', 'VN2', 'PH2', 'TH2', 'ME1'];
const PLATFORMS: [string, string][] = [['windows', 'Windows'], ['macos', 'macOS'], ['android', 'Android'], ['ios', 'iOS']];

export const LoadManifestModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const setView = useNavigationStore((s) => s.setView);
    const setActiveManifest = useNavigationStore((s) => s.setActiveManifest);
    const addSession = useCdnManifestStore((s) => s.addSession);

    const [region, setRegion] = useState('NA1');
    const [platform, setPlatform] = useState('windows');
    const [filter, setFilter] = useState<ArtifactFilter>('game');
    const [entries, setEntries] = useState<ManifestEntryDto[]>([]);
    const [fetching, setFetching] = useState(false);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [selectedUrl, setSelectedUrl] = useState<string | null>(null);

    const visible = filterManifests(entries, filter);

    const fetchVersions = async () => {
        setFetching(true);
        setError(null);
        setEntries([]);
        setSelectedUrl(null);
        try {
            setEntries(await api.cdnListManifests(region, platform));
        } catch (e) {
            setError((e as Error).message ?? String(e));
        } finally {
            setFetching(false);
        }
    };

    const load = async () => {
        if (!selectedUrl) return;
        const entry = entries.find((e) => e.url === selectedUrl);
        setLoading(true);
        setError(null);
        try {
            const res = await api.cdnLoadManifest(selectedUrl);
            addSession({
                sessionId: res.session_id,
                label: `${entry?.patch ?? 'manifest'} · ${region}`,
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
                    </div>
                    <div className="dl-row">
                        <span className="dl-row__label">Platform</span>
                        <select className="dl-select" value={platform} onChange={(e) => setPlatform(e.target.value)}>
                            {PLATFORMS.map(([v, l]) => <option key={v} value={v}>{l}</option>)}
                        </select>
                    </div>
                    <button className="dl-btn dl-btn--secondary" disabled={fetching} onClick={fetchVersions}>
                        {fetching ? 'Fetching…' : 'Fetch versions'}
                    </button>

                    {error && <div className="dl-badge--danger" style={{ marginTop: 8 }}>{error}</div>}

                    {entries.length > 0 && (
                        <>
                            <div className="dl-tabs" style={{ marginTop: 12 }}>
                                {(['game', 'client', 'all'] as ArtifactFilter[]).map((f) => (
                                    <button
                                        key={f}
                                        className={`dl-tab ${filter === f ? 'dl-tab--active' : ''}`}
                                        onClick={() => setFilter(f)}
                                    >
                                        {f === 'game' ? 'Game' : f === 'client' ? 'Client' : 'All'}
                                    </button>
                                ))}
                            </div>
                            <div style={{ maxHeight: 280, overflowY: 'auto', marginTop: 8 }}>
                                {visible.map((e) => (
                                    <label
                                        key={e.url}
                                        className="dl-row"
                                        title={e.version}
                                        style={{ cursor: 'pointer', alignItems: 'center' }}
                                    >
                                        <input
                                            type="radio"
                                            name="manifest"
                                            checked={selectedUrl === e.url}
                                            onChange={() => setSelectedUrl(e.url)}
                                        />
                                        <span style={{ flex: 1 }}>{e.patch}</span>
                                        <span className={`dl-badge--${e.kind === 'game' ? 'success' : 'warn'}`}>{e.kind}</span>
                                    </label>
                                ))}
                                {visible.length === 0 && <div className="dl-row__label">No versions for this filter.</div>}
                            </div>
                        </>
                    )}
                </div>
                <div className="dl-modal__foot">
                    <button className="dl-btn dl-btn--ghost" onClick={closeModal}>Cancel</button>
                    <button className="dl-btn dl-btn--primary" disabled={!selectedUrl || loading} onClick={load}>
                        {loading ? 'Loading…' : 'Load'}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};
