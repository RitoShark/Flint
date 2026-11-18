import { Checkbox } from '../../ui/Checkbox';
import { useEffect, useRef, useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { open } from '../../../lib/api/dialog';
import * as api from '../../../lib/api';
import { invokeCommand } from '../../../lib/api/core';
import type { VfxModel } from '../../../lib/api/paint';
export function VfxPortModal({ target, onClose, onImported }: { target: string; onClose: () => void; onImported: () => void }) {
    const [source, setSource] = useState('');
    const [model, setModel] = useState<VfxModel | null>(null);
    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const active = useRef(true);
    useEffect(() => { active.current = true; return () => { active.current = false; }; }, []);
    return <Modal open size="large" onClose={onClose} closeOnEscape={!busy} closeOnOverlay={!busy}>
        <ModalHeader title="Import VFX from a donor" />
        <ModalBody><div className="voice-editor">
            <p>Import selected systems and their referenced assets from an extracted project. Existing definitions and files are preserved; conflicts stop the import. A project restore point is created first.</p>
            <Button disabled={busy} onClick={async () => {
                const picked = await open({ filters: [{ name: 'BIN', extensions: ['bin'] }], multiple: false });
                if (typeof picked !== 'string' || !active.current) return;
                setBusy(true); setError(''); setSource(picked); setSelected(new Set()); setModel(null);
                try { const donor = await api.paintOpen(picked); await api.paintClose(donor.sessionId); if (active.current) setModel(donor.model); }
                catch (e) { if (active.current) setError(String(e)); } finally { if (active.current) setBusy(false); }
            }}>Choose donor BIN...</Button>
            <p>{source}</p>
            {error && <p role="alert">{error}</p>}
            {model && !model.systems.length && <p>This BIN has no VFX systems.</p>}
            {model?.systems.map(system => <Checkbox key={system.key} label={system.name} description={`${system.emitterKeys.length} emitters`}
                checked={selected.has(system.key)} disabled={busy} onChange={e => setSelected(old => { const next = new Set(old); if (e.target.checked) next.add(system.key); else next.delete(system.key); return next; })} />)}
        </div></ModalBody>
        <ModalFooter><Button variant="ghost" disabled={busy} onClick={onClose}>Cancel</Button>
            <Button variant="primary" disabled={busy || !selected.size} onClick={async () => {
                setBusy(true); setError('');
                try { await invokeCommand('port_vfx_systems', { source, target, systems: [...selected] }); onImported(); }
                catch (e) { setError(String(e)); } finally { setBusy(false); }
            }}>{busy ? 'Working...' : `Import ${selected.size} systems`}</Button>
        </ModalFooter>
    </Modal>;
}
