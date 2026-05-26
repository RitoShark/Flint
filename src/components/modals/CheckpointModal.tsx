/**
 * Flint - Checkpoint Modal Component
 * Project history and version control for modders
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useModalStore, useNotificationStore, useAppMetadataStore, useProjectTabStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { Button, Icon, Input, Modal, ModalBody, ModalHeader, ProgressBar, Spinner } from '../ui';
import { listen } from '@tauri-apps/api/event';
import type { Checkpoint, CheckpointDiff, CheckpointProgress, CheckpointFileContent } from '../../lib/types';

/** Helper to extract just the filename from a path */
function getFileName(path: string): string {
    const parts = path.split('/');
    return parts[parts.length - 1] || path;
}

/** Format file size in human-readable form */
function formatSize(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    if (bytes < 1024 * 1024) return `${(bytes / 1024).toFixed(1)} KB`;
    return `${(bytes / (1024 * 1024)).toFixed(1)} MB`;
}

/** Format relative time */
function formatRelativeTime(timestamp: string): string {
    const now = new Date();
    const then = new Date(timestamp);
    const diffMs = now.getTime() - then.getTime();
    const diffMins = Math.floor(diffMs / 60000);
    const diffHours = Math.floor(diffMs / 3600000);
    const diffDays = Math.floor(diffMs / 86400000);

    if (diffMins < 1) return 'Just now';
    if (diffMins < 60) return `${diffMins}m ago`;
    if (diffHours < 24) return `${diffHours}h ago`;
    if (diffDays < 7) return `${diffDays}d ago`;
    return then.toLocaleDateString();
}

