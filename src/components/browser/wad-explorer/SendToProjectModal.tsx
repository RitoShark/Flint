import React, { useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../../ui';
import * as api from '../../../lib/api';
import { useConfigStore, useProjectTabStore, useNotificationStore } from '../../../lib/stores';
import { toPosix } from '../../../lib/pathIdentity';

export interface ProjectExtractRequest { wadPath: string; hashes: string[]; label: string }
interface Destination { path: string; name: string }
const key = (path: string) => toPosix(path).replace(/\/$/, '').toLowerCase();

export const SendToProjectModal: React.FC<{ request: ProjectExtractRequest; onClose: () => void }> = ({ request, onClose }) => {
    const tabs = useProjectTabStore(s => s.openTabs);
    const recent = useConfigStore(s => s.recentProjects);
    const root = useConfigStore(s => s.defaultProjectPath);
    const showToast = useNotificationStore(s => s.showToast);
    const [discovered, setDiscovered] = useState<Destination[]>([]);
    const [target, setTarget] = useState('');
    const [layers, setLayers] = useState<api.ProjectLayer[]>([]);
    const [layer, setLayer] = useState('base');
    const [loading, setLoading] = useState(false);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const writing = useRef(false);
    const projects = useMemo(() => {
        const all = [...tabs.map(tab => ({ path: tab.projectPath, name: tab.project.display_name || tab.project.name })), ...recent, ...discovered];
        const seen = new Set<string>();
        return all.filter(p => { const id = key(p.path); if (seen.has(id)) return false; seen.add(id); return true; });
    }, [tabs, recent, discovered]);
    useEffect(() => {
        let active = true;
        if (root) void api.discoverProjects(root).then(found => {
            if (active) setDiscovered(found.filter(p => p.exists).map(p => ({ path: p.path, name: p.display_name || p.name })));
        }).catch(e => { if (active) setError(`Could not discover workspace projects: ${String(e)}`); });
        return () => { active = false; };
    }, [root]);
    useEffect(() => { if (!target && projects.length) setTarget(projects[0].path); }, [target, projects]);
    useEffect(() => {
        let active = true;
        setLayers([]); setLayer('base');
        if (!target) return;
        setLoading(true); setError('');
        void api.readTextFile(`${toPosix(target)}/mod.config.json`).then(() => api.listProjectLayers(target)).then(next => { if (active) { setLayers(next); setLayer(next.some(l => l.name === 'base') ? 'base' : next[0]?.name ?? ''); } })
            .catch(e => { if (active) setError(`Could not load project layers: ${String(e)}`); })
            .finally(() => { if (active) setLoading(false); });
        return () => { active = false; };
    }, [target]);
    useEffect(() => {
        const handler = (e: KeyboardEvent) => { if (e.key === 'Escape' && !writing.current) onClose(); };
        document.addEventListener('keydown', handler);
        return () => document.removeEventListener('keydown', handler);
    }, [onClose]);

    const extract = async () => {
        if (writing.current || !target || !layers.some(l => l.name === layer)) return;
        writing.current = true; setBusy(true); setError('');
        try {
            if (!layer || /[\\/]/.test(layer) || layer === '.' || layer === '..') throw new Error('Invalid target layer');
            await api.readTextFile(`${toPosix(target)}/mod.config.json`);
            const wadName = toPosix(request.wadPath).split('/').pop()!.replace(/\.wad$/i, '.wad.client');
            const output = `${toPosix(target)}/content/${layer}/${wadName}`;
            const result = await api.extractWad(request.wadPath, output, request.hashes);
            const open = useProjectTabStore.getState();
            const matching = open.openTabs.filter(tab => key(tab.projectPath) === key(target));
            let refreshFailed = false;
            if (matching.length) {
                try {
                    const tree = await api.listProjectFiles(target);
                    for (const tab of matching) open.setFileTree(tab.id, tree);
                } catch { refreshFailed = true; }
            }
            const name = projects.find(p => key(p.path) === key(target))?.name ?? target;
            if (result.failed) { setError(`Added ${result.extracted} files; ${result.failed} failed. See the log for details.`); return; }
            showToast(refreshFailed ? 'warning' : 'success', `Added ${request.label} to ${name} (${result.extracted} files)${refreshFailed ? '. Reopen the project to refresh its file tree.' : ''}`);
            onClose();
        } catch (e) { setError(e instanceof Error ? e.message : String(e)); }
        finally { writing.current = false; setBusy(false); }
    };

    return createPortal(<div className="dl-modal-backdrop" onMouseDown={e => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="dl-modal wad-project-picker" role="dialog" aria-modal="true" aria-label="Add to Project">
            <div className="dl-modal__head"><h2 className="dl-modal__title">Add to Project</h2></div>
            <div className="dl-modal__body">
                <p>{request.label} - {request.hashes.length} files</p>
                <label className="dl-row">Project<select className="dl-select" aria-label="Target project" value={target} disabled={busy} onChange={e => setTarget(e.target.value)}>
                    {!projects.length && <option value="">No projects found</option>}
                    {projects.map(p => <option key={key(p.path)} value={p.path}>{p.name} - {p.path}</option>)}
                </select></label>
                <label className="dl-row">Layer<select className="dl-select" aria-label="Target layer" value={layer} disabled={busy || loading} onChange={e => setLayer(e.target.value)}>
                    {layers.map(l => <option key={l.name} value={l.name}>{l.name}</option>)}
                </select></label>
                <p>Files keep their WAD paths. Existing files at the destination will be replaced.</p>
                {loading && <p role="status">Loading layers...</p>}
                {error && <p role="alert">{error}</p>}
            </div>
            <div className="dl-modal__foot"><Button variant="secondary" disabled={busy} onClick={onClose}>Cancel</Button><Button disabled={busy || loading || !layers.some(l => l.name === layer)} onClick={() => void extract()}>{busy ? 'Adding...' : 'Add to Project'}</Button></div>
        </div>
    </div>, document.body);
};

export function useSendToProject() {
    const [request, setRequest] = useState<ProjectExtractRequest | null>(null);
    return { open: setRequest, modal: request && <SendToProjectModal request={request} onClose={() => setRequest(null)} /> };
}
