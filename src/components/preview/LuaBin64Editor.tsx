/**
 * Flint - LuaBin64 Editor Component (Monaco Editor)
 *
 * A specialized code editor for viewing and editing decompiled LuaBin (.luabin/.luabin64)
 * files using Monaco Editor with a premium Dracula-inspired neon theme.
 */

import React, { useState, useEffect, useCallback, useRef } from 'react';
import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
import { useAppState, useAppMetadataStore, useFileEditorStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { AssetPreviewTooltip } from './AssetPreviewTooltip';

const LUABIN64_THEME_ID = 'luabin64-theme';

// Register the custom Dracula-inspired dark theme for Lua
function registerLuaBin64Theme(monacoInstance: typeof monaco) {
    monacoInstance.editor.defineTheme(LUABIN64_THEME_ID, {
        base: 'vs-dark',
        inherit: true,
        rules: [
            { token: 'keyword', foreground: 'ff79c6', fontStyle: 'bold' },
            { token: 'string', foreground: 'f1fa8c' },
            { token: 'comment', foreground: '6272a4', fontStyle: 'italic' },
            { token: 'number', foreground: 'bd93f9' },
            { token: 'identifier', foreground: 'f8f8f2' },
            { token: 'operator', foreground: 'ff79c6' },
            { token: 'delimiter', foreground: 'f8f8f2' }
        ],
        colors: {
            'editor.background': '#1e1e24',
            'editor.foreground': '#f8f8f2',
            'editorLineNumber.foreground': '#6272a4',
            'editorLineNumber.activeForeground': '#f8f8f2',
            'editorGutter.background': '#19191e',
            'editor.lineHighlightBackground': '#282a36',
            'editor.lineHighlightBorder': '#00000000',
            'editor.selectionBackground': '#44475a',
            'editorCursor.foreground': '#f8f8f2',
            'scrollbarSlider.background': '#6272a444',
            'scrollbarSlider.hoverBackground': '#6272a466',
            'scrollbarSlider.activeBackground': '#6272a488',
        }
    });
}

/** Delay in milliseconds before showing the asset preview tooltip */
const HOVER_DELAY_MS = 3000;

/** Asset file extensions that can be previewed */
const PREVIEWABLE_EXTENSIONS = ['tex', 'dds', 'scb', 'sco', 'skn'];

function isPreviewableAssetPath(value: string): boolean {
    if (!value) return false;
    const ext = value.toLowerCase().split('.').pop() || '';
    return PREVIEWABLE_EXTENSIONS.includes(ext);
}

/**
 * Extract string value from a line at a given column position.
 * Returns the string content if cursor is inside a quoted string.
 */
function extractStringAtPosition(line: string, column: number): string | null {
    const stringPattern = /"([^"\\]*(\\.[^"\\]*)*)"/g;
    let match;
    while ((match = stringPattern.exec(line)) !== null) {
        const startCol = match.index + 1;
        const endCol = match.index + match[0].length;
        if (column >= startCol && column <= endCol) return match[1];
    }
    return null;
}

const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
    automaticLayout: true,
    fontFamily: 'var(--font-mono), "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 20,
    lineNumbers: 'on',
    lineNumbersMinChars: 5,
    minimap: { enabled: false },
    folding: true,
    bracketPairColorization: { enabled: true },
    matchBrackets: 'always',
    maxTokenizationLineLength: 5000,
    stopRenderingLineAfter: 10000,
    scrollBeyondLastLine: false,
    smoothScrolling: false,
    fastScrollSensitivity: 5,
    cursorBlinking: 'solid',
    cursorSmoothCaretAnimation: 'off',
    cursorStyle: 'line',
    renderWhitespace: 'none',
    renderControlCharacters: false,
    renderLineHighlight: 'line',
    renderValidationDecorations: 'on',
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    tabSize: 4,
    insertSpaces: true,
    autoIndent: 'none',
    wordWrap: 'off',
    quickSuggestions: false,
    suggestOnTriggerCharacters: false,
    acceptSuggestionOnEnter: 'off',
    parameterHints: { enabled: false },
    wordBasedSuggestions: 'off',
    hover: { enabled: false },
    links: false,
    colorDecorators: false,
    codeLens: false,
    contextmenu: false,
};

interface LuaBin64EditorProps {
    filePath: string;
    hideFilename?: boolean;
}

export const LuaBin64Editor: React.FC<LuaBin64EditorProps> = ({ filePath, hideFilename }) => {
    const { showToast, setWorking, setReady } = useAppState();

    const [content, setContent] = useState<string>('');
    const [originalContent, setOriginalContent] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lineCount, setLineCount] = useState(0);

    // Subscribe to file version changes for hot reload
    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });

    const editorContainerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

    // Asset preview tooltip state
    const [previewAsset, setPreviewAsset] = useState<string | null>(null);
    const [previewPosition, setPreviewPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [showPreview, setShowPreview] = useState(false);
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastHoveredAssetRef = useRef<string | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const isDirty = content !== originalContent;
    const basePath = filePath.split(/[/\\]/).slice(0, -1).join('\\');

    // Sync dirty state to file editor store
    const fileEditorTarget = useFileEditorStore((s) => s.target);
    const setFileEditorDirty = useFileEditorStore((s) => s.setDirty);
    useEffect(() => {
        if (fileEditorTarget && fileEditorTarget.filePath === filePath) {
            setFileEditorDirty(isDirty);
        }
        return () => {
            if (fileEditorTarget && fileEditorTarget.filePath === filePath) {
                setFileEditorDirty(false);
            }
        };
    }, [isDirty, filePath, fileEditorTarget, setFileEditorDirty]);

    // Load LuaBin file and decompile if compiled bytecode
    useEffect(() => {
        const loadLuaBin = async () => {
            setLoading(true);
            setError(null);
            try {
                const bytes = await api.readFileBytes(filePath);
                let text = '';
                // Check magic bytes to see if it's compiled Lua bytecode (starts with \x1bLua)
                if (bytes.length >= 4 && bytes[0] === 0x1b && bytes[1] === 0x4c && bytes[2] === 0x75 && bytes[3] === 0x61) {
                    text = await api.convertLuabinToText(bytes);
                } else {
                    // Already decompiled or standard Lua file
                    text = new TextDecoder('utf-8').decode(bytes);
                }
                setContent(text);
                setOriginalContent(text);
                setLineCount(text.split('\n').length);
            } catch (err) {
                console.error('[LuaBin64Editor] Error loading file:', err);
                setError((err as Error).message || 'Failed to load file');
            } finally {
                setLoading(false);
            }
        };
        loadLuaBin();
    }, [filePath, fileVersion]);

    // Register theme and create Monaco editor
    useEffect(() => {
        if (loading || error || !editorContainerRef.current) return;

        // Register custom theme
        registerLuaBin64Theme(monaco);

        const ed = monaco.editor.create(editorContainerRef.current, {
            ...EDITOR_OPTIONS,
            value: content,
            language: 'lua',
            theme: LUABIN64_THEME_ID,
        });

        editorRef.current = ed;

        const model = ed.getModel();
        if (model) {
            setLineCount(model.getLineCount());
            model.onDidChangeContent(() => {
                const value = ed.getValue();
                setContent(value);
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
        try {
            setWorking('Saving LuaBin64 file...');
            // Save compiled/edited Lua as raw text
            await api.writeTextFile(filePath, content);
            setOriginalContent(content);
            setReady('Saved');
            showToast('success', 'LuaBin64 file saved successfully');
        } catch (err) {
            console.error('[LuaBin64Editor] Save error:', err);
            const flintError = err as api.FlintError;
            showToast('error', flintError.getUserMessage?.() || 'Failed to save');
        }
    }, [filePath, content, setWorking, setReady, showToast]);

    useEffect(() => { return () => { if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current); }; }, []);

    const moveRafRef = useRef<number | null>(null);
    const lastMoveRef = useRef<{ x: number; y: number; target: HTMLElement } | null>(null);

    const inspectHover = useCallback(() => {
        moveRafRef.current = null;
        const move = lastMoveRef.current;
        if (!move) return;
        const editorInst = editorRef.current;
        if (!editorInst) return;
        if (!move.target.closest('.monaco-editor')) return;
        if (!editorInst.getDomNode()) return;
        const pos = editorInst.getTargetAtClientPoint(move.x, move.y);
        if (!pos?.position) { if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; } return; }
        const model = editorInst.getModel();
        if (!model) return;
        const lineContent = model.getLineContent(pos.position.lineNumber);
        const stringValue = extractStringAtPosition(lineContent, pos.position.column);
        setPreviewPosition({ x: move.x, y: move.y });
        if (stringValue && isPreviewableAssetPath(stringValue)) {
            if (stringValue !== lastHoveredAssetRef.current) {
                lastHoveredAssetRef.current = stringValue;
                setShowPreview(false);
                if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
                hoverTimerRef.current = setTimeout(() => { setPreviewAsset(stringValue); setShowPreview(true); }, HOVER_DELAY_MS);
            }
        } else {
            if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
            lastHoveredAssetRef.current = null;
            setShowPreview(false);
        }
    }, []);

    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        lastMoveRef.current = { x: e.clientX, y: e.clientY, target: e.target as HTMLElement };
        if (moveRafRef.current === null) moveRafRef.current = requestAnimationFrame(inspectHover);
    }, [inspectHover]);

    useEffect(() => { return () => { if (moveRafRef.current !== null) { cancelAnimationFrame(moveRafRef.current); moveRafRef.current = null; } }; }, []);

    const handleMouseLeave = useCallback(() => {
        if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
        lastHoveredAssetRef.current = null;
        setShowPreview(false);
    }, []);

    const handleClick = useCallback(() => {
        if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
        setShowPreview(false);
    }, []);

    const fileName = filePath.split('\\').pop() || filePath.split('/').pop() || 'file.lua';

    if (loading) {
        return (
            <div className="bin-editor__loading">
                <div className="spinner spinner--lg" />
                <span>Loading LuaBin64 file...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="bin-editor__error">
                <span dangerouslySetInnerHTML={{ __html: getIcon('warning') }} />
                <span>{error}</span>
            </div>
        );
    }

    return (
        <div className="bin-editor">
            <div className="bin-editor__toolbar">
                <span className="bin-editor__filename">
                    {!hideFilename && (
                        <>
                            {fileName}{isDirty ? ' \u2022' : ''}
                        </>
                    )}
                    <span className="bin-editor__stats" style={hideFilename ? { marginLeft: 0 } : undefined}>
                        {lineCount.toLocaleString()} lines
                    </span>
                </span>
                <div className="bin-editor__toolbar-actions">
                    <button
                        className="btn btn--primary btn--sm"
                        onClick={handleSave}
                        disabled={!isDirty}
                    >
                        Save
                    </button>
                </div>
            </div>

            <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
                <div
                    className="bin-editor__content"
                    ref={containerRef}
                    onMouseMove={handleMouseMove}
                    onMouseLeave={handleMouseLeave}
                    onClick={handleClick}
                    style={{ flex: 1, minWidth: 0 }}
                >
                    <div ref={editorContainerRef} style={{ width: '100%', height: '100%' }} />
                </div>
            </div>

            {previewAsset && (
                <AssetPreviewTooltip
                    assetPath={previewAsset}
                    basePath={basePath}
                    position={previewPosition}
                    visible={showPreview}
                />
            )}
        </div>
    );
};
