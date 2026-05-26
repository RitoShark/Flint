/**
 * Flint - Mod Config Editor Modal
 * Provides a form-based editor for mod.config.json fields.
 */

import React, { useState, useEffect, useCallback } from 'react';
import { useModalStore, useNotificationStore } from '../../lib/stores';
import * as api from '../../lib/api';
import {
    Button,
    Field,
    FormGroup,
    FormLabel,
    Input,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Textarea,
} from '../ui';

interface ModConfig {
    name: string;
    display_name: string;
    version: string;
    description: string;
    authors: ModConfigAuthor[];
    license: unknown;
    transformers: unknown[];
    layers: unknown[];
    thumbnail: string | null;
    [key: string]: unknown;
}

// ModProjectAuthor is serde(untagged):
//   Name(String)    → serialized as plain "Author"
//   Role {name,role} → serialized as {"name":"...","role":"..."}
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

const AuthorEditor: React.FC<{
    authors: AuthorRow[];
    onAdd: () => void;
    onRemove: (i: number) => void;
    onUpdate: (i: number, field: 'name' | 'role', value: string) => void;
}> = ({ authors, onAdd, onRemove, onUpdate }) => (
    <FormGroup>
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                marginBottom: 6,
            }}
        >
            <FormLabel>Contributors</FormLabel>
            <Button size="sm" onClick={onAdd}>
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
                    onChange={(e) => onUpdate(i, 'name', e.target.value)}
                    placeholder="Name"
                    style={{ flex: 2 }}
                />
                <Input
                    value={author.role}
                    onChange={(e) => onUpdate(i, 'role', e.target.value)}
                    placeholder="Role (optional)"
                    style={{ flex: 1 }}
                />
                <Button
                    size="sm"
                    onClick={() => onRemove(i)}
                    title="Remove contributor"
                    style={{ color: 'var(--error)', flexShrink: 0 }}
                >
                    ×
                </Button>
            </div>
        ))}
    </FormGroup>
);

export const ModConfigEditorModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const showToast = useNotificationStore((s) => s.showToast);

    const isVisible = activeModal === 'modConfig';
    const options = modalOptions as { filePath: string } | null;

    const [config, setConfig] = useState<ModConfig | null>(null);
    const [displayName, setDisplayName] = useState('');
    const [version, setVersion] = useState('');
    const [description, setDescription] = useState('');
    const [authors, setAuthors] = useState<AuthorRow[]>([]);
    const [dirty, setDirty] = useState(false);

    useEffect(() => {
        if (!isVisible || !options?.filePath) return;

        (async () => {
            try {
                const text = await api.readTextFile(options.filePath);
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
                setDirty(false);
            } catch (err) {
                console.error('Failed to load mod.config.json:', err);
                showToast('error', 'Failed to load mod.config.json');
                closeModal();
            }
        })();
    }, [isVisible, options?.filePath, showToast, closeModal]);

    const handleSave = useCallback(async () => {
        if (!config || !options?.filePath) return;

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

            await api.writeTextFile(options.filePath, JSON.stringify(updated, null, 2));
            showToast('success', 'Project config saved');
            setDirty(false);
            closeModal();
        } catch (err) {
            console.error('Failed to save mod.config.json:', err);
            showToast('error', 'Failed to save project config');
        }
    }, [config, options?.filePath, displayName, version, description, authors, showToast, closeModal]);

    const addAuthor = useCallback(() => {
        setAuthors((prev) => [...prev, { name: '', role: '' }]);
        setDirty(true);
    }, []);

    const removeAuthor = useCallback((index: number) => {
        setAuthors((prev) => prev.filter((_, i) => i !== index));
        setDirty(true);
    }, []);

    const updateAuthor = useCallback((index: number, field: 'name' | 'role', value: string) => {
        setAuthors((prev) => prev.map((a, i) => (i === index ? { ...a, [field]: value } : a)));
        setDirty(true);
    }, []);

    return (
        <Modal open={isVisible} onClose={closeModal}>
            <ModalHeader title="Edit Project Info" onClose={closeModal} />

            <ModalBody className="mod-config-editor">
                <Field
                    label="Display Name"
                    placeholder="My Awesome Mod"
                    value={displayName}
                    onChange={(e) => {
                        setDisplayName(e.target.value);
                        setDirty(true);
                    }}
                />

                <Field
                    label="Version"
                    placeholder="1.0.0"
                    value={version}
                    onChange={(e) => {
                        setVersion(e.target.value);
                        setDirty(true);
                    }}
                />

                <FormGroup>
                    <FormLabel>Description</FormLabel>
                    <Textarea
                        value={description}
                        onChange={(e) => {
                            setDescription(e.target.value);
                            setDirty(true);
                        }}
                        placeholder="A brief description of your mod"
                        rows={3}
                        style={{ resize: 'vertical' }}
                    />
                </FormGroup>

                <AuthorEditor
                    authors={authors}
                    onAdd={addAuthor}
                    onRemove={removeAuthor}
                    onUpdate={updateAuthor}
                />
            </ModalBody>

            <ModalFooter>
                <Button variant="secondary" onClick={closeModal}>
                    Cancel
                </Button>
                <Button variant="primary" onClick={handleSave} disabled={!dirty}>
                    Save
                </Button>
            </ModalFooter>
        </Modal>
    );
};
