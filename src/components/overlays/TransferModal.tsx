/**
 * TransferModal
 * Opened when the user drags file-tree item(s) from one project and drops them
 * into another. The destination is already decided by where they dropped — this
 * dialog asks Move or Copy, and (Windows-style) on a name clash asks Replace or
 * Keep both. Styled with the design-lab system, rendered through a portal.
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
    display: 'flex', alignItems: 'center', gap: 12, padding: '12px 14px',
    background: 'var(--bg-tertiary)', border: '1px solid var(--border)',
    borderRadius: 'var(--dl-radius, 10px)', minWidth: 0,
};
const iconBoxStyle: React.CSSProperties = {
    width: 34, height: 34, flex: 'none', display: 'flex', alignItems: 'center',
    justifyContent: 'center', borderRadius: 8,
    background: 'color-mix(in oklab, var(--bg-secondary) 70%, transparent)',
    border: '1px solid var(--border)',
};
const labelStyle: React.CSSProperties = {
    fontSize: 10.5, fontWeight: 600, letterSpacing: '.05em',
    textTransform: 'uppercase', color: 'var(--text-muted)', marginBottom: 2,
};
const valueStyle: React.CSSProperties = {
    fontSize: 14, fontWeight: 600, whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis',
};

/** Design-lab modal shell. Module-scoped so it isn't remounted (which would
 *  replay the open animation) on every parent render. */
const Shell: React.FC<{ title: string; busy: boolean; onClose: () => void; children: React.ReactNode; foot: React.ReactNode }> = ({ title, busy, onClose, children, foot }) => (
    <div className="dl-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) onClose(); }}>
        <div className="dl-modal" role="dialog" aria-modal="true" style={{ maxWidth: 440 }}>
            <div className="dl-modal__head"><h3 className="dl-modal__title">{title}</h3></div>
            <div className="dl-modal__body" style={{ gap: 8 }}>{children}</div>
            <div className="dl-modal__foot" style={{ justifyContent: 'space-between' }}>{foot}</div>
        </div>
    </div>
);

