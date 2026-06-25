import React, { useCallback, useEffect, useState } from 'react';
import * as api from '../../lib/api';
import {
    useFileEditorStore,
    useNavigationStore,
    useNotificationStore,
} from '../../lib/stores';
import type { FileEditorTarget } from '../../lib/types';
import { BinEditor } from '../preview/BinEditor';
import { LuaBin64Editor } from '../preview/LuaBin64Editor';
import { Button, Field, FormGroup, FormLabel, Input, Textarea } from '../ui';

// ─── mod.config.json structured editor ──────────────────────────────────

interface ModConfig {
    name: string;
    display_name: string;
    version: string;
    description: string;
    authors: ModConfigAuthor[];
    [key: string]: unknown;
}

type ModConfigAuthor = string | { name: string; role: string };

function getAuthorName(author: ModConfigAuthor): string {
    if (typeof author === 'string') return author;
    if (author && typeof author === 'object') {
        if ('name' in author) return author.name;
        if ('Name' in author) return (author as Record<string, unknown>).Name as string;
        if ('NameAndRole' in author) {
            const inner = (author as Record<string, unknown>).NameAndRole as { name: string };
            return inner.name;
        }
    }
    return '';
}

function getAuthorRole(author: ModConfigAuthor): string {
    if (typeof author === 'string') return '';
    if (author && typeof author === 'object') {
        if ('role' in author) return author.role;
        if ('NameAndRole' in author) {
            const inner = (author as Record<string, unknown>).NameAndRole as { role: string };
            return inner.role;
        }
    }
    return '';
}

function buildAuthor(name: string, role: string): ModConfigAuthor {
    return role.trim() ? { name, role } : name;
}

interface AuthorRow {
    name: string;
    role: string;
}

const ModConfigEditor: React.FC<{ target: FileEditorTarget }> = ({ target }) => {
    const showToast = useNotificationStore((s) => s.showToast);
    const setDirty = useFileEditorStore((s) => s.setDirty);
    const closeTarget = useFileEditorStore((s) => s.closeTarget);
    const setView = useNavigationStore((s) => s.setView);

    const [config, setConfig] = useState<ModConfig | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [version, setVersion] = useState('');
    const [description, setDescription] = useState('');
    const [authors, setAuthors] = useState<AuthorRow[]>([]);
    const [localDirty, setLocalDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const text = await api.readTextFile(target.filePath);
                const parsed = JSON.parse(text) as ModConfig;
                setConfig(parsed);
                setDisplayName(parsed.display_name || '');
                setVersion(parsed.version || '');
                setDescription(parsed.description || '');
                setAuthors(
                    (parsed.authors || []).map((a) => ({
                        name: getAuthorName(a),
                        role: getAuthorRole(a),
                    })),
                );
                setLocalDirty(false);
                setDirty(false);
            } catch (err) {
                console.error('Failed to load mod.config.json:', err);
                showToast('error', 'Failed to load mod.config.json');
                closeTarget();
                setView('preview');
            }
        })();
    }, [target.filePath, showToast, closeTarget, setView, setDirty]);

    const markDirty = useCallback(() => {
        setLocalDirty(true);
        setDirty(true);
    }, [setDirty]);

    const handleSave = useCallback(async () => {
        if (!config) return;
        setSaving(true);
        try {
            const updated: ModConfig = {
                ...config,
                display_name: displayName,
                version,
                description,
                authors: authors
                    .filter((a) => a.name.trim())
                    .map((a) => buildAuthor(a.name.trim(), a.role.trim())),
            };
            await api.writeTextFile(target.filePath, JSON.stringify(updated, null, 2));
            setLocalDirty(false);
            setDirty(false);
            showToast('success', 'Project config saved');
        } catch (err) {
            console.error('Failed to save mod.config.json:', err);
            showToast('error', 'Failed to save project config');
        } finally {
            setSaving(false);
        }
    }, [config, target.filePath, displayName, version, description, authors, showToast, setDirty]);

    if (!config) {
        return (
            <div style={{ padding: '32px', color: 'var(--text-secondary)' }}>Loading project config…</div>
        );
    }

    return (
        <div style={{ padding: '16px 24px 24px', maxWidth: 720 }}>
            <Field
                label="Display Name"
                placeholder="My Awesome Mod"
                value={displayName}
                onChange={(e) => { setDisplayName(e.target.value); markDirty(); }}
            />
            <Field
                label="Version"
                placeholder="1.0.0"
                value={version}
                onChange={(e) => { setVersion(e.target.value); markDirty(); }}
            />
            <FormGroup>
                <FormLabel>Description</FormLabel>
                <Textarea
                    value={description}
                    onChange={(e) => { setDescription(e.target.value); markDirty(); }}
                    placeholder="A brief description of your mod"
                    rows={4}
                    style={{ resize: 'vertical' }}
                />
            </FormGroup>

            <FormGroup>
                <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', marginBottom: 6 }}>
                    <FormLabel>Contributors</FormLabel>
                    <Button size="sm" onClick={() => { setAuthors((p) => [...p, { name: '', role: '' }]); markDirty(); }}>
                        + Add
                    </Button>
                </div>
                {authors.length === 0 && (
                    <div style={{ color: 'var(--text-secondary)', fontSize: 'var(--text-sm)', padding: '8px 0' }}>
                        No contributors added yet
                    </div>
                )}
                {authors.map((author, i) => (
                    <div key={i} style={{ display: 'flex', gap: 6, marginBottom: 6, alignItems: 'center' }}>
                        <Input
                            value={author.name}
                            onChange={(e) => {
                                setAuthors((p) => p.map((a, idx) => (idx === i ? { ...a, name: e.target.value } : a)));
                                markDirty();
                            }}
                            placeholder="Name"
                            style={{ flex: 2 }}
                        />
                        <Input
                            value={author.role}
                            onChange={(e) => {
                                setAuthors((p) => p.map((a, idx) => (idx === i ? { ...a, role: e.target.value } : a)));
                                markDirty();
                            }}
                            placeholder="Role (optional)"
                            style={{ flex: 1 }}
                        />
                        <Button
                            size="sm"
                            onClick={() => {
                                setAuthors((p) => p.filter((_, idx) => idx !== i));
                                markDirty();
                            }}
                            title="Remove contributor"
                            style={{ color: 'var(--error)', flexShrink: 0 }}
                        >
                            ×
                        </Button>
                    </div>
                ))}
            </FormGroup>

            <div style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                marginTop: 24,
                paddingTop: 16,
                borderTop: '1px solid var(--border)',
            }}>
                <Button
                    variant="secondary"
                    onClick={() => {
                        closeTarget();
                        setView('preview');
                    }}
                    disabled={saving}
                >
                    {localDirty ? 'Discard' : 'Close'}
                </Button>
                <Button variant="primary" onClick={handleSave} disabled={!localDirty || saving}>
                    {saving ? 'Saving…' : 'Save'}
                </Button>
            </div>
        </div>
    );
};

