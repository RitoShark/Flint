import { Suspense, useMemo, useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../ui/Modal';
import { Button } from '../ui/Button';
import { lazyWarm } from '../../lib/ui-helpers/lazyWarm';
import { invokeCommand } from '../../lib/api/core';
import * as api from '../../lib/api';
import type { FileTreeNode } from '../../lib/types';
const ChunkPreview = lazyWarm(() => import('./wad-explorer/ChunkPreview').then(m => ({ default: m.ChunkPreview })));
const ModelPreview = lazyWarm(() => import('../preview/ModelPreview').then(m => ({ default: m.ModelPreview })));
export function InheritedFilePreview({ node, projectPath, onClose, onCopied }: { node: FileTreeNode; projectPath: string; onClose: () => void; onCopied: () => Promise<void> }) {
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    const path = `${projectPath}/${node.ghostSource}`;
    const source = useMemo(() => ({ isLocal: false, readInnerBytes: () => api.readFileBytes(path) }), [path]);
    const model = /\.(skn|scb|sco)$/i.test(path);
    return <Modal open size="large" onClose={onClose} closeOnEscape={!busy} closeOnOverlay={!busy}>
        <ModalHeader title={`${node.name} - inherited from base`} />
        <ModalBody><div className="ghost-tree__preview"><Suspense fallback={<p>Loading preview...</p>}>
            {model ? <ModelPreview filePath={path} meshType={/\.skn$/i.test(path) ? 'skinned' : 'static'} /> :
                <ChunkPreview wadPath="" chunk={{ hash: node.path, path: node.name, size: 0 }} dataSource={source} />}
        </Suspense></div>{error && <p role="alert">{error}</p>}</ModalBody>
        <ModalFooter><span>Not copied into {node.ghostLayer}</span><Button variant="ghost" disabled={busy} onClick={onClose}>Close</Button>
            <Button variant="primary" disabled={busy} onClick={async () => {
                setBusy(true); setError('');
                try { await invokeCommand('bring_inherited_to_layer', { projectPath, source: node.ghostSource, layer: node.ghostLayer }); await onCopied(); onClose(); }
                catch (e) { setError(String(e)); } finally { setBusy(false); }
            }}>{busy ? 'Copying...' : `Bring to ${node.ghostLayer}`}</Button>
        </ModalFooter>
    </Modal>;
}