export const CheckpointModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const setWorking = useAppMetadataStore((s) => s.setWorking);
    const setReady = useAppMetadataStore((s) => s.setReady);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [message, setMessage] = useState('');
    const [selectedCheckpoint, setSelectedCheckpoint] = useState<string | null>(null);
    const [diff, setDiff] = useState<CheckpointDiff | null>(null);
    const [isComparing, setIsComparing] = useState(false);

    // Creation progress
    const [isCreating, setIsCreating] = useState(false);
    const [createProgress, setCreateProgress] = useState<CheckpointProgress | null>(null);

    // File preview comparison
    const [previewFile, setPreviewFile] = useState<{ path: string; oldHash?: string; newHash?: string } | null>(null);
    const [previewOld, setPreviewOld] = useState<CheckpointFileContent | null>(null);
    const [previewNew, setPreviewNew] = useState<CheckpointFileContent | null>(null);
    const [isLoadingPreview, setIsLoadingPreview] = useState(false);

    // Cache diffs per checkpoint ID
    const [diffCache, setDiffCache] = useState<Record<string, CheckpointDiff>>({});

    const isVisible = activeModal === 'checkpoint';

    const activeTab = activeTabId
        ? openTabs.find(t => t.id === activeTabId)
        : null;
    const currentProjectPath = activeTab?.projectPath || null;

    // Listen for checkpoint progress events
    useEffect(() => {
        let unlisten: (() => void) | null = null;
        listen<CheckpointProgress>('checkpoint-progress', (event) => {
            setCreateProgress(event.payload);
        }).then(fn => { unlisten = fn; });

        return () => { if (unlisten) unlisten(); };
    }, []);

    const loadCheckpoints = useCallback(async () => {
        if (!currentProjectPath) return;
        setIsLoading(true);
        try {
            const list = await api.listCheckpoints(currentProjectPath);
            setCheckpoints(list);
            // Diffs are now computed lazily when a checkpoint is selected (see auto-diff effect below)
            // This makes the modal open instantly instead of blocking for potentially minutes
        } catch (err) {
            console.error('Failed to load checkpoints:', err);
            showToast('error', 'Failed to load checkpoints');
        } finally {
            setIsLoading(false);
        }
    }, [currentProjectPath, showToast]);

    useEffect(() => {
        if (isVisible) {
            loadCheckpoints();
        }
    }, [isVisible, loadCheckpoints]);

    // Auto-diff when a checkpoint is selected
    useEffect(() => {
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

        // Use cached diff if available
        if (diffCache[selectedCheckpoint]) {
            setDiff(diffCache[selectedCheckpoint]);
            return;
        }

        // Compute diff from previous checkpoint
        const prevId = checkpoints[idx + 1].id;
        setIsComparing(true);
        api.compareCheckpoints(currentProjectPath, prevId, selectedCheckpoint)
            .then(d => {
                setDiff(d);
                setDiffCache(prev => ({ ...prev, [selectedCheckpoint]: d }));
            })
            .catch(err => {
                console.error('Failed to compare:', err);
                showToast('error', 'Failed to compute diff');
            })
            .finally(() => setIsComparing(false));
    }, [selectedCheckpoint, checkpoints, currentProjectPath, diffCache, showToast]);

    const handleCreateCheckpoint = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!currentProjectPath || !message.trim()) return;

        setIsCreating(true);
        setCreateProgress(null);
        try {
            await api.createCheckpoint(currentProjectPath, message);
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

    const handleRestore = async (id: string) => {
        if (!currentProjectPath) return;
        if (!window.confirm('Restore this checkpoint? An auto-backup of the current state will be created first.')) return;

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
    };

    const handleDelete = async (id: string) => {
        if (!currentProjectPath) return;
        if (!window.confirm('Delete this checkpoint? This cannot be undone.')) return;

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
    };

    // Load file preview for comparison
    const handleFileClick = async (filePath: string, oldHash?: string, newHash?: string) => {
        if (!currentProjectPath) return;

        setPreviewFile({ path: filePath, oldHash, newHash });
        setPreviewOld(null);
        setPreviewNew(null);
        setIsLoadingPreview(true);

        try {
            const promises: Promise<void>[] = [];

            if (oldHash) {
                promises.push(
                    api.readCheckpointFile(currentProjectPath, oldHash, filePath)
                        .then(content => setPreviewOld(content))
                        .catch(() => setPreviewOld(null))
                );
            }
            if (newHash) {
                promises.push(
                    api.readCheckpointFile(currentProjectPath, newHash, filePath)
                        .then(content => setPreviewNew(content))
                        .catch(() => setPreviewNew(null))
                );
            }

            await Promise.all(promises);
        } finally {
            setIsLoadingPreview(false);
        }
    };

    const progressPercent = createProgress && createProgress.total > 0
        ? Math.round((createProgress.current / createProgress.total) * 100)
        : 0;

    return (
        <Modal open={isVisible} onClose={closeModal} size="large" modifier="checkpoint-modal">
                <ModalHeader
                    title={<><Icon name="history" /> Project Timeline</>}
                    onClose={closeModal}
                />

                <ModalBody className="checkpoint-modal__body">
                    {/* Create Checkpoint Section */}
                    <div className="checkpoint-modal__create">
                        <h3>Create Checkpoint</h3>
                        <p className="text-muted">Save your current progress with a message</p>
                        <form onSubmit={handleCreateCheckpoint} className="checkpoint-form">
                            <Input
                                placeholder="e.g., Updated textures, Fixed animations, etc."
                                value={message}
                                onChange={(e) => setMessage(e.target.value)}
                                disabled={isCreating}
                            />
                            <Button type="submit" variant="primary" disabled={!message.trim() || isCreating}>
                                {isCreating ? 'Creating...' : 'Create Checkpoint'}
                            </Button>
                        </form>

                        {isCreating && createProgress && (
                            <div className="checkpoint-progress">
                                <ProgressBar
                                    value={progressPercent}
                                    label={createProgress.phase}
                                    caption={
                                        createProgress.total > 0
                                            ? `${createProgress.current}/${createProgress.total} files (${progressPercent}%)`
                                            : undefined
                                    }
                                />
                            </div>
                        )}
                    </div>

                    {/* Checkpoint List & Details */}
                    <div className="checkpoint-modal__content">
                        {/* Left: List */}
                        <div className="checkpoint-modal__list">
                            <h3>History</h3>
                            {isLoading ? (
                                <div className="checkpoint-modal__loading">Loading checkpoints...</div>
                            ) : checkpoints.length === 0 ? (
                                <div className="checkpoint-modal__empty">
                                    <Icon name="info" />
                                    <p>No checkpoints yet</p>
                                    <p className="text-muted">Create your first checkpoint to save your progress</p>
                                </div>
                            ) : (
                                <div className="checkpoint-list">
                                    {checkpoints.map((cp, idx) => {
                                        const cpDiff = diffCache[cp.id];
                                        const isInitial = idx === checkpoints.length - 1;
                                        const isSelected = selectedCheckpoint === cp.id;

                                        return (
                                            <div
                                                key={cp.id}
                                                className={`checkpoint-card ${isSelected ? 'checkpoint-card--selected' : ''}`}
                                                onClick={() => setSelectedCheckpoint(isSelected ? null : cp.id)}
                                            >
                                                <div className="checkpoint-card__marker" />
                                                <div className="checkpoint-card__content">
                                                    <div className="checkpoint-card__header">
                                                        <span className="checkpoint-card__message">{cp.message}</span>
                                                        <span className="checkpoint-card__time">
                                                            {formatRelativeTime(cp.timestamp)}
                                                        </span>
                                                    </div>

                                                    {/* Tags */}
                                                    {cp.tags.length > 0 && (
                                                        <div className="checkpoint-card__tags">
                                                            {cp.tags.map(tag => (
                                                                <span key={tag} className="checkpoint-tag">{tag}</span>
                                                            ))}
                                                        </div>
                                                    )}

                                                    {/* Change summary */}
                                                    <div className="checkpoint-card__summary">
                                                        {isInitial ? (
                                                            <span className="checkpoint-summary__initial">
                                                                ~{Object.keys(cp.file_manifest).length}
                                                            </span>
                                                        ) : cpDiff ? (
                                                            <>
                                                                {cpDiff.added.length > 0 && (
                                                                    <span className="diff-badge diff-badge--added">+{cpDiff.added.length}</span>
                                                                )}
                                                                {cpDiff.modified.length > 0 && (
                                                                    <span className="diff-badge diff-badge--modified">~{cpDiff.modified.length}</span>
                                                                )}
                                                                {cpDiff.deleted.length > 0 && (
                                                                    <span className="diff-badge diff-badge--deleted">-{cpDiff.deleted.length}</span>
                                                                )}
                                                                {cpDiff.added.length === 0 && cpDiff.modified.length === 0 && cpDiff.deleted.length === 0 && (
                                                                    <span className="text-muted">No changes</span>
                                                                )}
                                                            </>
                                                        ) : (
                                                            <span className="checkpoint-summary__initial">
                                                                ~{Object.keys(cp.file_manifest).length}
                                                            </span>
                                                        )}
                                                    </div>

                                                    <div className="checkpoint-card__actions">
                                                        <Button
                                                            variant="ghost"
                                                            size="sm"
                                                            icon="refresh"
                                                            title="Restore this checkpoint"
                                                            onClick={(e) => { e.stopPropagation(); handleRestore(cp.id); }}
                                                        >
                                                            Restore
                                                        </Button>
                                                        <Button
                                                            variant="danger"
                                                            size="sm"
                                                            icon="trash"
                                                            iconOnly
                                                            title="Delete checkpoint"
                                                            onClick={(e) => { e.stopPropagation(); handleDelete(cp.id); }}
                                                        />
                                                    </div>
                                                </div>
                                            </div>
                                        );
                                    })}
                                </div>
                            )}
                        </div>

                        {/* Right: Details */}
                        <div className="checkpoint-modal__details">
                            {selectedCheckpoint ? (
                                <div className="checkpoint-details">
                                    {isComparing ? (
                                        <div className="checkpoint-details__loading">
                                            <Spinner />
                                            <p>Calculating differences...</p>
                                        </div>
                                    ) : diff ? (
                                        <>
                                            <div className="checkpoint-diff__header">
                                                <h3>Changed Files</h3>
                                                <div className="checkpoint-diff__stats">
                                                    {diff.added.length > 0 && (
                                                        <span className="diff-badge diff-badge--added">+{diff.added.length} added</span>
                                                    )}
                                                    {diff.modified.length > 0 && (
                                                        <span className="diff-badge diff-badge--modified">~{diff.modified.length} modified</span>
                                                    )}
                                                    {diff.deleted.length > 0 && (
                                                        <span className="diff-badge diff-badge--deleted">-{diff.deleted.length} deleted</span>
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
                                                        <div className="diff-file__info">
                                                            <span className="diff-file__name">{getFileName(f.path)}</span>
                                                            <span className="diff-file__path">{f.path}</span>
                                                        </div>
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
                                                        <div className="diff-file__info">
                                                            <span className="diff-file__name">{getFileName(curr.path)}</span>
                                                            <span className="diff-file__path">{curr.path}</span>
                                                        </div>
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
                                                        <div className="diff-file__info">
                                                            <span className="diff-file__name">{getFileName(f.path)}</span>
                                                            <span className="diff-file__path">{f.path}</span>
                                                        </div>
                                                        <span className="diff-file__size">{formatSize(f.size)}</span>
                                                    </div>
                                                ))}
                                                {diff.added.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0 && (
                                                    <div className="checkpoint-diff__empty">No file changes detected.</div>
                                                )}
                                            </div>

                                            {/* File preview comparison */}
                                            {previewFile && (
                                                <div className="checkpoint-preview">
                                                    <div className="checkpoint-preview__header">
                                                        <h4>{getFileName(previewFile.path)}</h4>
                                                        <Button
                                                            variant="ghost"
                                                            iconOnly
                                                            onClick={() => { setPreviewFile(null); setPreviewOld(null); setPreviewNew(null); }}
                                                            title="Close preview"
                                                        >
                                                            ×
                                                        </Button>
                                                    </div>
                                                    {isLoadingPreview ? (
                                                        <div className="checkpoint-preview__loading">Loading preview...</div>
                                                    ) : (
                                                        <div className="checkpoint-preview__compare">
                                                            {/* Old version */}
                                                            {previewFile.oldHash && (
                                                                <div className="checkpoint-preview__side">
                                                                    <div className="checkpoint-preview__label checkpoint-preview__label--old">Before</div>
                                                                    <PreviewContent content={previewOld} />
                                                                </div>
                                                            )}
                                                            {/* New version */}
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
                                        </>
                                    ) : (
                                        <div className="checkpoint-details__info">
                                            <p className="text-muted">Loading changes...</p>
                                        </div>
                                    )}
                                </div>
                            ) : (
                                <div className="checkpoint-details__placeholder">
                                    <Icon name="info" />
                                    <p>Select a checkpoint to view changes</p>
                                </div>
                            )}
                        </div>
                    </div>
                </ModalBody>
        </Modal>
    );
};

/** Render preview content based on type */
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
