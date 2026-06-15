import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { useModalStore, useNotificationStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { Button, Input, Modal, ModalBody, ModalFooter, ModalHeader } from '../ui';

interface BinSplitSingleOptions {
    mode?: 'single';
    binPath: string;
    defaultOutputName: string;
}

interface BinSplitFolderOptions {
    mode: 'folder';
    folderPath: string;
    defaultOutputName: string;
}

type BinSplitOptions = BinSplitSingleOptions | BinSplitFolderOptions;

export const BinSplitModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const showToast = useNotificationStore((s) => s.showToast);
    const isVisible = activeModal === 'binSplit';
    const options = modalOptions as BinSplitOptions | null;

    const isFolderMode = options?.mode === 'folder';

    const [analysis, setAnalysis] = useState<api.BinSplitAnalysis | null>(null);
    const [folderAnalysis, setFolderAnalysis] = useState<api.BinSplitFolderAnalysis | null>(null);
    const [loading, setLoading] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const [outputName, setOutputName] = useState('');
    /** Set of class hashes whose group is checked for moving. */
    const [checkedClasses, setCheckedClasses] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!isVisible || !options) {
            setAnalysis(null);
            setFolderAnalysis(null);
            setError(null);
            setCheckedClasses(new Set());
            return;
        }

        setOutputName(options.defaultOutputName);
        setLoading(true);
        setError(null);
        setAnalysis(null);
        setFolderAnalysis(null);

        let cancelled = false;
        const promise = options.mode === 'folder'
            ? api.analyzeFolderForSplit(options.folderPath).then((res) => {
                if (cancelled) return;
                setFolderAnalysis(res);
                const initial = new Set<string>();
                for (const g of res.groups) {
                    if (g.is_vfx_default) initial.add(g.class_hash);
                }
                setCheckedClasses(initial);
            })
            : api.analyzeBinForSplit(options.binPath).then((res) => {
                if (cancelled) return;
                setAnalysis(res);
                const initial = new Set<string>();
                for (const g of res.groups) {
                    if (g.is_vfx_default) initial.add(g.class_hash);
                }
                setCheckedClasses(initial);
            });

        promise
            .catch((e) => {
                if (cancelled) return;
                const msg = (e as { message?: string })?.message ?? String(e);
                setError(msg);
                showToast('error', `BIN analysis failed: ${msg}`);
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVisible, options]);

    const groups = analysis?.groups ?? folderAnalysis?.groups ?? null;
    const totalObjects = analysis?.total_objects ?? folderAnalysis?.total_objects ?? 0;

    const moveCount = useMemo(() => {
        if (!groups) return 0;
        let n = 0;
        for (const g of groups) {
            if (checkedClasses.has(g.class_hash)) n += g.path_hashes.length;
        }
        return n;
    }, [groups, checkedClasses]);

    const toggleClass = useCallback((classHash: string) => {
        setCheckedClasses((prev) => {
            const next = new Set(prev);
            if (next.has(classHash)) next.delete(classHash);
            else next.add(classHash);
            return next;
        });
    }, []);

    const selectAll = useCallback(() => {
        if (!groups) return;
        setCheckedClasses(new Set(groups.map((g) => g.class_hash)));
    }, [groups]);

    const selectNone = useCallback(() => {
        setCheckedClasses(new Set());
    }, []);

    const selectVfxDefault = useCallback(() => {
        if (!groups) return;
        setCheckedClasses(
            new Set(groups.filter((g) => g.is_vfx_default).map((g) => g.class_hash)),
        );
    }, [groups]);

    const handleSplit = useCallback(async () => {
        if (!groups || !options || moveCount === 0 || busy) return;

        const trimmed = outputName.trim();
        if (!trimmed) {
            showToast('error', 'Output filename is required');
            return;
        }
        if (!trimmed.toLowerCase().endsWith('.bin')) {
            showToast('error', 'Output filename must end with .bin');
            return;
        }
        if (trimmed.includes('/') || trimmed.includes('\\')) {
            showToast('error', 'Output filename cannot contain path separators');
            return;
        }

        const hashes: string[] = [];
        for (const g of groups) {
            if (checkedClasses.has(g.class_hash)) hashes.push(...g.path_hashes);
        }

        setBusy(true);
        try {
            let result;
            if (options.mode === 'folder' && folderAnalysis) {
                if (!folderAnalysis.suggested_owner) {
                    showToast('error', 'Could not find a main skin BIN in this folder to own the new link');
                    return;
                }
                result = await api.splitFolderEntries(
                    options.folderPath,
                    folderAnalysis.sources.map((s) => s.path),
                    folderAnalysis.suggested_owner,
                    trimmed,
                    hashes,
                );
            } else if (options.mode !== 'folder') {
                result = await api.splitBinEntries(options.binPath, trimmed, hashes);
            } else {
                showToast('error', 'Folder analysis missing — cannot split');
                return;
            }
            showToast(
                'success',
                `Moved ${result.moved} object${result.moved === 1 ? '' : 's'} to ${trimmed}`,
            );
            closeModal();
        } catch (e) {
            const msg = (e as { message?: string })?.message ?? String(e);
            showToast('error', `Split failed: ${msg}`);
        } finally {
            setBusy(false);
        }
    }, [groups, options, outputName, checkedClasses, moveCount, busy, folderAnalysis, showToast, closeModal]);

    const totalRemainingInParent = totalObjects - moveCount;

    return (
        <Modal
            open={isVisible}
            onClose={busy ? undefined : closeModal}
            size="large"
            modifier="modal--bin-split"
        >
                <ModalHeader
                    title={isFolderMode ? 'Split BINs in Folder' : 'Split BIN by Class'}
                    onClose={busy ? undefined : closeModal}
                />

                <ModalBody style={{ overflow: 'auto', flex: 1 }}>
                    {loading && <div className="modal__empty">{isFolderMode ? 'Scanning folder…' : 'Reading BIN…'}</div>}
                    {error && <div className="modal__empty" style={{ color: 'var(--accent-danger)' }}>Error: {error}</div>}

                    {groups && !loading && !error && (
                        <>
                            <div style={{ marginBottom: '12px', fontSize: '13px', color: 'var(--text-muted)', lineHeight: 1.5, wordBreak: 'break-word' }}>
                                <div>{totalObjects} objects total</div>
                                <div>{moveCount} selected to move · {totalRemainingInParent} will stay in source</div>
                            </div>

                            {folderAnalysis && (
                                <div style={{ marginBottom: '16px', fontSize: '12px', color: 'var(--text-muted)' }}>
                                    <div style={{ marginBottom: '4px' }}>
                                        Sources ({folderAnalysis.sources.length}):
                                    </div>
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: '2px', paddingLeft: '8px', maxHeight: '120px', overflow: 'auto' }}>
                                        {folderAnalysis.sources.map((s) => (
                                            <div key={s.path} style={{ display: 'flex', justifyContent: 'space-between', gap: '12px', fontFamily: 'monospace', fontSize: '11px', minWidth: 0 }}>
                                                <span style={{ overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', minWidth: 0, flex: 1 }} title={s.rel_path}>
                                                    {s.path === folderAnalysis.suggested_owner ? '★ ' : '  '}
                                                    {s.rel_path}
                                                </span>
                                                <span style={{ flexShrink: 0 }}>×{s.object_count}</span>
                                            </div>
                                        ))}
                                    </div>
                                    {folderAnalysis.suggested_owner && (
                                        <div style={{ marginTop: '6px' }}>
                                            ★ owner BIN — gets the new link added to its dependencies
                                        </div>
                                    )}
                                </div>
                            )}

                            <div style={{ display: 'flex', gap: '12px', marginBottom: '12px', flexWrap: 'wrap', alignItems: 'center', paddingLeft: '4px' }}>
                                <span
                                    onClick={busy ? undefined : selectVfxDefault}
                                    style={{
                                        fontSize: '13px',
                                        fontWeight: 500,
                                        color: 'var(--accent-primary)',
                                        cursor: busy ? 'not-allowed' : 'pointer',
                                        userSelect: 'none',
                                        whiteSpace: 'nowrap',
                                        marginRight: '8px',
                                        marginLeft: '8px',
                                    }}
                                >
                                    VFX preset
                                </span>
                                <Button
                                    variant="ghost"
                                    onClick={selectAll}
                                    style={{ padding: '8px 16px', fontSize: 13, whiteSpace: 'nowrap', flex: '0 0 auto' }}
                                >
                                    All
                                </Button>
                                <Button
                                    variant="ghost"
                                    onClick={selectNone}
                                    style={{ padding: '8px 16px', fontSize: 13, whiteSpace: 'nowrap', flex: '0 0 auto' }}
                                >
                                    None
                                </Button>
                            </div>

                            <div style={{ display: 'flex', flexDirection: 'column', gap: '6px' }}>
                                {groups.map((g) => {
                                    const checked = checkedClasses.has(g.class_hash);
                                    const label = g.class_name ?? `0x${g.class_hash}`;
                                    return (
                                        <div
                                            key={g.class_hash}
                                            role="button"
                                            tabIndex={0}
                                            aria-pressed={checked}
                                            onClick={() => !busy && toggleClass(g.class_hash)}
                                            onKeyDown={(e) => {
                                                if (busy) return;
                                                if (e.key === ' ' || e.key === 'Enter') {
                                                    e.preventDefault();
                                                    toggleClass(g.class_hash);
                                                }
                                            }}
                                            style={{
                                                display: 'flex',
                                                alignItems: 'center',
                                                gap: '10px',
                                                padding: '10px 14px',
                                                borderRadius: '6px',
                                                cursor: busy ? 'not-allowed' : 'pointer',
                                                userSelect: 'none',
                                                border: `1px solid ${checked ? 'var(--accent-primary)' : 'var(--border)'}`,
                                                background: checked ? 'color-mix(in srgb, var(--accent-primary) 15%, transparent)' : 'var(--bg-elevated)',
                                                opacity: busy ? 0.6 : 1,
                                                transition: 'background 0.12s ease, border-color 0.12s ease',
                                            }}
                                        >
                                            <span style={{ fontSize: '13px', flex: 1, minWidth: 0, fontFamily: g.class_name ? 'inherit' : 'monospace', overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap', color: checked ? 'var(--text-primary)' : 'var(--text-secondary, var(--text-primary))' }} title={label}>
                                                {label}
                                                {g.is_vfx_default && (
                                                    <span style={{ marginLeft: '8px', fontSize: '10px', color: 'var(--text-muted)', textTransform: 'uppercase', letterSpacing: '0.06em' }}>
                                                        VFX
                                                    </span>
                                                )}
                                            </span>
                                            <span style={{ fontSize: '11px', color: 'var(--text-muted)', minWidth: '48px', textAlign: 'right', flexShrink: 0 }}>
                                                ×{g.path_hashes.length}
                                            </span>
                                        </div>
                                    );
                                })}
                            </div>
                        </>
                    )}
                </ModalBody>

                <ModalFooter stacked>
                    <div style={{ display: 'flex', gap: 8, alignItems: 'center', width: '100%' }}>
                        <label style={{ fontSize: 12, color: 'var(--text-muted)', flexShrink: 0 }}>
                            Output file:
                        </label>
                        <Input
                            value={outputName}
                            onChange={(e) => setOutputName(e.target.value)}
                            disabled={busy}
                            style={{ flex: 1, fontFamily: 'monospace' }}
                        />
                    </div>
                    <div style={{ display: 'flex', gap: 8, justifyContent: 'flex-end', width: '100%' }}>
                        <Button variant="ghost" onClick={closeModal} disabled={busy}>
                            Cancel
                        </Button>
                        <Button
                            variant="primary"
                            onClick={handleSplit}
                            disabled={busy || moveCount === 0 || !groups}
                        >
                            {busy ? 'Splitting…' : `Split ${moveCount} object${moveCount === 1 ? '' : 's'}`}
                        </Button>
                    </div>
                </ModalFooter>
        </Modal>
    );
};
