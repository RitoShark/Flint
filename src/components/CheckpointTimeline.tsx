/**
 * Flint - Checkpoint Timeline Component
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useAppState } from '../lib/state';
import * as api from '../lib/api';
import { getIcon } from '../lib/fileIcons';
import type { Checkpoint, CheckpointDiff } from '../lib/types';

export const CheckpointTimeline: React.FC = () => {
    const { state, showToast, setWorking, setReady } = useAppState();
    const [checkpoints, setCheckpoints] = useState<Checkpoint[]>([]);
    const [isLoading, setIsLoading] = useState(true);
    const [message, setMessage] = useState('');
    const [selectedCheckpoint, setSelectedCheckpoint] = useState<string | null>(null);
    const [diff, setDiff] = useState<CheckpointDiff | null>(null);
    const [isComparing, setIsComparing] = useState(false);

    // Get project path from active tab
    const activeTab = state.activeTabId
        ? state.openTabs.find(t => t.id === state.activeTabId)
        : null;
    const currentProjectPath = activeTab?.projectPath || null;

    const loadCheckpoints = useCallback(async () => {
        if (!currentProjectPath) return;
        setIsLoading(true);
        try {
            const list = await api.listCheckpoints(currentProjectPath);
            setCheckpoints(list);
        } catch (err) {
            console.error('Failed to load checkpoints:', err);
            showToast('error', 'Failed to load checkpoints');
        } finally {
            setIsLoading(false);
        }
    }, [currentProjectPath, showToast]);

    useEffect(() => {
        loadCheckpoints();
    }, [loadCheckpoints]);

    const handleCreateCheckpoint = async (e: React.FormEvent) => {
        e.preventDefault();
        if (!currentProjectPath || !message.trim()) return;

        setWorking('Creating checkpoint...');
        try {
            await api.createCheckpoint(currentProjectPath, message);
            setMessage('');
            showToast('success', 'Checkpoint created');
            await loadCheckpoints();
        } catch (err) {
            console.error('Failed to create checkpoint:', err);
            showToast('error', 'Failed to create checkpoint');
        } finally {
            setReady();
        }
    };

    const handleRestore = async (id: string) => {
        if (!currentProjectPath) return;
        if (!window.confirm('Are you sure you want to restore this checkpoint? All current changes will be overwritten.')) return;

        setWorking('Restoring checkpoint...');
        try {
            await api.restoreCheckpoint(currentProjectPath, id);
            showToast('success', 'Project restored successfully');
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
            if (selectedCheckpoint === id) setSelectedCheckpoint(null);
        } catch (err) {
            console.error('Failed to delete checkpoint:', err);
            showToast('error', 'Failed to delete checkpoint');
        }
    };

    const handleCompare = async (id: string) => {
        if (!currentProjectPath || checkpoints.length < 2) return;

        // Find the index of the current checkpoint
        const index = checkpoints.findIndex(c => c.id === id);
        if (index === -1 || index === checkpoints.length - 1) {
            showToast('info', 'No previous checkpoint to compare with');
            return;
        }

        const prevId = checkpoints[index + 1].id;

        setIsComparing(true);
        try {
            const diffResult = await api.compareCheckpoints(currentProjectPath, prevId, id);
            setDiff(diffResult);
            setSelectedCheckpoint(id);
        } catch (err) {
            console.error('Failed to compare:', err);
            showToast('error', 'Failed to compare checkpoints');
        } finally {
            setIsComparing(false);
        }
    };

    if (isLoading) {
        return <div className="checkpoint-view__loading">Loading checkpoints...</div>;
    }

    return (
        <div className="checkpoint-view">
            <div className="checkpoint-view__header">
                <h2>Project History</h2>
                <form className="checkpoint-view__create" onSubmit={handleCreateCheckpoint}>
                    <input
                        type="text"
                        placeholder="Checkpoint message..."
                        value={message}
                        onChange={e => setMessage(e.target.value)}
                        className="input"
                    />
                    <button type="submit" className="btn btn--primary" disabled={!message.trim()}>
                        Create Checkpoint
                    </button>
                </form>
            </div>

            <div className="checkpoint-view__content">
                <div className="checkpoint-view__list">
                    {checkpoints.length === 0 ? (
                        <div className="checkpoint-view__empty">
                            No checkpoints yet. Create one to save your progress!
                        </div>
                    ) : (
                        checkpoints.map((cp, idx) => (
                            <div
                                key={cp.id}
                                className={`checkpoint-item ${selectedCheckpoint === cp.id ? 'checkpoint-item--selected' : ''}`}
                                onClick={() => setSelectedCheckpoint(cp.id)}
                            >
                                <div className="checkpoint-item__marker" />
                                <div className="checkpoint-item__content">
                                    <div className="checkpoint-item__header">
                                        <span className="checkpoint-item__message">{cp.message}</span>
                                        <span className="checkpoint-item__date">
                                            {new Date(cp.timestamp).toLocaleString()}
                                        </span>
                                    </div>
                                    <div className="checkpoint-item__actions">
                                        <button
                                            className="btn btn--ghost btn--icon"
                                            title="Restore this state"
                                            onClick={(e) => { e.stopPropagation(); handleRestore(cp.id); }}
                                        >
                                            <span dangerouslySetInnerHTML={{ __html: getIcon('refresh') }} />
                                        </button>
                                        <button
                                            className="btn btn--ghost btn--icon"
                                            title="Compare with previous"
                                            onClick={(e) => { e.stopPropagation(); handleCompare(cp.id); }}
                                            disabled={idx === checkpoints.length - 1}
                                        >
                                            <span dangerouslySetInnerHTML={{ __html: getIcon('git-compare') }} />
                                        </button>
                                        <button
                                            className="btn btn--ghost btn--icon btn--danger"
                                            title="Delete checkpoint"
                                            onClick={(e) => { e.stopPropagation(); handleDelete(cp.id); }}
                                        >
                                            <span dangerouslySetInnerHTML={{ __html: getIcon('trash') }} />
                                        </button>
                                    </div>
                                </div>
                            </div>
                        ))
                    )}
                </div>

                <div className="checkpoint-view__details">
                    {selectedCheckpoint ? (
                        <div className="checkpoint-details">
                            {isComparing ? (
                                <div className="checkpoint-details__loading">Calculating differences...</div>
                            ) : diff ? (
                                <div className="checkpoint-diff">
                                    <h3>Changes from previous version</h3>
                                    <div className="checkpoint-diff__stats">
                                        <span className="diff-stat diff-stat--added">+{diff.added.length}</span>
                                        <span className="diff-stat diff-stat--modified">~{diff.modified.length}</span>
                                        <span className="diff-stat diff-stat--deleted">-{diff.deleted.length}</span>
                                    </div>
                                    <div className="checkpoint-diff__list">
                                        {diff.added.map(f => (
                                            <div key={f.path} className="diff-file diff-file--added">
                                                <span className="diff-file__icon" dangerouslySetInnerHTML={{ __html: getIcon('plus') }} />
                                                <span className="diff-file__path">{f.path}</span>
                                            </div>
                                        ))}
                                        {diff.modified.map(([_, curr]) => (
                                            <div key={curr.path} className="diff-file diff-file--modified">
                                                <span className="diff-file__icon" dangerouslySetInnerHTML={{ __html: getIcon('file-edit') }} />
                                                <span className="diff-file__path">{curr.path}</span>
                                            </div>
                                        ))}
                                        {diff.deleted.map(f => (
                                            <div key={f.path} className="diff-file diff-file--deleted">
                                                <span className="diff-file__icon" dangerouslySetInnerHTML={{ __html: getIcon('minus') }} />
                                                <span className="diff-file__path">{f.path}</span>
                                            </div>
                                        ))}
                                        {diff.added.length === 0 && diff.modified.length === 0 && diff.deleted.length === 0 && (
                                            <div className="checkpoint-diff__empty">No file changes detected.</div>
                                        )}
                                    </div>
                                    <button className="btn btn--ghost mt-lg" onClick={() => { setDiff(null); setSelectedCheckpoint(null); }}>
                                        Close Details
                                    </button>
                                </div>
                            ) : (
                                <div className="checkpoint-details__info">
                                    <h3>Checkpoint Details</h3>
                                    <p>ID: {selectedCheckpoint}</p>
                                    <p>Files cached: {checkpoints.find(c => c.id === selectedCheckpoint)?.file_manifest ? Object.keys(checkpoints.find(c => c.id === selectedCheckpoint)!.file_manifest).length : 0}</p>
                                    <p className="mt-md text-muted italic">Click the compare icon to see changes from the previous checkpoint.</p>
                                </div>
                            )}
                        </div>
                    ) : (
                        <div className="checkpoint-view__placeholder">
                            Select a checkpoint to view details and changes.
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