// ─── Raw text fallback ─────────────────────────────────────────────────

const RawTextEditor: React.FC<{ target: FileEditorTarget }> = ({ target }) => {
    const showToast = useNotificationStore((s) => s.showToast);
    const setDirty = useFileEditorStore((s) => s.setDirty);
    const closeTarget = useFileEditorStore((s) => s.closeTarget);
    const setView = useNavigationStore((s) => s.setView);

    const [content, setContent] = useState<string>('');
    const [localDirty, setLocalDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    useEffect(() => {
        (async () => {
            try {
                const text = await api.readTextFile(target.filePath);
                setContent(text);
                setLocalDirty(false);
                setDirty(false);
            } catch {
                showToast('error', 'Failed to load file');
                closeTarget();
                setView('preview');
            }
        })();
    }, [target.filePath, showToast, closeTarget, setView, setDirty]);

    const handleSave = useCallback(async () => {
        setSaving(true);
        try {
            await api.writeTextFile(target.filePath, content);
            setLocalDirty(false);
            setDirty(false);
            showToast('success', 'File saved');
        } catch {
            showToast('error', 'Failed to save file');
        } finally {
            setSaving(false);
        }
    }, [target.filePath, content, showToast, setDirty]);

    return (
        <div style={{ display: 'flex', flexDirection: 'column', padding: '16px 24px 24px', height: '100%', minHeight: 0 }}>
            <Textarea
                value={content}
                onChange={(e) => { setContent(e.target.value); setLocalDirty(true); setDirty(true); }}
                rows={28}
                style={{ flex: 1, fontFamily: 'var(--font-mono)', fontSize: 13, resize: 'none' }}
            />
            <div style={{
                display: 'flex',
                justifyContent: 'flex-end',
                gap: 8,
                marginTop: 16,
                paddingTop: 16,
                borderTop: '1px solid var(--border)',
            }}>
                <Button variant="secondary" onClick={() => { closeTarget(); setView('preview'); }} disabled={saving}>
                    {localDirty ? 'Discard' : 'Close'}
                </Button>
                <Button variant="primary" onClick={handleSave} disabled={!localDirty || saving}>
                    {saving ? 'Saving…' : 'Save'}
                </Button>
            </div>
        </div>
    );
};

// ─── Page shell ────────────────────────────────────────────────────────

export const FileEditorPage: React.FC = () => {
    const target = useFileEditorStore((s) => s.target);

    if (!target) {
        return (
            <div style={{ padding: 32, color: 'var(--text-secondary)' }}>
                No file is currently being edited.
            </div>
        );
    }

    return (
        <div
            className="file-editor-page"
            style={{
                display: 'flex',
                flexDirection: 'column',
                height: '100%',
                overflowY: target.kind === 'binText' || target.kind === 'modPackage' ? 'hidden' : 'auto',
                backgroundColor: 'var(--bg-primary)',
            }}
        >
            <div style={{ flex: 1, display: 'flex', flexDirection: 'column', minHeight: 0 }}>
                {target.kind === 'modConfig' && <ModConfigEditor key={target.filePath} target={target} />}
                {target.kind === 'raw' && <RawTextEditor key={target.filePath} target={target} />}
                {target.kind === 'binText' && (
                    <BinEditor key={target.filePath} filePath={target.filePath} hideFilename />
                )}
                {target.kind === 'luaBin64' && (
                    <LuaBin64Editor key={target.filePath} filePath={target.filePath} hideFilename />
                )}
            </div>
        </div>
    );
};
