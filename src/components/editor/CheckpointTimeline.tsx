import { Button } from '../ui/Button';
import React, { useState, useEffect, useCallback, useRef } from 'react';
import { useProjectTabStore, useAppMetadataStore, useNotificationStore, useModalStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { listen } from '@tauri-apps/api/event';
import type { Checkpoint, CheckpointDiff, CheckpointProgress, CheckpointFileContent } from '../../lib/types';

function getFileName(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
}

function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

export const CheckpointTimeline: React.FC = () => {
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const showToast = useNotificationStore((s) => s.showToast);
    const setWorking = useAppMetadataStore((s) => s.setWorking);
    const setReady = useAppMetadataStore((s) => s.setReady);
    const openConfirmDialog = useModalStore((s) => s.openConfirmDialog);
    const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [message, setMessage] = useState('');
    const [search, setSearch] = useState('');
    const [filter, setFilter] = useState('all');
    const [page, setPage] = useState(0);
    const loadRequest = useRef(0);
    const previewRequest = useRef(0);
    const [selectedCheckpoint, setSelectedCheckpoint] = useState<string | null>(null);
    const [diff, setDiff] = useState<CheckpointDiff | null>(null);
    const [isComparing, setIsComparing] = useState(false);

    const [isCreating, setIsCreating] = useState(false);
    const [createProgress, setCreateProgress] = useState<CheckpointProgress | null>(null);

    const [previewFile, setPreviewFile] = useState<{ path: string; oldHash?: string; newHash?: string } | null>(null);
    const [previewOld, setPreviewOld] = useState<CheckpointFileContent | null>(null);
    const [previewNew, setPreviewNew] = useState<CheckpointFileContent | null>(null);
    const [isLoadingPreview, setIsLoadingPreview] = useState(false);

    const [diffCache, setDiffCache] = useState<Record<string, CheckpointDiff>>({});

    const activeTab = activeTabId
        ? openTabs.find(t => t.id === activeTabId)
        : null;
    const currentProjectPath = activeTab?.projectPath || null;

    useEffect(() => {
        let unlisten: (() => void) | null = null;
        let disposed = false;
        listen<CheckpointProgress>('checkpoint-progress', (event) => {
            setCreateProgress(event.payload);
        }).then(fn => { if (disposed) fn(); else unlisten = fn; });

        return () => { disposed = true; if (unlisten) unlisten(); };
    }, []);

    const loadCheckpoints = useCallback(async () => {
        const request = ++loadRequest.current;
        if (!currentProjectPath) { setIsLoading(false); return; }
        setIsLoading(true);
        try {
            // One IPC call returns the list + every adjacent diff. Diffs are
            // computed in parallel on the Rust side via rayon.
            const { checkpoints: list, diffs } = await api.listCheckpointsWithDiffs(currentProjectPath);
            if (request !== loadRequest.current) return;
            setCheckpoints(list);
            setDiffCache(diffs);
            setSelectedCheckpoint(selected => list.some(cp => cp.id === selected) ? selected : list[0]?.id ?? null);
        } catch (err) {
            console.error('Failed to load checkpoints:', err);
            showToast('error', 'Failed to load checkpoints');
        } finally {
            if (request === loadRequest.current) setIsLoading(false);
        }
    }, [currentProjectPath, showToast]);

    useEffect(() => {
        setSelectedCheckpoint(null);
        setCheckpoints([]);
        setPage(0);
        loadCheckpoints();
        return () => { loadRequest.current++; previewRequest.current++; };
    }, [loadCheckpoints]);

    useEffect(() => {
        previewRequest.current++;
        setPreviewFile(null);
        setIsComparing(false);
        if (!selectedCheckpoint || !currentProjectPath) {
            setDiff(null);
            setPreviewFile(null);
            return;
        }

        const idx = checkpoints.findIndex(c => c.id === selectedCheckpoint);
        if (idx === -1) return;

        // If it's the oldest checkpoint, show as "initial" (all files are added)
        if (idx === checkpoints.length - 1) {
            const cp = checkpoints[idx];
            const initialDiff: CheckpointDiff = {
                added: Object.values(cp.file_manifest),
                modified: [],
                deleted: [],
            };
            setDiff(initialDiff);
            return;
        }

        if (diffCache[selectedCheckpoint]) {
            setDiff(diffCache[selectedCheckpoint]);
            return;
        }

        const prevId = checkpoints[idx + 1].id;
        let cancelled = false;
        setIsComparing(true);
        api.compareCheckpoints(currentProjectPath, prevId, selectedCheckpoint)
            .then(d => {
                if (cancelled) return;
                setDiff(d);
                setDiffCache(prev => ({ ...prev, [selectedCheckpoint]: d }));
            })
            .catch(err => {
                if (cancelled) return;
                console.error('Failed to compare:', err);
                showToast('error', 'Failed to compute diff');
            })
            .finally(() => { if (!cancelled) setIsComparing(false); });
        return () => { cancelled = true; };
    }, [selectedCheckpoint, checkpoints, currentProjectPath, diffCache, showToast]);

    const handleCreateCheckpoint = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!currentProjectPath || !message.trim()) return;

        setIsCreating(true);
        setCreateProgress(null);
        try {
            const created = await api.createCheckpoint(currentProjectPath, message);
            setSelectedCheckpoint(created.id);
            setSearch('');
            setFilter('all');
            setPage(0);
            setMessage('');
            showToast('success', 'Checkpoint created');
            await loadCheckpoints();
        } catch (err) {
            console.error('Failed to create checkpoint:', err);
            showToast('error', 'Failed to create checkpoint');
        } finally {
            setIsCreating(false);
            setCreateProgress(null);
        }
    };

    const handleRestore = (id: string) => {
        if (!currentProjectPath) return;
        openConfirmDialog({
            title: 'Restore this checkpoint?',
            message: 'The project will be reverted to this state. An auto-backup of the current state is created first, so you can undo it.',
            confirmLabel: 'Restore',
            onConfirm: async () => {
                setWorking('Restoring checkpoint...');
                try {
                    await api.restoreCheckpoint(currentProjectPath, id);
                    showToast('success', 'Project restored successfully');
                    await loadCheckpoints();
                } catch (err) {
                    console.error('Failed to restore checkpoint:', err);
                    showToast('error', 'Failed to restore checkpoint');
                } finally {
                    setReady();
                }
            },
        });
    };

    const handleDelete = (id: string) => {
        if (!currentProjectPath) return;
        openConfirmDialog({
            title: 'Delete this checkpoint?',
            message: 'This checkpoint will be permanently removed. This cannot be undone.',
            confirmLabel: 'Delete',
            danger: true,
            onConfirm: async () => {
                try {
                    await api.deleteCheckpoint(currentProjectPath, id);
                    showToast('success', 'Checkpoint deleted');
                    await loadCheckpoints();
                    if (selectedCheckpoint === id) {
                        setSelectedCheckpoint(null);
                        setDiff(null);
                        setPreviewFile(null);
                    }
                } catch (err) {
                    console.error('Failed to delete checkpoint:', err);
                    showToast('error', 'Failed to delete checkpoint');
                }
            },
        });
    };

    const handleFileClick = async (filePath: string, oldHash?: string, newHash?: string) => {
        if (!currentProjectPath) return;
        const request = ++previewRequest.current;

        setPreviewFile({ path: filePath, oldHash, newHash });
        setPreviewOld(null);
        setPreviewNew(null);
        setIsLoadingPreview(true);

        try {
            const promises: Promise<void>[] = [];

            if (oldHash) {
                promises.push(
                    api.readCheckpointFile(currentProjectPath, oldHash, filePath)
                        .then(content => { if (request === previewRequest.current) setPreviewOld(content); })
                        .catch(() => { if (request === previewRequest.current) setPreviewOld(null); })
                );
            }
            if (newHash) {
                promises.push(
                    api.readCheckpointFile(currentProjectPath, newHash, filePath)
                        .then(content => { if (request === previewRequest.current) setPreviewNew(content); })
                        .catch(() => { if (request === previewRequest.current) setPreviewNew(null); })
                );
            }

            await Promise.all(promises);
        } finally {
            if (request === previewRequest.current) setIsLoadingPreview(false);
        }
    };

    if (isLoading) {
        return <div className="checkpoint-view__loading">Loading checkpoints...</div>;
    }

    const progressPercent = createProgress && createProgress.total > 0
        ? Math.round((createProgress.current / createProgress.total) * 100)
        : 0;

    const isAutomatic = (cp: Checkpoint) => cp.tags.some(tag => ['auto', 'auto-backup', 'paint', 'fix'].includes(tag)) || cp.message.startsWith('Auto-checkpoint:');
    const filtered = checkpoints.filter(cp =>
        (filter === 'all' || (filter === 'auto' ? isAutomatic(cp) : !isAutomatic(cp))) &&
        `${cp.message} ${cp.tags.join(' ')} ${new Date(cp.timestamp).toLocaleString()}`.toLowerCase().includes(search.toLowerCase())
    );
    const pageCount = Math.max(1, Math.ceil(filtered.length / 30));
    const currentPage = Math.min(page, pageCount - 1);
    const visible = filtered.slice(currentPage * 30, (currentPage + 1) * 30);
    const selected = checkpoints.find(cp => cp.id === selectedCheckpoint);

    return (
        <div className="checkpoint-view">
            <div className="checkpoint-view__header">
                <div className="checkpoint-view__title">
                    <span className="checkpoint-view__title-icon" dangerouslySetInnerHTML={{ __html: getIcon('history') }} />
                    <h2>Project History</h2>
                </div>
                <form className="checkpoint-view__create" onSubmit={handleCreateCheckpoint}>
                    <input
                        type="text"
                        aria-label="Checkpoint name"
                        placeholder="Describe this checkpoint…"
                        value={message}
                        onChange={e => setMessage(e.target.value)}
                        className="dl-input"
                        disabled={isCreating}
                    />
                    <Button type="submit" variant="primary" disabled={!message.trim() || isCreating}>
                        {isCreating ? 'Saving…' : 'Create Checkpoint'}
                    </Button>
                </form>
            </div>

            <div className="checkpoint-view__toolbar">
                <input className="dl-input" type="search" aria-label="Search checkpoints" placeholder="Search history…" value={search} onChange={e => { setSearch(e.target.value); setPage(0); }} />
                <select className="dl-input" aria-label="Checkpoint type" value={filter} onChange={e => { setFilter(e.target.value); setPage(0); }}>
                    <option value="all">All checkpoints</option>
                    <option value="manual">Manual</option>
                    <option value="auto">Automatic</option>
                </select>
                <span>{filtered.length} checkpoints</span>
                <Button variant="ghost" size="sm" disabled={currentPage === 0} onClick={() => setPage(currentPage - 1)}>Previous</Button>
                <span>{currentPage + 1} / {pageCount}</span>
                <Button variant="ghost" size="sm" disabled={currentPage + 1 >= pageCount} onClick={() => setPage(currentPage + 1)}>Next</Button>
            </div>
            <p className="checkpoint-view__hint">Paint saves share a restore point for 15 minutes. Exports and syncs do not create checkpoints.</p>
            {isCreating && createProgress && (
                <div className="checkpoint-progress">
                    <div className="checkpoint-progress__info">
                        <span>{createProgress.phase}</span>
                        {createProgress.total > 0 && (
                            <span>{createProgress.current}/{createProgress.total} files ({progressPercent}%)</span>
                        )}
                    </div>
                    <div className="checkpoint-progress__bar">
                        <div
                            className="checkpoint-progress__fill"
                            style={{ width: `${progressPercent}%` }}
                        />
                    </div>
                </div>
            )}

            <div className="checkpoint-view__content">
                <div className="checkpoint-view__list">
                    {visible.length === 0 ? (
                        <div className="checkpoint-view__empty">
                            {checkpoints.length === 0 ? 'No checkpoints yet. Save one to keep your progress.' : 'No matching checkpoints.'}
                        </div>
                    ) : (
                        visible.map(cp => {
                            const cpDiff = diffCache[cp.id];
                            const isInitial = cp.id === checkpoints[checkpoints.length - 1]?.id;
                            return (
                                <div
                                    key={cp.id}
                                    role="button"
                                    tabIndex={0}
                                    aria-pressed={selectedCheckpoint === cp.id}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter' || e.key === ' ') { e.preventDefault(); setSelectedCheckpoint(cp.id); }
                                        if (e.key === 'ArrowDown' || e.key === 'ArrowUp') {
                                            e.preventDefault();
                                            const next = e.key === 'ArrowDown' ? e.currentTarget.nextElementSibling : e.currentTarget.previousElementSibling;
                                            (next as HTMLElement | null)?.focus();
                                        }
                                    }}
                                    className={`checkpoint-item ${selectedCheckpoint === cp.id ? 'checkpoint-item--selected' : ''}`}
                                    onClick={() => setSelectedCheckpoint(
                                        selectedCheckpoint === cp.id ? null : cp.id
                                    )}
                                >
                                    <div className="checkpoint-item__marker" />
                                    <div className="checkpoint-item__content">
                                        <div className="checkpoint-item__header">
                                            <span className="checkpoint-item__message" title={cp.message}>{cp.message}</span>
                                            <span className="checkpoint-item__date">
                                                {new Date(cp.timestamp).toLocaleString()}
                                            </span>
                                        </div>

                                        {cp.tags.length > 0 && (
                                            <div className="checkpoint-item__tags">
                                                {cp.tags.map(tag => (
                                                    <span key={tag} className="checkpoint-tag">{tag}</span>
                                                ))}
                                            </div>
                                        )}

                                        <div className="checkpoint-item__summary">
                                            {isInitial ? (
                                                <span className="checkpoint-summary__initial">
                                                    Initial ({Object.keys(cp.file_manifest).length} files)
                                                </span>
                                            ) : cpDiff ? (
                                                <>
                                                    {cpDiff.added.length > 0 && (
                                                        <span className="diff-stat diff-stat--added diff-stat--sm">+{cpDiff.added.length}</span>
                                                    )}
                                                    {cpDiff.modified.length > 0 && (
                                                        <span className="diff-stat diff-stat--modified diff-stat--sm">~{cpDiff.modified.length}</span>
                                                    )}
                                                    {cpDiff.deleted.length > 0 && (
                                                        <span className="diff-stat diff-stat--deleted diff-stat--sm">-{cpDiff.deleted.length}</span>
                                                    )}
                                                    {cpDiff.added.length === 0 && cpDiff.modified.length === 0 && cpDiff.deleted.length === 0 && (
                                                        <span className="checkpoint-summary__no-changes">No changes</span>
                                                    )}
                                                </>
                                            ) : null}
                                        </div>

                                    </div>
                                </div>
                            );
                        })
                    )}
                </div>

                <div className="checkpoint-view__details">
                    {selected && <div className="checkpoint-view__selection">
                        <div><strong>{selected.message}</strong><small>{new Date(selected.timestamp).toLocaleString()}</small></div>
                        <Button variant="ghost" size="sm" onClick={() => handleRestore(selected.id)}>Restore</Button>
                        <Button variant="danger" size="sm" onClick={() => handleDelete(selected.id)}>Delete</Button>
                    </div>}
                    {selectedCheckpoint ? (
                        <div className="checkpoint-details">
                            {isComparing ? (
                                <div className="checkpoint-details__loading">Calculating differences...</div>
                            ) : diff ? (
                                <div className="checkpoint-diff">
                                    <div className="checkpoint-diff__header">
                                        <h3>Changed Files</h3>
                                        <div className="checkpoint-diff__stats">
                                            {diff.added.length > 0 && (
                                                <span className="diff-stat diff-stat--added">+{diff.added.length} added</span>
                                            )}
                                            {diff.modified.length > 0 && (
                                                <span className="diff-stat diff-stat--modified">~{diff.modified.length} modified</span>
                                            )}
                                            {diff.deleted.length > 0 && (
                                                <span className="diff-stat diff-stat--deleted">-{diff.deleted.length} deleted</span>
                                            )}
                                        </div>
                                    </div>
                                    <div className="checkpoint-diff__list">
                                        {diff.added.map(f => (
                                            <div
                                                key={f.path}
                                                className={`diff-file diff-file--added ${previewFile?.path === f.path ? 'diff-file--active' : ''}`}
                                                onClick={() => handleFileClick(f.path, undefined, f.hash)}
                                                title={f.path}
                                            >
                                                <span className="diff-file__badge diff-file__badge--added">A</span>
                                                <span className="diff-file__name">{getFileName(f.path)}</span>
                                                <span className="diff-file__path-hint">{f.path}</span>
                                                <span className="diff-file__size">{formatSize(f.size)}</span>
                                            </div>
                                        ))}
                                        {diff.modified.map(([old, curr]) => (
                                            <div
                                                key={curr.path}
                                                className={`diff-file diff-file--modified ${previewFile?.path === curr.path ? 'diff-file--active' : ''}`}
                                                onClick={() => handleFileClick(curr.path, old.hash, curr.hash)}
                                                title={curr.path}
                                            >
                                                <span className="diff-file__badge diff-file__badge--modified">M</span>
                                                <span className="diff-file__name">{getFileName(curr.path)}</span>
                                                <span className="diff-file__path-hint">{curr.path}</span>
                                                <span className="diff-file__size">{formatSize(curr.size)}</span>
                                            </div>
                                        ))}
                                        {diff.deleted.map(f => (
                                            <div
                                                key={f.path}
                                                className={`diff-file diff-file--deleted ${previewFile?.path === f.path ? 'diff-file--active' : ''}`}
                                                onClick={() => handleFileClick(f.path, f.hash, undefined)}
                                                title={f.path}
                                            >
                                                <span className="diff-file__badge diff-file__badge--deleted">D</span>
                                                <span className="diff-file__name">{getFileName(f.path)}</span>
                                                <span className="diff-file__path-hint">{f.path}</span>
                                                <span className="diff-file__size">{formatSize(f.size)}</span>
                                            </div>
                                        ))}
                                        {diff.added.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0 && (
                                            <div className="checkpoint-diff__empty">No file changes detected.</div>
                                        )}
                                    </div>

                                    {previewFile && (
                                        <div className="checkpoint-preview">
                                            <div className="checkpoint-preview__header">
                                                <h4>{getFileName(previewFile.path)}</h4>
                                                <Button
                                                    variant="ghost" size="sm" iconOnly
                                                    onClick={() => { setPreviewFile(null); setPreviewOld(null); setPreviewNew(null); }}
                                                    title="Close preview"
                                                >
                                                    <span dangerouslySetInnerHTML={{ __html: getIcon('close') }} />
                                                </Button>
                                            </div>
                                            {isLoadingPreview ? (
                                                <div className="checkpoint-preview__loading">Loading preview...</div>
                                            ) : (
                                                <div className="checkpoint-preview__compare">
                                                    {previewFile.oldHash && (
                                                        <div className="checkpoint-preview__side">
                                                            <div className="checkpoint-preview__label checkpoint-preview__label--old">Before</div>
                                                            <PreviewContent content={previewOld} />
                                                        </div>
                                                    )}
                                                    {previewFile.newHash && (
                                                        <div className="checkpoint-preview__side">
                                                            <div className="checkpoint-preview__label checkpoint-preview__label--new">After</div>
                                                            <PreviewContent content={previewNew} />
                                                        </div>
                                                    )}
                                                </div>
                                            )}
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="checkpoint-details__info">
                                    <p className="text-muted italic">Loading changes...</p>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="checkpoint-view__placeholder">
                            Select a checkpoint to view changes.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};

const PreviewContent: React.FC<{ content: CheckpointFileContent | null }> = ({ content }) => {
    if (!content) {
        return <div className="checkpoint-preview__empty">Not available</div>;
    }

    switch (content.type) {
        case 'image':
            return (
                <div className="checkpoint-preview__image">
                    <img
                        src={content.data.startsWith('data:') ? content.data : `data:image/png;base64,${content.data}`}
                        alt="Preview"
                    />
                    {content.width > 0 && (
                        <span className="checkpoint-preview__dimensions">{content.width}x{content.height}</span>
                    )}
                </div>
            );
        case 'text':
            return (
                <pre className="checkpoint-preview__text">{content.data}</pre>
            );
        case 'binary':
            return (
                <div className="checkpoint-preview__binary">
                    Binary file ({formatSize(content.size)})
                </div>
            );
    }
};
