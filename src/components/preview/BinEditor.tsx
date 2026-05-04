/**
 * Flint - BIN Editor Component (Monaco Editor)
 *
 * A full-featured code editor for viewing and editing Ritobin (.bin) files
 * using Monaco Editor directly (no @monaco-editor/react wrapper — that
 * library's internal loader breaks in Tauri production builds).
 *
 * Features:
 * - Custom Ritobin language with semantic tokenization
 * - Matching dark theme
 * - Dirty state tracking and save functionality
 * - Asset preview on hover (textures, meshes)
 * - Real-time bracket validation with visual indicator
 */

import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
import { useAppState, useAppMetadataStore, useConfigStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { getIcon } from '../../lib/fileIcons';
import {
    RITOBIN_LANGUAGE_ID,
    RITOBIN_THEME_ID,
    registerRitobinLanguage,
    registerRitobinTheme
} from '../../lib/ritobinLanguage';
import { AssetPreviewTooltip } from './AssetPreviewTooltip';

// Configure Monaco workers — wrap in try-catch so a broken worker doesn't
// cascade and break the entire editor (Monarch tokenizer runs on main thread anyway)
import editorWorker from 'monaco-editor/esm/vs/editor/editor.worker?worker';
import jsonWorker from 'monaco-editor/esm/vs/language/json/json.worker?worker';

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

// Register language and theme at module level — guaranteed to run before
// any editor.create() call since ES module imports are evaluated first.
registerRitobinLanguage(monaco as any);
registerRitobinTheme(monaco as any);

/** Delay in milliseconds before showing the asset preview tooltip */
const HOVER_DELAY_MS = 3000;

/** Debounce delay for bracket validation (ms) */
const BRACKET_CHECK_DEBOUNCE_MS = 300;

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

// =============================================================================
// Bracket Validation
// =============================================================================

interface BracketError {
    line: number;
    column: number;
    char: string;
    message: string;
    /** Where the fix should be inserted (may differ from `line` for unclosed brackets) */
    suggestLine: number;
}

interface BracketValidation {
    valid: boolean;
    errors: BracketError[];
}

const BRACKET_PAIRS: Record<string, string> = { '{': '}', '[': ']', '(': ')' };
const CLOSING_BRACKETS = new Set(['}', ']', ')']);
const OPEN_FOR_CLOSE: Record<string, string> = { '}': '{', ']': '[', ')': '(' };

/**
 * Parse bracket stack up to a given line (1-based).
 * Returns array of unclosed opening brackets with their line number and indentation.
 */
function getBracketStackAtLine(text: string, upToLine: number): { char: string; line: number; indent: string }[] {
    const stack: { char: string; line: number; indent: string }[] = [];
    const lines = text.split('\n');
    const limit = Math.min(upToLine, lines.length);

    for (let lineIdx = 0; lineIdx < limit; lineIdx++) {
        const line = lines[lineIdx];
        let inString = false;

        for (let col = 0; col < line.length; col++) {
            const ch = line[col];

            if (!inString) {
                if (ch === '#') break;
                if (ch === '/' && col + 1 < line.length && line[col + 1] === '/') break;
            }

            if (ch === '"' && (col === 0 || line[col - 1] !== '\\')) {
                inString = !inString;
                continue;
            }

            if (inString) continue;

            if (BRACKET_PAIRS[ch]) {
                const indent = line.match(/^(\s*)/)?.[1] || '';
                stack.push({ char: ch, line: lineIdx + 1, indent });
            } else if (CLOSING_BRACKETS.has(ch)) {
                const expected = OPEN_FOR_CLOSE[ch];
                if (stack.length > 0 && stack[stack.length - 1].char === expected) {
                    stack.pop();
                }
            }
        }
    }

    return stack;
}

/**
 * Validate bracket matching in ritobin text.
 * Skips brackets inside quoted strings and comments.
 */
function validateBrackets(text: string): BracketValidation {
    const errors: BracketError[] = [];
    const stack: { char: string; line: number; column: number }[] = [];
    const lines = text.split('\n');

    for (let lineIdx = 0; lineIdx < lines.length; lineIdx++) {
        const line = lines[lineIdx];
        let inString = false;
        let isComment = false;

        for (let col = 0; col < line.length; col++) {
            const ch = line[col];

            // Check for comment start (# or //)
            if (!inString) {
                if (ch === '#') { isComment = true; break; }
                if (ch === '/' && col + 1 < line.length && line[col + 1] === '/') {
                    isComment = true;
                    break;
                }
            }

            // Track string boundaries (handle escaped quotes)
            if (ch === '"' && (col === 0 || line[col - 1] !== '\\')) {
                inString = !inString;
                continue;
            }

            if (inString || isComment) continue;

            // Opening bracket
            if (BRACKET_PAIRS[ch]) {
                stack.push({ char: ch, line: lineIdx + 1, column: col + 1 });
            }
            // Closing bracket
            else if (CLOSING_BRACKETS.has(ch)) {
                const expected = OPEN_FOR_CLOSE[ch];
                if (stack.length === 0) {
                    errors.push({
                        line: lineIdx + 1,
                        column: col + 1,
                        char: ch,
                        message: `Unexpected '${ch}' — no matching '${expected}'`,
                        suggestLine: lineIdx + 1,
                    });
                } else {
                    const top = stack[stack.length - 1];
                    if (top.char !== expected) {
                        errors.push({
                            line: lineIdx + 1,
                            column: col + 1,
                            char: ch,
                            message: `Expected '${BRACKET_PAIRS[top.char]}' (opened at line ${top.line}) but found '${ch}'`,
                            suggestLine: lineIdx + 1,
                        });
                    } else {
                        stack.pop();
                    }
                }
            }
        }
    }

    // Report unclosed brackets — suggest insertion point using indentation heuristic.
    // Scan forward from the opener to find the last line indented deeper than it;
    // that's where the closing bracket belongs (same logic as the ghost-text completer).
    for (let i = stack.length - 1; i >= 0; i--) {
        const unclosed = stack[i];
        const openerLineIdx = unclosed.line - 1;
        const openerIndent = lines[openerLineIdx].match(/^(\s*)/)?.[1].length ?? 0;

        // Find the last line that's indented deeper than the opener (skipping blanks/comments)
        let blockEnd = openerLineIdx;
        for (let j = openerLineIdx + 1; j < lines.length; j++) {
            const trimmed = lines[j].trim();
            if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
            const indent = lines[j].match(/^(\s*)/)?.[1].length ?? 0;
            if (indent <= openerIndent) break;
            blockEnd = j;
        }
        const suggestLine = blockEnd + 1; // 1-based

        errors.push({
            line: unclosed.line,
            column: unclosed.column,
            char: unclosed.char,
            message: `Unclosed '${unclosed.char}' (opened at line ${unclosed.line}) — add '${BRACKET_PAIRS[unclosed.char]}' after line ${suggestLine}`,
            suggestLine,
        });
    }

    return { valid: errors.length === 0, errors };
}

// =============================================================================
// Editor Options
// =============================================================================

/** Monaco editor options shared across create calls */
const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
    automaticLayout: true,
    fontFamily: 'var(--font-mono), "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 20,
    lineNumbers: 'on',
    lineNumbersMinChars: 5,
    minimap: { enabled: false },
    folding: false,
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
    renderLineHighlight: 'none',
    renderValidationDecorations: 'on',
    occurrencesHighlight: 'off',
    selectionHighlight: false,
    guides: {
        indentation: false,
        bracketPairs: true,
        highlightActiveBracketPair: true,
        highlightActiveIndentation: false,
    },
    scrollbar: {
        vertical: 'auto',
        horizontal: 'auto',
        verticalScrollbarSize: 12,
        horizontalScrollbarSize: 12,
        useShadows: false,
    },
    tabSize: 4,
    insertSpaces: true,
    autoIndent: 'none',
    formatOnPaste: false,
    formatOnType: false,
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
    inlineSuggest: { enabled: true, mode: 'prefix' },
    contextmenu: false,
    accessibilitySupport: 'off',
};

