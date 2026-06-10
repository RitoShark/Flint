/**
 * TransferModal
 * Opened when the user drags a file/folder from one project's tree onto another
 * project's tab. Lets them pick a destination folder in the target project and
 * choose Copy or Move. Mounted once in App; driven by `useTransferStore`.
 */

import React, { useEffect, useMemo, useState } from 'react';
import {
    Modal,
    ModalHeader,
    ModalBody,
    ModalFooter,
    ModalLoading,
    FormGroup,
    FormLabel,
    FormHint,
    Select,
    Button,
} from '../ui';
import { useTransferStore, useProjectTabStore, useNotificationStore } from '../../lib/stores';
import * as api from '../../lib/api';
import type { FileTreeNode } from '../../lib/types';

/** Collect every directory path (project-relative, forward slashes) in the tree,
 *  sorted, with the project root represented as ".". */
function collectDirectories(root: FileTreeNode | null): string[] {
    if (!root) return ['.'];
    const dirs: string[] = [];
    const walk = (node: FileTreeNode) => {
        if (node.isDirectory) {
            dirs.push(node.path);
            for (const child of node.children ?? []) walk(child);
        }
    };
    walk(root);
    // Ensure the root (".") is first; sort the rest alphabetically.
    const rest = dirs.filter((d) => d !== '.').sort((a, b) => a.localeCompare(b));
    return ['.', ...rest];
}

export const TransferModal: React.FC = () => {
    const pending = useTransferStore((s) => s.pending);
    const closeTransfer = useTransferStore((s) => s.closeTransfer);
    const showToast = useNotificationStore((s) => s.showToast);

    const [folders, setFolders] = useState<string[]>(['.']);
    const [destFolder, setDestFolder] = useState<string>('content');
    const [loadingFolders, setLoadingFolders] = useState(false);
    const [busy, setBusy] = useState(false);

    // Load the destination project's directory list whenever a transfer opens.
    useEffect(() => {
        if (!pending) return;
        let cancelled = false;
        setLoadingFolders(true);
        api.listProjectFiles(pending.destProjectPath)
            .then((tree) => {
                if (cancelled) return;
                const dirs = collectDirectories(tree);
                setFolders(dirs);
                // Default to `content` if it exists, else the project root.
                setDestFolder(dirs.includes('content') ? 'content' : '.');
            })
            .catch(() => {
                if (cancelled) return;
                setFolders(['.']);
                setDestFolder('.');
            })
            .finally(() => {
                if (!cancelled) setLoadingFolders(false);
            });
        return () => { cancelled = true; };
    }, [pending]);

    const folderLabel = (dir: string) => (dir === '.' ? '(project root)' : dir);

    const sourceName = pending?.payload.name ?? '';
    const sourceKind = pending?.payload.isDirectory ? 'folder' : 'file';

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
            const { payload, destProjectPath } = pending;
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

    const folderOptions = useMemo(() => folders, [folders]);

    if (!pending) return null;

    return (
        <Modal open={!!pending} onClose={busy ? () => {} : closeTransfer}>
            {busy && <ModalLoading text="Transferring" progress={`${sourceName}…`} />}

            <ModalHeader title="Copy or Move?" onClose={closeTransfer} />

            <ModalBody>
                <p style={{ margin: '0 0 12px', color: 'var(--text-secondary)' }}>
                    {sourceKind === 'folder' ? 'Folder ' : 'File '}
                    <strong style={{ color: 'var(--text-primary)' }}>{sourceName}</strong>
                    {' → '}
                    <strong style={{ color: 'var(--text-primary)' }}>{pending.destProjectName}</strong>
                </p>

                <FormGroup>
                    <FormLabel>Destination folder</FormLabel>
                    <Select
                        value={destFolder}
                        onChange={(e) => setDestFolder(e.target.value)}
                        disabled={busy || loadingFolders}
                    >
                        {folderOptions.map((dir) => (
                            <option key={dir} value={dir}>
                                {folderLabel(dir)}
                            </option>
                        ))}
                    </Select>
                    <FormHint>
                        {loadingFolders
                            ? 'Loading folders…'
                            : 'Where the item lands in the destination project.'}
                    </FormHint>
                </FormGroup>
            </ModalBody>

            <ModalFooter>
                <Button variant="ghost" onClick={closeTransfer} disabled={busy}>
                    Cancel
                </Button>
                <Button variant="secondary" onClick={() => runTransfer('copy')} disabled={busy || loadingFolders}>
                    Copy
                </Button>
                <Button variant="primary" onClick={() => runTransfer('move')} disabled={busy || loadingFolders}>
                    Move
                </Button>
            </ModalFooter>
        </Modal>
    );
};
