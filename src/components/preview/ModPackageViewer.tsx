import React, { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import type { ModpkgSession } from '../../lib/api/modpkgEdit';
import {
    useFileEditorStore,
    useModalStore,
    useNavigationStore,
    useNotificationStore,
} from '../../lib/stores';
import type { FileEditorTarget } from '../../lib/types';
import { Button, Field, FormGroup, FormLabel, Input, Spinner, Textarea } from '../ui';
import { VirtualList } from './VirtualList';

type ArchiveKind = 'fantome' | 'modpkg';

function detectKind(path: string): ArchiveKind {
    return path.toLowerCase().endsWith('.modpkg') ? 'modpkg' : 'fantome';
}

function fileName(path: string): string {
    return path.replace(/\\/g, '/').split('/').pop() ?? path;
}

/**
 * Read-only viewer for `.fantome`/`.modpkg` archives, shown in the file-editor view
 * instead of crashing into the BIN editor. For `.modpkg` it doubles as a minimal
 * metadata editor (name/author/version/description) backed by an edit session.
 */
export const ModPackageViewer: React.FC<{ target: FileEditorTarget }> = ({ target }) => {
    const showToast = useNotificationStore((s) => s.showToast);
    const setDirty = useFileEditorStore((s) => s.setDirty);
    const closeTarget = useFileEditorStore((s) => s.closeTarget);
    const setView = useNavigationStore((s) => s.setView);
    const openModal = useModalStore((s) => s.openModal);

    const kind = detectKind(target.filePath);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [filePaths, setFilePaths] = useState<string[]>([]);
    const [fileCount, setFileCount] = useState(0);
    const [thumbnail, setThumbnail] = useState<string | null>(null);
    const [champion, setChampion] = useState<string | null>(null);
    const [skinIds, setSkinIds] = useState<number[]>([]);

    // ModPkg edit-session state (null for fantome / before load)
    const [sessionId, setSessionId] = useState<string | null>(null);
    const [name, setName] = useState('');
    const [displayName, setDisplayName] = useState('');
    const [version, setVersion] = useState('');
    const [description, setDescription] = useState('');
    const [author, setAuthor] = useState('');
    const [localDirty, setLocalDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    const editable = kind === 'modpkg';

    // Load: fantome → analyze (read-only); modpkg → open edit session.
    useEffect(() => {
        let cancelledSession: string | null = null;
        (async () => {
            setLoading(true);
            setError(null);
            try {
                if (kind === 'fantome') {
                    const a = await api.analyzeFantome(target.filePath);
                    setFilePaths(a.file_paths);
                    setFileCount(a.file_count);
                    setChampion(a.champion);
                    setSkinIds(a.skin_ids);
                    setDisplayName(a.metadata?.name ?? fileName(target.filePath));
                    setVersion(a.metadata?.version ?? '');
                    setDescription(a.metadata?.description ?? '');
                    setAuthor(a.metadata?.author ?? '');
                } else {
                    const s: ModpkgSession = await api.openModpkgSession(target.filePath);
                    cancelledSession = s.session_id;
                    setSessionId(s.session_id);
                    setFilePaths(s.file_paths);
                    setFileCount(s.file_paths.length);
                    setThumbnail(s.thumbnail);
                    setName(s.name);
                    setDisplayName(s.display_name);
                    setVersion(s.version);
                    setDescription(s.description ?? '');
                    setAuthor(s.authors[0] ?? '');
                    // Reuse the analyzer for champion/skin detection (cheap, path-based).
                    try {
                        const a = await api.analyzeModpkg(target.filePath);
                        setChampion(a.champion);
                        setSkinIds(a.skin_ids);
                    } catch {
                        /* detection is best-effort */
                    }
                }
                setLocalDirty(false);
                setDirty(false);
            } catch (err) {
                console.error('Failed to open mod package:', err);
                setError(
                    (err as api.FlintError)?.getUserMessage?.() ?? 'Failed to open this mod package.',
                );
            } finally {
                setLoading(false);
            }
        })();

        // Release the session when navigating away.
        return () => {
            if (cancelledSession) {
                api.closeModpkgSession(cancelledSession).catch(() => {});
            }
        };
    }, [target.filePath, kind, setDirty]);

    const markDirty = useCallback(() => {
        setLocalDirty(true);
        setDirty(true);
    }, [setDirty]);

    const handleSave = useCallback(async () => {
        if (!sessionId) return;
        setSaving(true);
        try {
            await api.saveModpkgSession(
                sessionId,
                {
                    name: name.trim(),
                    display_name: displayName.trim(),
                    description: description.trim() || null,
                    version: version.trim() || '0.1.0',
                    authors: author.trim() ? [author.trim()] : [],
                },
                target.filePath, // in-place save
            );
            setLocalDirty(false);
            setDirty(false);
            showToast('success', 'Mod package saved');
        } catch (err) {
            console.error('Failed to save mod package:', err);
            showToast('error', 'Failed to save mod package');
        } finally {
            setSaving(false);
        }
    }, [sessionId, name, displayName, description, version, author, target.filePath, setDirty, showToast]);

    const handleClose = useCallback(() => {
        closeTarget();
        setView('preview');
    }, [closeTarget, setView]);

    const handleImport = useCallback(() => {
        openModal('importMod', { filePath: target.filePath });
    }, [openModal, target.filePath]);

    if (loading) {
        return (
            <div className="mod-pkg-viewer" style={{ alignItems: 'center', justifyContent: 'center' }}>
                <Spinner size="lg" />
                <div style={{ color: 'var(--text-secondary)', marginTop: 12 }}>Opening mod package…</div>
            </div>
        );
    }

    if (error) {
        return (
            <div className="mod-pkg-viewer">
                <div className="import-mod__error-text">{error}</div>
                <div className="mod-pkg-viewer__actions">
                    <Button variant="secondary" onClick={handleClose}>
                        Close
                    </Button>
                    <Button variant="primary" onClick={handleImport}>
                        Import as Project
                    </Button>
                </div>
            </div>
        );
    }

    return (
        <div className="mod-pkg-viewer">
            <div className="mod-pkg-viewer__header">
                {thumbnail && <img className="mod-pkg-viewer__thumb" src={thumbnail} alt="Thumbnail" />}
                <div style={{ minWidth: 0 }}>
                    <h2 className="mod-pkg-viewer__title">{displayName || fileName(target.filePath)}</h2>
                    <div className="mod-pkg-viewer__meta">
                        <span>{kind === 'fantome' ? 'Fantome' : 'ModPkg'}</span>
                        {champion && <span>Champion: {champion}</span>}
                        {skinIds.length > 0 && <span>Skins: {skinIds.join(', ')}</span>}
                        <span>{fileCount} files</span>
                        {author && <span>by {author}</span>}
                    </div>
                </div>
            </div>

            {editable ? (
                <div>
                    <div className="mod-pkg-viewer__section-title">Metadata</div>
                    <div className="mod-pkg-viewer__form">
                        <Field
                            label="Display Name"
                            value={displayName}
                            onChange={(e) => { setDisplayName(e.target.value); markDirty(); }}
                            placeholder="My Awesome Mod"
                        />
                        <Field
                            label="Author"
                            value={author}
                            onChange={(e) => { setAuthor(e.target.value); markDirty(); }}
                            placeholder="Your name"
                        />
                        <Field
                            label="Version"
                            value={version}
                            onChange={(e) => { setVersion(e.target.value); markDirty(); }}
                            placeholder="1.0.0"
                        />
                        <FormGroup>
                            <FormLabel>Description</FormLabel>
                            <Textarea
                                value={description}
                                onChange={(e) => { setDescription(e.target.value); markDirty(); }}
                                placeholder="A brief description of your mod"
                                rows={3}
                                style={{ resize: 'vertical' }}
                            />
                        </FormGroup>
                    </div>
                </div>
            ) : (
                <div className="mod-pkg-viewer__form">
                    <FormGroup>
                        <FormLabel>Description</FormLabel>
                        <Input value={description || '—'} readOnly />
                    </FormGroup>
                </div>
            )}

            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                <div className="mod-pkg-viewer__section-title">Files ({fileCount})</div>
                <div className="mod-pkg-viewer__files">
                    <VirtualList<string>
                        items={filePaths}
                        rowHeight={26}
                        renderRow={(p) => (
                            <div className="mod-pkg-viewer__file-row" title={p}>
                                {p}
                            </div>
                        )}
                    />
                </div>
            </div>

            <div className="mod-pkg-viewer__actions">
                <Button variant="secondary" className="mod-pkg-viewer__actions-left" onClick={handleClose} disabled={saving}>
                    {localDirty ? 'Discard' : 'Close'}
                </Button>
                <Button variant="secondary" onClick={handleImport} disabled={saving}>
                    Import as Project
                </Button>
                {editable && (
                    <Button variant="primary" onClick={handleSave} disabled={!localDirty || saving}>
                        {saving ? 'Saving…' : 'Save'}
                    </Button>
                )}
            </div>
        </div>
    );
};