// =============================================================================
// Component
// =============================================================================

interface BinEditorProps {
    filePath: string;
}

export const BinEditor: React.FC<BinEditorProps> = ({ filePath }) => {
    const { showToast, setWorking, setReady } = useAppState();
    const binConverterEngine = useConfigStore((state) => state.binConverterEngine);

    const [content, setContent] = useState<string>('');
    const [originalContent, setOriginalContent] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lineCount, setLineCount] = useState(0);

    // Bracket validation state
    const [bracketStatus, setBracketStatus] = useState<BracketValidation>({ valid: true, errors: [] });
    const [bracketErrorIndex, setBracketErrorIndex] = useState(0);
    const bracketCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const decorationsRef = useRef<string[]>([]);

    // Subscribe to file version changes for hot reload — re-render only
    // when this file's version actually bumps (selector returns the value,
    // touching fileVersionsRev keeps the selector re-evaluating).
    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });

    const useJade = binConverterEngine === 'jade';

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

    // Run bracket validation and syntax validation (debounced)
    const runBracketCheck = useCallback((text: string) => {
        if (bracketCheckTimerRef.current) clearTimeout(bracketCheckTimerRef.current);
        bracketCheckTimerRef.current = setTimeout(async () => {
            const result = validateBrackets(text);
            setBracketStatus(result);
            setBracketErrorIndex(0);

            // Update Monaco decorations to highlight bracket errors
            const ed = editorRef.current;
            const model = ed?.getModel();
            if (ed && model) {
                const newDecorations: editor.IModelDeltaDecoration[] = result.errors.flatMap(err => {
                    const openerDec: editor.IModelDeltaDecoration = {
                        range: new monaco.Range(err.line, 1, err.line, model.getLineMaxColumn(err.line)),
                        options: {
                            isWholeLine: true,
                            className: 'bracket-error-line',
                            glyphMarginClassName: 'bracket-error-glyph',
                            overviewRuler: { color: '#ff4444', position: monaco.editor.OverviewRulerLane.Right },
                            minimap: { color: '#ff4444', position: monaco.editor.MinimapPosition.Inline },
                        },
                    };
                    // For unclosed brackets, also mark where the closing bracket should go
                    if (err.suggestLine !== err.line && err.suggestLine <= model.getLineCount()) {
                        const suggestDec: editor.IModelDeltaDecoration = {
                            range: new monaco.Range(err.suggestLine, 1, err.suggestLine, model.getLineMaxColumn(err.suggestLine)),
                            options: {
                                isWholeLine: true,
                                className: 'bracket-suggest-line',
                                afterContentClassName: 'bracket-suggest-after',
                                overviewRuler: { color: '#f0a020', position: monaco.editor.OverviewRulerLane.Right },
                                minimap: { color: '#f0a020', position: monaco.editor.MinimapPosition.Inline },
                            },
                        };
                        return [openerDec, suggestDec];
                    }
                    return [openerDec];
                });
                decorationsRef.current = ed.deltaDecorations(decorationsRef.current, newDecorations);

            }
        }, BRACKET_CHECK_DEBOUNCE_MS);
    }, []);

    // Load BIN file
    useEffect(() => {
        const loadBin = async () => {
            setLoading(true);
            setError(null);
            try {
                const text = await api.readOrConvertBin(filePath, useJade);
                setContent(text);
                setOriginalContent(text);
                setLineCount(text.split('\n').length);
                // Initial bracket check
                const result = validateBrackets(text);
                setBracketStatus(result);
            } catch (err) {
                console.error('[BinEditor] Error:', err);
                setError((err as Error).message || 'Failed to load BIN file');
            } finally {
                setLoading(false);
            }
        };
        loadBin();
    }, [filePath, fileVersion, useJade]); // Re-run when file version changes (hot reload) or engine changes

    // Create Monaco editor directly once content is loaded.
    // Disposes and recreates when file changes (loading cycles false→true→false).
    useEffect(() => {
        if (loading || error || !editorContainerRef.current) return;

        const ed = monaco.editor.create(editorContainerRef.current, {
            ...EDITOR_OPTIONS,
            value: content,
            language: RITOBIN_LANGUAGE_ID,
            theme: RITOBIN_THEME_ID,
        });

        editorRef.current = ed;

        // Register inline completions provider for bracket auto-close ghost text.
        // When the cursor is on an empty/whitespace-only line and there are unclosed
        // brackets above, shows a ghost closing bracket at the correct indentation.
        // Tab accepts it (Monaco default behaviour for inline completions).
        const inlineProvider = monaco.languages.registerInlineCompletionsProvider(RITOBIN_LANGUAGE_ID, {
            provideInlineCompletions(model, position) {
                const lineContent = model.getLineContent(position.lineNumber);
                const trimmed = lineContent.trim();

                // Only suggest on empty / whitespace-only lines, or when cursor is at end
                if (trimmed.length > 0 && position.column <= lineContent.length) {
                    return { items: [] };
                }

                const fullText = model.getValue();
                const stack = getBracketStackAtLine(fullText, position.lineNumber);

                if (stack.length === 0) return { items: [] };

                // Suggest closing bracket(s) for the most-recent unclosed opener
                const last = stack[stack.length - 1];
                const closingChar = BRACKET_PAIRS[last.char];
                const suggestion = last.indent + closingChar;

                // Don't suggest if the line already has the right content
                if (trimmed === closingChar) return { items: [] };

                return {
                    items: [{
                        insertText: suggestion,
                        range: new monaco.Range(
                            position.lineNumber, 1,
                            position.lineNumber, lineContent.length + 1
                        ),
                    }],
                };
            },
            disposeInlineCompletions() {},
        });

        const model = ed.getModel();
        if (model) {
            setLineCount(model.getLineCount());
            model.onDidChangeContent(() => {
                const value = ed.getValue();
                setContent(value);
                setLineCount(model.getLineCount());
                runBracketCheck(value);
            });

            // Apply initial bracket decorations
            const initialResult = validateBrackets(content);
            if (!initialResult.valid) {
                const newDecorations: editor.IModelDeltaDecoration[] = initialResult.errors.map(err => ({
                    range: new monaco.Range(err.line, 1, err.line, model.getLineMaxColumn(err.line)),
                    options: {
                        isWholeLine: true,
                        className: 'bracket-error-line',
                        glyphMarginClassName: 'bracket-error-glyph',
                        overviewRuler: {
                            color: '#ff4444',
                            position: monaco.editor.OverviewRulerLane.Right,
                        },
                    },
                }));
                decorationsRef.current = ed.deltaDecorations([], newDecorations);
            }

        }

        return () => {
            inlineProvider.dispose();
            ed.dispose();
            editorRef.current = null;
            decorationsRef.current = [];
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, error]);

    // Clean up bracket timer on unmount
    useEffect(() => {
        return () => {
            if (bracketCheckTimerRef.current) clearTimeout(bracketCheckTimerRef.current);
        };
    }, []);

    const handleSave = useCallback(async () => {
        // Block save if brackets are mismatched
        if (!bracketStatus.valid) {
            const firstError = bracketStatus.errors[0];
            showToast('error', `Cannot save: ${firstError.message} (line ${firstError.line})`);
            // Jump to the error line
            if (editorRef.current) {
                editorRef.current.revealLineInCenter(firstError.line);
                editorRef.current.setPosition({ lineNumber: firstError.line, column: firstError.column });
                editorRef.current.focus();
            }
            return;
        }

        try {
            setWorking('Saving BIN file...');
            await api.saveRitobinToBin(filePath, content, useJade);
            setOriginalContent(content);
            setReady('Saved');
            showToast('success', 'BIN file saved successfully');
        } catch (err) {
            console.error('[BinEditor] Save error:', err);
            const flintError = err as api.FlintError;
            showToast('error', flintError.getUserMessage?.() || 'Failed to save');
        }
    }, [filePath, content, useJade, setWorking, setReady, showToast, bracketStatus]);

    useEffect(() => {
        return () => {
            if (hoverTimerRef.current) clearTimeout(hoverTimerRef.current);
        };
    }, []);

    // Throttle to one inspection per animation frame. Monaco's
    // getTargetAtClientPoint walks line-widget DOM and is not free; firing it
    // every mousemove (~120Hz) for a feature that only matters when the user
    // *pauses* on an asset path was burning frame time.
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
        if (!pos?.position) {
            if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
            return;
        }

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
                hoverTimerRef.current = setTimeout(() => {
                    setPreviewAsset(stringValue);
                    setShowPreview(true);
                }, HOVER_DELAY_MS);
            }
        } else {
            if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
            lastHoveredAssetRef.current = null;
            setShowPreview(false);
        }
    }, []);

    const handleMouseMove = useCallback((e: React.MouseEvent<HTMLDivElement>) => {
        lastMoveRef.current = {
            x: e.clientX,
            y: e.clientY,
            target: e.target as HTMLElement,
        };
        if (moveRafRef.current === null) {
            moveRafRef.current = requestAnimationFrame(inspectHover);
        }
    }, [inspectHover]);

    useEffect(() => {
        return () => {
            if (moveRafRef.current !== null) {
                cancelAnimationFrame(moveRafRef.current);
                moveRafRef.current = null;
            }
        };
    }, []);

    const handleMouseLeave = useCallback(() => {
        if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
        lastHoveredAssetRef.current = null;
        setShowPreview(false);
    }, []);

    const handleClick = useCallback(() => {
        if (hoverTimerRef.current) { clearTimeout(hoverTimerRef.current); hoverTimerRef.current = null; }
        setShowPreview(false);
    }, []);

    const fileName = filePath.split('\\').pop() || filePath.split('/').pop() || 'file.bin';

    // Bracket status label for toolbar
    const bracketLabel = useMemo(() => {
        if (bracketStatus.valid) return null;
        const count = bracketStatus.errors.length;
        const idx = Math.min(bracketErrorIndex, count - 1);
        const err = bracketStatus.errors[idx];
        // For unclosed brackets, point to where the fix goes, not where it opened
        const displayLine = err.suggestLine !== err.line ? err.suggestLine : err.line;
        const suffix = err.suggestLine !== err.line ? `insert after line ${displayLine}` : `line ${displayLine}`;
        if (count === 1) return `Missing '${BRACKET_PAIRS[err.char] ?? err.char}' — ${suffix}`;
        return `Bracket error ${idx + 1}/${count} — ${suffix}`;
    }, [bracketStatus, bracketErrorIndex]);

    if (loading) {
        return (
            <div className="bin-editor__loading">
                <div className="spinner spinner--lg" />
                <span>Loading BIN file...</span>
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
                    {fileName}{isDirty ? ' \u2022' : ''}
                    <span className="bin-editor__stats">
                        {lineCount.toLocaleString()} lines
                    </span>
                    {bracketLabel && (
                        <span
                            className="bin-editor__bracket-error"
                            title={bracketStatus.errors.map((e, i) => `${i + 1}. Line ${e.line}: ${e.message}`).join('\n')}
                            onClick={() => {
                                const count = bracketStatus.errors.length;
                                const idx = Math.min(bracketErrorIndex, count - 1);
                                const err = bracketStatus.errors[idx];
                                if (err && editorRef.current) {
                                    // Navigate to where the fix goes, not where the opener is
                                    const navLine = err.suggestLine !== err.line ? err.suggestLine : err.line;
                                    const navCol = err.suggestLine !== err.line
                                        ? (editorRef.current.getModel()?.getLineMaxColumn(navLine) ?? 1)
                                        : err.column;
                                    editorRef.current.revealLineInCenter(navLine);
                                    editorRef.current.setPosition({ lineNumber: navLine, column: navCol });
                                    editorRef.current.focus();
                                }
                                setBracketErrorIndex((idx + 1) % count);
                            }}
                        >
                            {bracketLabel}
                        </span>
                    )}
                    {!bracketLabel && isDirty && (
                        <span className="bin-editor__bracket-ok">Brackets OK</span>
                    )}
                </span>
                <div className="bin-editor__toolbar-actions">
                    <button
                        className="btn btn--primary btn--sm"
                        onClick={handleSave}
                        disabled={!isDirty}
                        title={!bracketStatus.valid ? 'Fix bracket errors before saving' : undefined}
                    >
                        Save
                    </button>
                </div>
            </div>

            <div
                className="bin-editor__content"
                ref={containerRef}
                onMouseMove={handleMouseMove}
                onMouseLeave={handleMouseLeave}
                onClick={handleClick}
            >
                <div ref={editorContainerRef} style={{ width: '100%', height: '100%' }} />
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
