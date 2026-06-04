/**
 * Flint - Inibin Editor Component (Monaco Editor)
 *
 * Editable view for `.inibin` / `.cfgbin` files rendered as INI-style text.
 * v1 files are shown read-only with a banner; v2 files are fully editable
 * and can be saved back to binary via the Rust `save_inibin_text` command.
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
import { useAppMetadataStore, useNotificationStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { deferCleanup } from '../../lib/ui-helpers/deferCleanup';

interface InibinEditorProps {
    filePath: string;
}

export const InibinEditor: React.FC<InibinEditorProps> = ({ filePath }) => {
    const showToast = useNotificationStore((s) => s.showToast);

    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [readOnly, setReadOnly] = useState(false);
    const [dirty, setDirty] = useState(false);

    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const originalRef = useRef('');

    // Subscribe to file version changes for hot reload (same pattern as BinEditor)
    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setDirty(false);

        api.readInibinText(filePath)
            .then((text) => {
                if (cancelled) return;
                originalRef.current = text;
                const ro = text.startsWith('# inibin v1');
                setReadOnly(ro);

                if (!containerRef.current) return;

                const ed = monaco.editor.create(containerRef.current, {
                    value: text,
                    language: 'ini',
                    theme: 'vs-dark',
                    readOnly: ro,
                    automaticLayout: true,
                    fontFamily: 'var(--font-mono), "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
                    fontSize: 13,
                    lineHeight: 20,
                    minimap: { enabled: false },
                    scrollBeyondLastLine: false,
                    contextmenu: false,
                    quickSuggestions: false,
                    wordBasedSuggestions: 'off',
                    tabSize: 4,
                    insertSpaces: true,
                });

                editorRef.current = ed;

                ed.getModel()?.onDidChangeContent(() => {
                    setDirty(ed.getValue() !== originalRef.current);
                });
            })
            .catch((err) => {
                if (!cancelled) setError((err as Error).message || 'Failed to load inibin');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => {
            cancelled = true;
            const ed = editorRef.current;
            editorRef.current = null;
            if (ed) {
                deferCleanup(() => ed.dispose());
            }
        };
    // fileVersion is intentionally included to trigger reload on hot-reload events
    }, [filePath, fileVersion]); // eslint-disable-line react-hooks/exhaustive-deps

    const handleSave = useCallback(async () => {
        const ed = editorRef.current;
        if (!ed) return;
        try {
            await api.saveInibinText(filePath, ed.getValue());
            originalRef.current = ed.getValue();
            setDirty(false);
            showToast('success', 'Inibin saved');
        } catch (err) {
            showToast('error', (err as Error).message || 'Failed to save inibin');
        }
    }, [filePath, showToast]);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key === 's') {
                e.preventDefault();
                if (!readOnly) void handleSave();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [handleSave, readOnly]);

    if (loading) {
        return (
            <div className="preview-panel__loading">
                <div className="spinner" />
                <span>Loading…</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="preview-panel__loading">
                <span>{error}</span>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            {/* Toolbar */}
            <div style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 10px',
                borderBottom: '1px solid var(--border, #333)',
                flexShrink: 0,
            }}>
                <span style={{ fontSize: 12, opacity: 0.7 }}>
                    {readOnly ? 'Inibin v1 (read-only)' : 'Inibin'}
                </span>
                {readOnly && (
                    <span style={{
                        fontSize: 11,
                        color: 'var(--warning, #f0a020)',
                        background: 'color-mix(in oklab, var(--warning, #f0a020) 12%, transparent)',
                        border: '1px solid color-mix(in oklab, var(--warning, #f0a020) 30%, transparent)',
                        borderRadius: 4,
                        padding: '1px 6px',
                    }}>
                        v1 — read-only
                    </span>
                )}
                <div style={{ flex: 1 }} />
                {!readOnly && (
                    <button
                        className="btn btn--primary btn--sm"
                        disabled={!dirty}
                        onClick={handleSave}
                        title="Save inibin (Ctrl+S)"
                    >
                        Save
                    </button>
                )}
            </div>

            {/* Monaco editor container */}
            <div ref={containerRef} style={{ flex: 1, minHeight: 0 }} />
        </div>
    );
};