export const TransferModal: React.FC = () => {
    const pending = useTransferStore((s) => s.pending);
    const closeTransfer = useTransferStore((s) => s.closeTransfer);
    const showToast = useNotificationStore((s) => s.showToast);

    const [runningOp, setRunningOp] = useState<'copy' | 'move' | null>(null);
    const [conflict, setConflict] = useState<{ op: 'copy' | 'move'; names: string[] } | null>(null);
    const busy = runningOp !== null;

    useEffect(() => {
        if (!pending) return;
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) closeTransfer(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [pending, busy, closeTransfer]);

    const refreshProjectTree = async (projectPath: string) => {
        const tab = useProjectTabStore.getState().openTabs.find((t) => t.projectPath === projectPath);
        if (!tab) return;
        try {
            const files = await api.listProjectFiles(projectPath);
            useProjectTabStore.getState().setFileTree(tab.id, files);
        } catch { /* watcher will catch up */ }
    };

    /** Run the actual transfer with the chosen conflict policy. */
    const execute = async (op: 'copy' | 'move', policy: api.TransferConflictPolicy) => {
        if (!pending) return;
        setConflict(null);
        setRunningOp(op);
        try {
            const { payload, destProjectPath, destFolder } = pending;
            const relPaths = payload.items.map((i) => i.relPath);
            const fn = op === 'copy' ? api.copyBetweenProjects : api.moveBetweenProjects;
            const created = await fn(payload.projectPath, relPaths, destProjectPath, destFolder, policy);
            await refreshProjectTree(destProjectPath);
            if (op === 'move') await refreshProjectTree(payload.projectPath);
            showToast('success', `${op === 'copy' ? 'Copied' : 'Moved'} ${created.length} item${created.length === 1 ? '' : 's'} to ${pending.destProjectName}`);
            closeTransfer();
        } catch (err) {
            const flintError = err as api.FlintError;
            showToast('error', flintError.getUserMessage?.() || `Failed to ${op}`);
        } finally {
            setRunningOp(null);
        }
    };

    /** Move/Copy clicked — check for name clashes first; ask if any. */
    const start = async (op: 'copy' | 'move') => {
        if (!pending || busy) return;
        setRunningOp(op);
        try {
            const relPaths = pending.payload.items.map((i) => i.relPath);
            const names = await api.checkTransferConflicts(relPaths, pending.destProjectPath, pending.destFolder);
            setRunningOp(null);
            if (names.length > 0) setConflict({ op, names });
            else await execute(op, 'rename');
        } catch {
            setRunningOp(null);
            await execute(op, 'rename');
        }
    };

    if (!pending) return null;

    const items = pending.payload.items;
    const single = items.length === 1 ? items[0] : null;
    const sourceName = single ? single.name : `${items.length} items`;
    const sourceLabel = single ? (single.isDirectory ? 'Folder' : 'File') : `${items.length} items`;
    const folderText = cleanFolderForDisplay(pending.destFolder);

    // ── Conflict prompt (Replace / Keep both) ───────────────────────────────
    if (conflict) {
        const n = conflict.names.length;
        return createPortal(
            <Shell
                busy={busy}
                onClose={closeTransfer}
                title={`${n} item${n === 1 ? '' : 's'} already exist${n === 1 ? 's' : ''}`}
                foot={
                    <>
                        <button className="dl-btn dl-btn--ghost" onClick={() => setConflict(null)} disabled={busy}>Cancel</button>
                        <div style={{ display: 'flex', gap: 8 }}>
                            <button className="dl-btn dl-btn--secondary" onClick={() => execute(conflict.op, 'rename')} disabled={busy}>Keep both</button>
                            <button className={`dl-btn dl-btn--danger${busy ? ' dl-btn--loading' : ''}`} onClick={() => execute(conflict.op, 'replace')} disabled={busy}>Replace</button>
                        </div>
                    </>
                }
            >
                <p style={{ margin: 0, fontSize: 14, lineHeight: 1.5 }}>
                    Already in <strong style={{ color: 'var(--text-primary)' }}>{pending.destProjectName} / {folderText}</strong>:
                </p>
                <div style={{ ...cardStyle, alignItems: 'flex-start', maxHeight: 140, overflow: 'auto', display: 'block' }}>
                    {conflict.names.map((nm) => (
                        <div key={nm} style={{ ...valueStyle, fontWeight: 500, color: 'var(--danger)' }} title={nm}>{nm}</div>
                    ))}
                </div>
                <p style={{ margin: 0, fontSize: 12, color: 'var(--text-muted)' }}>
                    <strong>Replace</strong> overwrites them. <strong>Keep both</strong> adds a “(2)” suffix.
                </p>
            </Shell>,
            document.body,
        );
    }

    // ── Move / Copy prompt ───────────────────────────────────────────────────
    return createPortal(
        <Shell
            busy={busy}
            onClose={closeTransfer}
            title={`Move or copy ${single ? (single.isDirectory ? 'folder' : 'file') : `${items.length} items`}?`}
            foot={
                <>
                    <button className="dl-btn dl-btn--ghost" onClick={closeTransfer} disabled={busy}>Cancel</button>
                    <div style={{ display: 'flex', gap: 8 }}>
                        <button className={`dl-btn dl-btn--primary${runningOp === 'move' ? ' dl-btn--loading' : ''}`} onClick={() => start('move')} disabled={busy}>Move</button>
                        <button className={`dl-btn dl-btn--secondary${runningOp === 'copy' ? ' dl-btn--loading' : ''}`} onClick={() => start('copy')} disabled={busy}>Copy</button>
                    </div>
                </>
            }
        >
            <div style={cardStyle}>
                <span style={iconBoxStyle} dangerouslySetInnerHTML={{ __html: single ? getFileIcon(single.name, single.isDirectory, false) : getIcon('copy') }} />
                <div style={{ minWidth: 0 }}>
                    <div style={labelStyle}>{sourceLabel}</div>
                    <div style={valueStyle} title={sourceName}>{sourceName}</div>
                </div>
            </div>

            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'center', color: 'var(--text-muted)', padding: '2px 0' }}>
                <svg width="18" height="18" viewBox="0 0 24 24" fill="none" aria-hidden>
                    <path d="M12 5v14M6 13l6 6 6-6" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
                </svg>
            </div>

            <div style={{ ...cardStyle, borderColor: 'color-mix(in oklab, var(--danger) 45%, var(--border))' }}>
                <span style={iconBoxStyle} dangerouslySetInnerHTML={{ __html: getIcon('folder') }} />
                <div style={{ minWidth: 0 }}>
                    <div style={labelStyle}>Destination · {pending.destProjectName}</div>
                    <div style={{ ...valueStyle, color: 'var(--danger)' }} title={folderText}>{folderText}</div>
                </div>
            </div>
        </Shell>,
        document.body,
    );
};
