import { useEffect, useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { Button } from '../ui/Button';
import { invokeCommand } from '../../lib/api/core';
interface Field { id: number; label: string; kind: string; value: string | boolean | number }
interface Document { version: string; fields: Field[] }
export function VoiceLineEditor({ path, onClose, onSaved }: { path: string; onClose: () => void; onSaved: () => void }) {
    const [document, setDocument] = useState<Document | null>(null);
    const [edits, setEdits] = useState<Record<number, Field['value']>>({});
    const [query, setQuery] = useState('');
    const [error, setError] = useState('');
    const [busy, setBusy] = useState(false);
    useEffect(() => {
        let active = true;
        void invokeCommand<Document>('read_voice_document', { path }).then(d => { if (active) setDocument(d); }).catch(e => { if (active) setError(String(e)); });
        return () => { active = false; };
    }, [path]);
    return <Modal open size="large" onClose={onClose} closeOnEscape={!busy} closeOnOverlay={!busy}>
        <ModalHeader title="Voice lines & contextual rules" />
        <ModalBody><div className="voice-editor">
            <p>Edit event names and values in this BIN's contextual rules. Changes are saved together.</p>
            <input aria-label="Search voice rules" placeholder="Search event, condition or value..." value={query} onChange={e => setQuery(e.target.value)} />
            {error && <p role="alert">{error}</p>}
            {!document && !error && <p role="status">Reading voice rules...</p>}
            {document?.fields.length === 0 && <p>No ContextualActionData entries in this BIN. Open the skin's voice-rules BIN.</p>}
            {document?.fields.filter(f => `${f.label} ${f.value}`.toLowerCase().includes(query.toLowerCase())).map(field => {
                const value = edits[field.id] ?? field.value;
                const parts = field.label.split(' / ');
                return <label className="voice-editor__field" key={field.id}>
                    <span><small>{parts.slice(0, -1).join(' / ')}</small><strong>{parts.at(-1)}</strong></span>
                    {field.kind === 'bool' ? <input aria-label={field.label} type="checkbox" checked={Boolean(value)} disabled={busy} onChange={e => setEdits(old => ({ ...old, [field.id]: e.target.checked }))} /> :
                        <input aria-label={field.label} type={field.kind === 'string' ? 'text' : 'number'} step={field.kind === 'float' ? 'any' : 1} value={String(value)} disabled={busy}
                            onChange={e => setEdits(old => ({ ...old, [field.id]: field.kind === 'string' ? e.target.value : Number(e.target.value) }))} />}
                </label>;
            })}
        </div></ModalBody>
        <ModalFooter><span>{Object.keys(edits).length} edited fields</span>
            <Button variant="ghost" disabled={busy} onClick={onClose}>Close</Button>
            <Button variant="secondary" disabled={busy || !Object.keys(edits).length} onClick={() => setEdits({})}>Reset changes</Button>
            <Button variant="primary" disabled={busy || !document || !Object.keys(edits).length} onClick={async () => {
                setBusy(true); setError('');
                try {
                    const result = await invokeCommand<Document>('save_voice_document', { path, expectedVersion: document!.version, edits: Object.entries(edits).map(([id, value]) => ({ id: Number(id), value })) });
                    setDocument(result); setEdits({}); onSaved();
                } catch (e) { setError(String(e)); } finally { setBusy(false); }
            }}>{busy ? 'Saving...' : 'Save voice rules'}</Button>
        </ModalFooter>
    </Modal>;
}
