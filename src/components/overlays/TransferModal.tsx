/**
 * TransferModal
 * Opened when the user drags a file/folder from one project's tree and drops it
 * into another project (onto a folder, after spring-loading in). The destination
 * is already decided by where they dropped — this dialog only asks Move or Copy.
 *
 * Styled with the design-lab system (`.dl-*` in styles/design-lab.css), rendered
 * through a portal like the lab's own modals.
 */

import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { useTransferStore, useProjectTabStore, useNotificationStore } from '../../lib/stores';
import * as api from '../../lib/api';

export const TransferModal: React.FC = () => {
    const pending = useTransferStore((s) => s.pending);
    const closeTransfer = useTransferStore((s) => s.closeTransfer);
    const showToast = useNotificationStore((s) => s.showToast);

    const [runningOp, setRunningOp] = useState<'copy' | 'move' | null>(null);
    const busy = runningOp !== null;

    // Esc closes (unless mid-transfer).
    useEffect(() => {
        if (!pending) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) closeTransfer(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [pending, busy, closeTransfer]);

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
        if (!pending || busy) return;
        const sourceName = pending.payload.name;
        setRunningOp(op);
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
            setRunningOp(null);
        }
    };

    if (!pending) return null;

    const kind = pending.payload.isDirectory ? 'folder' : 'file';
    const destLabel = `${pending.destProjectName}${pending.destFolder && pending.destFolder !== '.' ? ` / ${pending.destFolder}` : ''}`;

    return createPortal(
        <div
            className="dl-modal-backdrop"
            onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) closeTransfer(); }}
        >
            <div className="dl-modal" role="dialog" aria-modal="true" style={{ maxWidth: 440 }}>
                <div className="dl-modal__head">
                    <h3 className="dl-modal__title">Move or copy?</h3>
                </div>

                <div className="dl-modal__body">
                    <p style={{ margin: 0, fontSize: 14, lineHeight: 1.6 }}>
                        You want to move this {kind}{' '}
                        <strong style={{ color: 'var(--accent-primary)' }}>{pending.payload.name}</strong>
                        {' '}to{' '}
                        <strong style={{ color: 'var(--danger)' }}>{destLabel}</strong>?
                    </p>
                </div>

                <div className="dl-modal__foot" style={{ justifyContent: 'space-between' }}>
                    <button className="dl-btn dl-btn--ghost" onClick={closeTransfer} disabled={busy}>
                        Cancel
                    </button>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button
                            className={`dl-btn dl-btn--primary${runningOp === 'move' ? ' dl-btn--loading' : ''}`}
                            onClick={() => runTransfer('move')}
                            disabled={busy}
                        >
                            Move
                        </button>
                        <button
                            className={`dl-btn dl-btn--secondary${runningOp === 'copy' ? ' dl-btn--loading' : ''}`}
                            onClick={() => runTransfer('copy')}
                            disabled={busy}
                        >
                            Copy
                        </button>
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
};
