import { useEffect, useMemo, useRef, useState } from 'react';
import { Button } from '../ui/Button';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { useConfigStore, useProjectTabStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { invokeCommand } from '../../lib/api/core';
import type { GameWadInfo, ProjectTab, WadChunk } from '../../lib/types';
import { lazyWarm } from '../../lib/ui-helpers/lazyWarm';
import { Suspense } from 'react';

const ChunkPreview = lazyWarm(() => import('./wad-explorer/ChunkPreview').then(m => ({ default: m.ChunkPreview })));
interface Inventory { present: string[]; references: string[]; wads: string[] }
interface Branch { folders: Map<string, Branch>; files: WadChunk[] }
function branch(chunks: WadChunk[]): Branch {
    const root: Branch = { folders: new Map(), files: [] };
    for (const chunk of chunks) {
        const pieces = (chunk.path || chunk.hash).split('/');
        let node = root;
        for (const part of pieces.slice(0, -1)) {
            if (!node.folders.has(part)) node.folders.set(part, { folders: new Map(), files: [] });
            node = node.folders.get(part)!;
        }
        node.files.push(chunk);
    }
    return root;
}
function GhostFolder({ name, node, onPick }: { name: string; node: Branch; onPick: (chunk: WadChunk) => void }) {
    const [expanded, setExpanded] = useState(false);
    return <details onToggle={e => setExpanded(e.currentTarget.open)}><summary>{name}</summary>
        {expanded && <GhostBranch node={node} onPick={onPick} />}</details>;
}
function GhostBranch({ node, onPick }: { node: Branch; onPick: (chunk: WadChunk) => void }) {
    const [limit, setLimit] = useState(200);
    return <div className="ghost-tree__branch">
        {[...node.folders].sort(([a], [b]) => a.localeCompare(b)).map(([name, child]) => <GhostFolder key={name} name={name} node={child} onPick={onPick} />)}
        {node.files.slice(0, limit).map(chunk => <Button key={chunk.hash} variant="ghost" size="sm" className="ghost-tree__file"
            title={`${chunk.path || chunk.hash} - available from game, not copied`} onClick={() => onPick(chunk)}>{(chunk.path || chunk.hash).split('/').pop()}</Button>)}
        {node.files.length > limit && <Button size="sm" variant="ghost" onClick={() => setLimit(n => n + 200)}>Show more ({node.files.length - limit} remaining)</Button>}
    </div>;
}
export function ProjectGhostFiles({ tab }: { tab: ProjectTab }) {
    const leaguePath = useConfigStore(s => s.leaguePath);
    const [open, setOpen] = useState(false);
    const [inventory, setInventory] = useState<Inventory | null>(null);
    const [wads, setWads] = useState<GameWadInfo[]>([]);
    const [chunks, setChunks] = useState<Record<string, WadChunk[]>>({});
    const [loading, setLoading] = useState('');
    const loadingWads = useRef(new Set<string>());
    const [query, setQuery] = useState('');
    const [error, setError] = useState('');
    const [selected, setSelected] = useState<{ wad: GameWadInfo; chunk: WadChunk } | null>(null);
    const [layers, setLayers] = useState<api.ProjectLayer[]>([]);
    const [layer, setLayer] = useState('base');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        if (!open) return;
        let active = true;
        setLoading('sources'); setError('');
        if (!leaguePath) { setError('Set your League installation in Settings to browse game files.'); setLoading(''); return; }
        void Promise.all([
            invokeCommand<Inventory>('project_ghost_inventory', { projectPath: tab.projectPath }),
            api.scanGameWads(leaguePath), api.listProjectLayers(tab.projectPath),
        ]).then(([inv, gameWads, projectLayers]) => {
            if (!active) return;
            setInventory(inv);
            setWads(gameWads.filter(w => inv.wads.includes(w.name.toLowerCase()) || w.name.toLowerCase() === `${(tab.project.champion || '').toLowerCase()}.wad.client`));
            setLayers(projectLayers); setLayer(projectLayers[0]?.name || 'base');
        }).catch(e => { if (active) setError(String(e)); }).finally(() => { if (active) setLoading(''); });
        return () => { active = false; };
    }, [open, leaguePath, tab.projectPath, tab.project.champion]);
    const present = useMemo(() => new Set(inventory?.present), [inventory]);
    const references = useMemo(() => new Set(inventory?.references), [inventory]);
    const available = (wad: GameWadInfo) => (chunks[wad.path] || []).filter(c =>
        !present.has(`${wad.name.toLowerCase()}/${c.hash.replace(/^0x/, '').toLowerCase()}`)
        && references.has(c.hash.replace(/^0x/, '').toLowerCase())
        && (c.path || c.hash).toLowerCase().includes(query.toLowerCase()));
    return <section className="ghost-tree">
        <Button variant="ghost" size="sm" aria-expanded={open} onClick={() => setOpen(v => !v)}>Game files {open ? '-' : '+'}</Button>
        {open && <>
            <p>Gray files stay in the game until you bring them to a layer.</p>
            <input aria-label="Filter game files" placeholder="Filter game files..." value={query} onChange={e => setQuery(e.target.value)} />
            {loading && <p role="status">Loading game files...</p>}
            {error && <p role="alert">{error}</p>}
            {wads.map(wad => <details key={wad.path} onToggle={e => {
                if (!e.currentTarget.open || chunks[wad.path] || loadingWads.current.has(wad.path)) return;
                loadingWads.current.add(wad.path); setLoading(wad.path);
                void api.getWadChunks(wad.path).then(result => setChunks(old => ({ ...old, [wad.path]: result })))
                    .catch(e => setError(String(e))).finally(() => { loadingWads.current.delete(wad.path); setLoading(loadingWads.current.values().next().value || ''); });
            }}><summary>{wad.name}</summary>
                {chunks[wad.path] && <><span>{available(wad).length} available files</span><GhostBranch node={branch(available(wad))} onPick={chunk => setSelected({ wad, chunk })} /></>}
            </details>)}
        </>}
        {selected && <Modal open size="large" onClose={() => { if (!busy) setSelected(null); }} closeOnOverlay={!busy} closeOnEscape={!busy}>
            <ModalHeader title="Game file preview" />
            <ModalBody><div className="ghost-tree__preview"><Suspense fallback={<p>Loading preview...</p>}>
                <ChunkPreview wadPath={selected.wad.path} chunk={selected.chunk} />
            </Suspense></div>{error && <p role="alert">{error}</p>}</ModalBody>
            <ModalFooter><label>Layer <select aria-label="Layer" value={layer} disabled={busy} onChange={e => setLayer(e.target.value)}>
                {layers.map(l => <option key={l.name}>{l.name}</option>)}</select></label>
                <Button variant="ghost" disabled={busy} onClick={() => setSelected(null)}>Close</Button>
                <Button variant="primary" disabled={busy || !layers.length} onClick={async () => {
                    setBusy(true); setError('');
                    try {
                        await invokeCommand('bring_ghost_to_layer', { projectPath: tab.projectPath, layer, wadPath: selected.wad.path, hash: selected.chunk.hash, assetPath: selected.chunk.path });
                        const tree = await api.listProjectFiles(tab.projectPath);
                        useProjectTabStore.getState().setFileTree(tab.id, tree);
                        setInventory(old => old && ({ ...old, present: [...old.present, `${selected.wad.name.toLowerCase()}/${selected.chunk.hash.replace(/^0x/, '').toLowerCase()}`] }));
                        setSelected(null);
                    } catch (e) { setError(String(e)); } finally { setBusy(false); }
                }}>{busy ? 'Copying...' : 'Bring to layer'}</Button>
            </ModalFooter>
        </Modal>}
    </section>;
}
