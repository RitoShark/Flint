/**
 * TransferModal
 * Opened when the user drags a file/folder from one project's tree and drops it
 * into another project (onto a folder, after spring-loading into that project).
 * The destination is already decided by where they dropped — this dialog only
 * asks Move or Copy. Mounted once in App; driven by `useTransferStore`.
 */

import React, { useState } from 'react';
import {
    Modal,
    ModalHeader,
    ModalBody,
    ModalFooter,
    ModalLoading,
    Button,
} from '../ui';
import { useTransferStore, useProjectTabStore, useNotificationStore } from '../../lib/stores';
import * as api from '../../lib/api';

export const TransferModal: React.FC = () => {
    const pending = useTransferStore((s) => s.pending);
    const closeTransfer = useTransferStore((s) => s.closeTransfer);
    const showToast = useNotificationStore((s) => s.showToast);

    const [busy, setBusy] = useState(false);

    const sourceName = pending?.payload.name ?? '';
    const sourceKind = pending?.payload.isDirectory ? 'folder' : 'file';
    const destLabel = pending
        ? `${pending.destProjectName}${pending.destFolder && pending.destFolder !== '.' ? ` / ${pending.destFolder}` : ''}`
        : '';

    /** Refresh the file tree of any open tab pointing at `projectPath`. */
    const refreshProjectTree = async (projectPath: string) => {
        const tab = useProjectTabStore.getState().openTabs.find((t) => t.projectPath === projectPath);
        if (!tab) return;
        try {
            const files = await api.listProjectFiles(projectPath);
            useProjectTabStore.getState().setFileTree(tab.id, files);
        } catch {
            // tree refresh is best-effort; the file watcher will catch up
        }
    };

    const runTransfer = async (op: 'copy' | 'move') => {
        if (!pending) return;
        setBusy(true);
        try {
            const { payload, destProjectPath, destFolder } = pending;
            const fn = op === 'copy' ? api.copyBetweenProjects : api.moveBetweenProjects;
            const created = await fn(payload.projectPath, [payload.relPath], destProjectPath, destFolder);
            await refreshProjectTree(destProjectPath);
            if (op === 'move') await refreshProjectTree(payload.projectPath);
            showToast(
                'success',
                `${op === 'copy' ? 'Copied' : 'Moved'} ${created.length} item${created.length === 1 ? '' : 's'} to ${pending.destProjectName}`,
            );
            closeTransfer();
        } catch (err) {
            const flintError = err as api.FlintError;
            showToast('error', flintError.getUserMessage?.() || `Failed to ${op} ${sourceName}`);
        } finally {
            setBusy(false);
        }
    };

    if (!pending) return null;

    return (
        <Modal open={!!pending} onClose={busy ? () => {} : closeTransfer}>
            {busy && <ModalLoading text="Transferring" progress={`${sourceName}…`} />}

            <ModalHeader title="Move or Copy?" onClose={closeTransfer} />

            <ModalBody>
                <p style={{ margin: 0, color: 'var(--text-secondary)' }}>
                    {sourceKind === 'folder' ? 'Folder ' : 'File '}
                    <strong style={{ color: 'var(--text-primary)' }}>{sourceName}</strong>
                    {' → '}
                    <strong style={{ color: 'var(--text-primary)' }}>{destLabel}</strong>
                </p>
            </ModalBody>

            <ModalFooter>
                <Button variant="ghost" onClick={closeTransfer} disabled={busy}>
                    Cancel
                </Button>
                <Button variant="secondary" onClick={() => runTransfer('copy')} disabled={busy}>
                    Copy
                </Button>
                <Button variant="primary" onClick={() => runTransfer('move')} disabled={busy}>
                    Move
                </Button>
            </ModalFooter>
        </Modal>
    );
};
