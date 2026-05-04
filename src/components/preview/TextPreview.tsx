/**
 * Flint - Text Preview Component with Monaco Editor
 *
 * Uses Monaco Editor directly (no @monaco-editor/react wrapper — that
 * library's internal loader breaks in Tauri production builds with CORS errors).
 */

import React, { useState, useEffect, useRef, useCallback } from 'react';
import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
import * as api from '../../lib/api';
import { getIcon } from '../../lib/fileIcons';
import { useAppMetadataStore } from '../../lib/stores';

// Configure Monaco workers — wrap in try-catch so a broken worker doesn't
// cascade and break the entire editor (Monarch tokenizer runs on main thread anyway)
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

// Only set MonacoEnvironment if not already configured (BinEditor may have set it)
if (!self.MonacoEnvironment) {
    self.MonacoEnvironment = {
        getWorker(_: unknown, label: string) {
            try {
                if (label === 'json') return new jsonWorker();
                return new editorWorker();
            } catch (e) {
                console.warn('[Monaco] Worker creation failed, falling back to main thread:', e);
                const blob = new Blob(['self.onmessage=function(){}'], { type: 'text/javascript' });
                return new Worker(URL.createObjectURL(blob));
            }
        },
    };
}

/** Map file extensions to Monaco language IDs */
const LANGUAGE_MAP: Record<string, string> = {
    'json': 'json',
    'js': 'javascript',
    'jsx': 'javascript',
    'ts': 'typescript',
    'tsx': 'typescript',
    'py': 'python',
    'css': 'css',
    'scss': 'scss',
    'html': 'html',
    'xml': 'xml',
    'md': 'markdown',
    'yaml': 'yaml',
    'yml': 'yaml',
    'sh': 'shell',
    'bat': 'bat',
    'txt': 'plaintext',
};

interface TextPreviewProps {
    filePath: string;
}

export const TextPreview: React.FC<TextPreviewProps> = ({ filePath }) => {
    const [content, setContent] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [hasChanges, setHasChanges] = useState(false);
    const [saving, setSaving] = useState(false);
    const [lineCount, setLineCount] = useState(0);
    const originalContentRef = useRef<string>('');

    const editorContainerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

    // Subscribe to file version changes for hot reload — see ImagePreview.
    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });

    const ext = filePath.split('.').pop()?.toLowerCase() || 'txt';
    const language = LANGUAGE_MAP[ext] || 'plaintext';

    // Load text file
    useEffect(() => {
        const loadText = async () => {
            setLoading(true);
            setError(null);
            setHasChanges(false);

            try {
                const text = await api.readTextFile(filePath);
                setContent(text);
                originalContentRef.current = text;
                setLineCount(text.split('\n').length);
            } catch (err) {
                console.error('[TextPreview] Error:', err);
                setError((err as Error).message || 'Failed to load text');
            } finally {
                setLoading(false);
            }
        };

        loadText();
    }, [filePath, fileVersion]);

    // Create Monaco editor directly once content is loaded
    useEffect(() => {
        if (loading || error || !editorContainerRef.current) return;

        const ed = monaco.editor.create(editorContainerRef.current, {
            value: content,
            language,
            theme: 'vs-dark',
            automaticLayout: true,
            fontFamily: 'var(--font-mono), "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            tabSize: 2,
            insertSpaces: true,
            formatOnPaste: true,
            formatOnType: true,
            renderWhitespace: 'selection',
            bracketPairColorization: { enabled: true },
            scrollbar: {
                vertical: 'auto',
                horizontal: 'auto',
                verticalScrollbarSize: 12,
                horizontalScrollbarSize: 12,
                useShadows: false,
            },
        });

        editorRef.current = ed;

        const model = ed.getModel();
        if (model) {
            setLineCount(model.getLineCount());
            model.onDidChangeContent(() => {
                const value = ed.getValue();
                setContent(value);
                setHasChanges(value !== originalContentRef.current);
                setLineCount(model.getLineCount());
            });
        }

        return () => {
            ed.dispose();
            editorRef.current = null;
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, error]);

    const handleSave = useCallback(async () => {
        setSaving(true);
        try {
            await api.writeTextFile(filePath, content);
            originalContentRef.current = content;
            setHasChanges(false);
        } catch (err) {
            console.error('[TextPreview] Save error:', err);
            setError('Failed to save file');
        } finally {
            setSaving(false);
        }
    }, [filePath, content]);

    const handleRevert = useCallback(() => {
        const original = originalContentRef.current;
        setContent(original);
        setHasChanges(false);
        if (editorRef.current) {
            editorRef.current.setValue(original);
        }
    }, []);

    if (loading) {
        return (
            <div className="text-preview__loading">
                <div className="spinner" />
                <span>Loading text...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="text-preview__error">
                <span dangerouslySetInnerHTML={{ __html: getIcon('warning') }} />
                <span>{error}</span>
            </div>
        );
    }

    return (
        <div className="text-preview text-preview--monaco">
            <div className="text-preview__toolbar">
                <div className="text-preview__toolbar-left">
                    <span className="text-preview__lang">{ext.toUpperCase()}</span>
                    <span>{lineCount.toLocaleString()} lines</span>
                    {hasChanges && <span className="text-preview__modified">● Modified</span>}
                </div>
                <div className="text-preview__toolbar-right">
                    {hasChanges && (
                        <>
                            <button
                                className="btn btn--sm btn--ghost"
                                onClick={handleRevert}
                                disabled={saving}
                            >
                                Revert
                            </button>
                            <button
                                className="btn btn--sm btn--primary"
                                onClick={handleSave}
                                disabled={saving}
                            >
                                {saving ? 'Saving...' : 'Save'}
                            </button>
                        </>
                    )}
                </div>
            </div>
            <div className="text-preview__monaco-container">
                <div ref={editorContainerRef} style={{ width: '100%', height: '100%' }} />
            </div>
        </div>
    );
};
