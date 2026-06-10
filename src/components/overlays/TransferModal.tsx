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
import { getFileIcon, getIcon } from '../../lib/ui-helpers/fileIcons';
import * as api from '../../lib/api';

/** Prettify a project-relative folder path for display: drop the noise segments
 *  (`content`, `base`, and the `*.wad.client` container) so only the meaningful
 *  folders show. Display-only — the real path is still used for the transfer. */
function cleanFolderForDisplay(folder: string): string {
    if (!folder || folder === '.') return 'Project root';
    const segs = folder.split('/').filter(Boolean).filter((s) => {
        const low = s.toLowerCase();
        return low !== 'content' && low !== 'base' && !low.endsWith('.wad.client');
    });
    return segs.join('/') || 'Project root';
}

const cardStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 12,
    padding: '12px 14px',
    background: 'var(--bg-tertiary)',
    border: '1px solid var(--border)',
    borderRadius: 'var(--dl-radius, 10px)',
    minWidth: 0,
};
const iconBoxStyle: React.CSSProperties = {
    width: 34,
    height: 34,
    flex: 'none',
    display: 'flex',
    alignItems: 'center',
    justifyContent: 'center',
    borderRadius: 8,
    background: 'color-mix(in oklab, var(--bg-secondary) 70%, transparent)',
    border: '1px solid var(--border)',
};
const labelStyle: React.CSSProperties = {
    fontSize: 10.5,
    fontWeight: 600,
    letterSpacing: '.05em',
    textTransform: 'uppercase',
    color: 'var(--text-muted)',
    marginBottom: 2,
};
const valueStyle: React.CSSProperties = {
    fontSize: 14,
    fontWeight: 600,
    whiteSpace: 'nowrap',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
};

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

    const isDir = pending.payload.isDirectory;
    const folderText = cleanFolderForDisplay(pending.destFolder);

    return createPortal(
        <div
            className="dl-modal-backdrop"
            onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) closeTransfer(); }}
        >
            <div className="dl-modal" role="dialog" aria-modal="true" style={{ maxWidth: 430 }}>
                <div className="dl-modal__head">
                    <h3 className="dl-modal__title">Move or copy {isDir ? 'folder' : 'file'}?</h3>
                </div>

                <div className="dl-modal__body" style={{ gap: 4 }}>
                    {/* The item being transferred */}
                    <div style={cardStyle}>
                        <span
                            style={iconBoxStyle}
                            dangerouslySetInnerHTML={{ __html: getFileIcon(pending.payload.name, isDir, false) }}
                        />
                        <div style={{ minWidth: 0 }}>
                            <div style={labelStyle}>{isDir ? 'Folder' : 'File'}</div>
                            <div style={valueStyle} title={pending.payload.name}>{pending.payload.name}</div>
                        </div>
                    </div>

                    {/* Connector — neutral down arrow (works for both move and copy) */}
                    <div style={{
                        display: 'flex', alignItems: 'center', justifyContent: 'center',
                        color: 'var(--text-muted)', padding: '2px 0',
                    }}>
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                            <path d="M12 5v14M6 13l6 6 6-6" stroke="currentColor" strokeWidth="2"
                                strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </div>

                    {/* Destination */}
                    <div style={{ ...cardStyle, borderColor: 'color-mix(in oklab, var(--danger) 45%, var(--border))' }}>
                        <span style={iconBoxStyle} dangerouslySetInnerHTML={{ __html: getIcon('folder') }} />
                        <div style={{ minWidth: 0 }}>
                            <div style={labelStyle}>Destination · {pending.destProjectName}</div>
                            <div style={{ ...valueStyle, color: 'var(--danger)' }} title={folderText}>{folderText}</div>
                        </div>
                    </div>
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
