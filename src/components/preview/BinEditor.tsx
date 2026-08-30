import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
import { useAppMetadataStore, useFileEditorStore, useNotificationStore } from '../../lib/stores';
import { useUxStore } from '../../lib/stores/uxStore';
import { useProjectTabStore } from '../../lib/stores/projectTabStore';
import { editorSessionStore } from '../../lib/stores/editorSessionStore';
import * as api from '../../lib/api';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { deferCleanup } from '../../lib/ui-helpers/deferCleanup';
import {
    RITOBIN_LANGUAGE_ID,
    RITOBIN_THEME_ID,
    applyRitobinTheme,
    registerRitobinLanguage,
    registerRitobinTheme
} from '../../lib/editor/ritobinLanguage';
import { AssetPreviewTooltip } from './AssetPreviewTooltip';
import { MaskEditor } from './MaskEditor';
import { PaintPanel } from './paint/PaintPanel';
import { BinToolsPanel } from './bintools/BinToolsPanel';
import { applyContentToEditor } from '../../lib/editor/applyContent';
import { fileIssues, recheckFile } from '../../lib/audit/projectAudit';
import { indexNavigable, nextSystem, previousSystem } from '../../lib/editor/binTools/vfxIndex';
import { SubmeshPicker, type SubmeshPickerRequest } from './SubmeshPicker';
import { Icon } from '../ui/Icon';
import { useSearchPanelStore } from '../../lib/stores/searchPanelStore';
import { projectRootFromFilePath } from '../../lib/wadPath';
import { bracketStackAtLine } from '../../lib/editor/blockExtraction';
import { checkRitobinBrackets, type BracketCheckResult } from '../../lib/editor/bracketCheck';
import { colorizeRitobinLine } from '../../lib/editor/ritobinColorize';
import { resolvePreset } from '../../lib/editor/ritobinThemes';
import {
    REVEAL_LINE_EVENT,
    REVEAL_TEXT_EVENT,
    UNHASH_REQUEST_EVENT,
    isSameRevealTarget,
    takeRevealLine,
    type RevealLineDetail,
    type RevealTextDetail,
} from '../../lib/editor/binEditorEvents';

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

registerRitobinLanguage(monaco as any);
registerRitobinTheme(monaco as any);

const HOVER_DELAY_MS = 3000;

const BRACKET_CHECK_DEBOUNCE_MS = 300;

/** Marker owner for the audit findings, kept apart from any other producer. */
const AUDIT_MARKER_OWNER = 'flint-audit';

const PREVIEWABLE_EXTENSIONS = ['tex', 'dds', 'scb', 'sco', 'skn'];

function isPreviewableAssetPath(value: string): boolean {
    if (!value) return false;
    const ext = value.toLowerCase().split('.').pop() || '';
    return PREVIEWABLE_EXTENSIONS.includes(ext);
}

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
// Editor Options
// =============================================================================

const CLOSER_FOR: Record<string, string> = { '{': '}', '[': ']', '(': ')' };

const EDITOR_FONT_FAMILY =
    'var(--font-mono), "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace';
const EDITOR_LINE_HEIGHT = 20;

const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
    automaticLayout: true,
    fontFamily: EDITOR_FONT_FAMILY,
    fontSize: 13,
    lineHeight: EDITOR_LINE_HEIGHT,
    lineNumbers: 'on',
    lineNumbersMinChars: 5,
    minimap: { enabled: false },
    // Folding is bracket-derived: the ritobin language config declares
    // `brackets`, so Monaco's `auto` strategy builds `{ }` ranges with no
    // custom range provider. This also powers the Fold-all/Unfold-all emitter
    // buttons — `setEmittersFolded` reads regions off the folding
    // contribution, which computes nothing while folding is disabled.
    folding: true,
    foldingStrategy: 'auto',
    // Default is 'mouseover', which hides the gutter arrows until hover and
    // reads as "folding still doesn't work".
    showFoldingControls: 'always',
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
    autoIndent: 'brackets',
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
    /* The closing-bracket hint REPLACES the whole line (it re-indents), so it is not a prefix
       extension of what's typed. 'prefix' suppresses the ghost text in that case; 'subword' is
       the permissive mode that still renders it. */
    inlineSuggest: { enabled: true, mode: 'subword' },
    /* Lets Tab accept the hint on a line that is empty or all whitespace, instead of inserting
       an indent. Tab still indents normally once the line has content. */
    tabCompletion: 'on',
    contextmenu: true,
    accessibilitySupport: 'off',
};

function updateEmitterDecorations(
    ed: editor.IStandaloneCodeEditor,
    decorationIds: string[],
): string[] {
    const model = ed.getModel();
    if (!model) return decorationIds;
    const text = model.getValue();
    const lines = text.split('\n');
    const decorations: editor.IModelDeltaDecoration[] = [];
    const cssRules: string[] = [];

    for (let i = 0; i < lines.length; i++) {
        if (/VfxEmitterDefinitionData\s*\{/.test(lines[i])) {
            let depth = 0; let emitterName = '';
            for (let j = i; j < Math.min(i + 80, lines.length); j++) {
                for (const c of lines[j]) { if (c === '{') depth++; else if (c === '}') depth--; }
                const nm = lines[j].match(/emitterName:\s*string\s*=\s*"([^"]+)"/);
                if (nm) { emitterName = nm[1]; break; }
                if (depth <= 0 && j > i) break;
            }
            if (emitterName) {
                const lineNum = i + 1;
                const cls = `flint-emitter-hint-${lineNum}`;
                const escaped = emitterName.replace(/\\/g, '\\\\').replace(/"/g, '\\"');
                cssRules.push(`.${cls}::after { content: "  # ${escaped}"; color: #6a9955; font-style: italic; opacity: 0.75; }`);
                decorations.push({
                    range: { startLineNumber: lineNum, startColumn: 1, endLineNumber: lineNum, endColumn: 1 },
                    options: { afterContentClassName: cls, isWholeLine: true },
                });
            }
        }
    }

    let styleEl = document.getElementById('flint-emitter-hint-styles');
    if (!styleEl) { styleEl = document.createElement('style'); styleEl.id = 'flint-emitter-hint-styles'; document.head.appendChild(styleEl); }
    styleEl.textContent = cssRules.join('\n');
    return ed.deltaDecorations(decorationIds, decorations);
}

/* `display:block` keeps the glyph off the text baseline so the button's flex
   centering actually centers it — an inline SVG would sit low. */
function SaveIcon() {
    return (
        <svg width="14" height="14" viewBox="0 0 16 16" fill="currentColor" style={{ display: 'block' }} aria-hidden="true">
            <path d="M2 2h9.5L14 4.5V14H2V2zm2 1v4h7V3H4zm5 1h1.5v2H9V4zM4 9h8v4H4V9z" />
        </svg>
    );
}

// =============================================================================
// Component
// =============================================================================

interface BinEditorProps {
    filePath: string;
    hideFilename?: boolean;
}

export const BinEditor: React.FC<BinEditorProps> = ({ filePath, hideFilename }) => {
    const showToast = useNotificationStore((s) => s.showToast);
    const setWorking = useAppMetadataStore((s) => s.setWorking);
    const setReady = useAppMetadataStore((s) => s.setReady);

    const [content, setContent] = useState<string>('');
    const [originalContent, setOriginalContent] = useState<string>('');
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [lineCount, setLineCount] = useState(0);
    const minimapPref = useUxStore((s) => s.binEditorMinimap);
    const minimapMaxLines = useUxStore((s) => s.binEditorMinimapMaxLines);
    const wordWrapPref = useUxStore((s) => s.binEditorWordWrap);
    const fontSizePref = useUxStore((s) => s.binEditorFontSize);
    const autoSuggestionsPref = useUxStore((s) => s.binEditorAutoSuggestions);
    const autoUnhashPref = useUxStore((s) => s.binEditorAutoUnhash);
    const syntaxThemePref = useUxStore((s) => s.binEditorSyntaxTheme);
    const leapBarPref = useUxStore((s) => s.binEditorLeapBar);
    // Above the cap the preference is overridden, and the toggle is disabled.
    const minimapAllowed = lineCount <= minimapMaxLines;
    const minimapOn = minimapPref && minimapAllowed;
    const [sidePanelOpen, setSidePanelOpen] = useState(false);
    const searchOpen = useSearchPanelStore((s) => s.open);
    const toggleSearch = useSearchPanelStore((s) => s.toggle);
    const searchRoot = useMemo(() => projectRootFromFilePath(filePath), [filePath]);
    const [hasMaskMap, setHasMaskMap] = useState(false);
    const [maskEditorOpen, setMaskEditorOpen] = useState(false);
    const [hasVfx, setHasVfx] = useState(false);
    const [paintOpen, setPaintOpen] = useState(false);
    /* Submesh picker for `Submesh: string = "..."` lines. `line` is the line the
       CodeLens was clicked on; `names` empty with a `note` means the SKN could
       not be read, in which case the field stays free text. */
    const [submeshPicker, setSubmeshPicker] = useState<SubmeshPickerRequest | null>(null);

    /* Audit findings for this BIN — the same checks the WAD audit runs, surfaced on the
       lines they sit on so a crash risk is visible where it is authored. */
    const [auditIssues, setAuditIssues] = useState<api.CheckIssue[]>([]);
    const [auditIndex, setAuditIndex] = useState(0);

    const [bracketStatus, setBracketStatus] = useState<BracketCheckResult>({ valid: true, errors: [] });
    const [bracketErrorIndex, setBracketErrorIndex] = useState(0);
    const bracketCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const decorationsRef = useRef<string[]>([]);
    const emitterDecorationsRef = useRef<string[]>([]);

    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });
    const incrementFileVersion = useAppMetadataStore((state) => state.incrementFileVersion);

    const variant = 'ritoshark';

    const editorContainerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const openSubmeshPickerRef = useRef<(line: number) => void>(() => {});
    const submeshDecorationsRef = useRef<string[]>([]);

    const latestRef = useRef({ content: '', originalContent: '', fileVersion: 0, variant });
    latestRef.current = { content, originalContent, fileVersion, variant };

    /* The closing-bracket hint is only offered where a bracket is genuinely MISSING, so the
       inline-completion provider reads the latest check result. It runs inside a Monaco
       callback that closes over the first render's state, hence the ref. */
    const bracketStatusRef = useRef(bracketStatus);
    bracketStatusRef.current = bracketStatus;
    const saveRef = useRef<() => void>(() => {});

    const [previewAsset, setPreviewAsset] = useState<string | null>(null);
    const [previewPosition, setPreviewPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });
    const [showPreview, setShowPreview] = useState(false);
    const hoverTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const lastHoveredAssetRef = useRef<string | null>(null);
    const containerRef = useRef<HTMLDivElement | null>(null);

    const isDirty = content !== originalContent;
    const basePath = filePath.split(/[/\\]/).slice(0, -1).join('\\');

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

    const runBracketCheck = useCallback((text: string) => {
        if (bracketCheckTimerRef.current) clearTimeout(bracketCheckTimerRef.current);
        bracketCheckTimerRef.current = setTimeout(async () => {
            const result = checkRitobinBrackets(text);
            /* Update the ref HERE, not just on the next render: the inline-completion provider
               reads it, and Monaco re-queries the provider the instant the edit lands — long
               before React re-renders. Without this, deleting a `}` offered no hint until the
               caret left the line and came back. */
            bracketStatusRef.current = result;
            setBracketStatus(result);
            setBracketErrorIndex(0);

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

                emitterDecorationsRef.current = updateEmitterDecorations(ed, emitterDecorationsRef.current);

                /* Monaco asked the provider back when the edit landed, while this result was
                   still pending — so ask again now that we know a bracket is missing, provided
                   the caret is sitting where the closer belongs. */
                if (result.errors.length > 0 && ed.hasTextFocus()) {
                    const pos = ed.getPosition();
                    const text = pos ? model.getLineContent(pos.lineNumber) : null;
                    /* Mirror the provider's own gate: an empty line, or the caret parked at the
                       end of one (which is where you land right after backspacing a `}`). */
                    if (text !== null && pos && (text.trim().length === 0 || pos.column > text.length)) {
                        ed.trigger('flint', 'editor.action.inlineSuggest.trigger', {});
                    }
                }
            }
        }, BRACKET_CHECK_DEBOUNCE_MS);
    }, []);

    useEffect(() => {
        const cached = editorSessionStore.get(filePath);
        if (cached && cached.fileVersion === fileVersion && cached.variant === variant) {
            setContent(cached.content);
            setOriginalContent(cached.originalContent);
            setLineCount(cached.content.split('\n').length);
            setBracketStatus(checkRitobinBrackets(cached.content));
            setError(null);
            setLoading(false);
            return;
        }

        let cancelled = false;
        const loadBin = async () => {
            setLoading(true);
            setError(null);
            try {
                const text = await api.readOrConvertBin(filePath);
                if (cancelled) return;
                setContent(text);
                setOriginalContent(text);
                setLineCount(text.split('\n').length);
                const result = checkRitobinBrackets(text);
                setBracketStatus(result);
                editorSessionStore.save(filePath, { fileVersion, content: text, originalContent: text, variant });
            } catch (err) {
                if (cancelled) return;
                console.error('[BinEditor] Error:', err);
                setError((err as Error).message || 'Failed to load BIN file');
            } finally {
                if (!cancelled) setLoading(false);
            }
        };
        loadBin();
        return () => { cancelled = true; };
    }, [filePath, fileVersion, variant]);

    // Detect whether this BIN is an animation graph with a mask map, so the
    // Masks toggle only appears where there's actually something to edit.
    // `binHasAnimationMasks` is a dedicated cheap probe (read_bin only, no
    // skeleton resolution) rather than reusing `readAnimationMasks` here —
    // that keeps this check safe to run for every BIN opened in the editor
    // (VFX/material/mesh BINs included) and keeps a real animation-graph BIN
    // from being hidden just because its skeleton fails to resolve; that
    // failure is instead surfaced inside MaskEditor once the panel is opened.
    useEffect(() => {
        let cancelled = false;
        setHasMaskMap(false);
        setMaskEditorOpen(false);
        api.binHasAnimationMasks(filePath)
            .then((has) => { if (!cancelled) setHasMaskMap(has); })
            .catch(() => { if (!cancelled) setHasMaskMap(false); });
        return () => { cancelled = true; };
    }, [filePath]);

    // Same shape as the mask probe: a cheap class-hash scan decides whether the
    // Paint toggle appears, so a BIN with no VFX systems never shows it.
    useEffect(() => {
        let cancelled = false;
        setHasVfx(false);
        setPaintOpen(false);
        api.binHasVfxSystems(filePath)
            .then((has) => { if (!cancelled) setHasVfx(has); })
            .catch(() => { if (!cancelled) setHasVfx(false); });
        return () => { cancelled = true; };
    }, [filePath]);

    useEffect(() => {
        if (loading || error || !editorContainerRef.current) return;

        const ed = monaco.editor.create(editorContainerRef.current, {
            ...EDITOR_OPTIONS,
            minimap: { enabled: minimapOn },
            wordWrap: wordWrapPref ? 'on' : 'off',
            fontSize: fontSizePref,
            quickSuggestions: autoSuggestionsPref ? { other: 'on', comments: 'off', strings: 'off' } : false,
            suggestOnTriggerCharacters: autoSuggestionsPref,
            wordBasedSuggestions: autoSuggestionsPref ? 'currentDocument' : 'off',
            acceptSuggestionOnEnter: autoSuggestionsPref ? 'on' : 'off',
            parameterHints: { enabled: autoSuggestionsPref },
            value: content,
            language: RITOBIN_LANGUAGE_ID,
            theme: RITOBIN_THEME_ID,
        });

        editorRef.current = ed;

        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saveRef.current(); });

        const syncViewport = () => {
            const ranges = ed.getVisibleRanges();
            if (ranges.length === 0) return;
            setViewportEnd(ranges[ranges.length - 1].endLineNumber);
        };
        const scrollSub = ed.onDidScrollChange(syncViewport);
        syncViewport();

        // The leap row is laid out from Monaco's own measurements, not guessed
        // at, so its number / fold column / text land on the editor's columns.
        const syncLayout = () => {
            const l = ed.getLayoutInfo();
            setLayout({
                numbersLeft: l.lineNumbersLeft,
                numbersWidth: l.lineNumbersWidth,
                decorationsLeft: l.decorationsLeft,
                decorationsWidth: l.decorationsWidth,
                contentLeft: l.contentLeft,
                rightInset: l.minimap.minimapWidth + l.verticalScrollbarWidth,
            });
        };
        const layoutSub = ed.onDidLayoutChange(syncLayout);
        syncLayout();

        ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.BracketRight, () => stepSystemRef.current(true));
        ed.addCommand(monaco.KeyMod.Alt | monaco.KeyCode.BracketLeft, () => stepSystemRef.current(false));

        const restored = editorSessionStore.get(filePath);
        if (restored?.viewState && restored.fileVersion === fileVersion) {
            ed.restoreViewState(restored.viewState);
            ed.focus();
        }

        // A search hit in a linked BIN navigates here and stashes its line;
        // the restored view state above would otherwise win.
        const pendingLine = takeRevealLine(filePath);
        if (pendingLine !== null) {
            ed.revealLineInCenter(pendingLine);
            ed.setPosition({ lineNumber: pendingLine, column: 1 });
            ed.focus();
        }


        /* A small pencil glyph at the end of every `Submesh: string = "..."`
           line, opening the picker. Rendered as an `after` content decoration
           rather than a CodeLens: a lens occupies its own line above the row,
           which pushed each override block apart. */
        const refreshSubmeshDecorations = () => {
            const m = ed.getModel();
            if (!m) return;
            const decos: editor.IModelDeltaDecoration[] = [];
            for (let line = 1; line <= m.getLineCount(); line++) {
                if (!/^\s*Submesh:\s*string\s*=\s*"/.test(m.getLineContent(line))) continue;
                /* Same shape as the emitter-name hints above: a whole-line
                   decoration whose `afterContentClassName` carries a CSS
                   `::after { content }`. The injected-text form
                   (`after: { content }`) did not render in this editor. */
                decos.push({
                    range: new monaco.Range(line, 1, line, 1),
                    options: { isWholeLine: true, afterContentClassName: 'bin-submesh-pick' },
                });
            }
            submeshDecorationsRef.current = ed.deltaDecorations(submeshDecorationsRef.current, decos);
        };
        refreshSubmeshDecorations();

        /* The glyph is a ::after on a span carrying `bin-submesh-pick`, so the
           click can land on that span or a descendant — match with `closest`
           rather than a direct classList check. */
        const submeshClick = ed.onMouseDown((e) => {
            const el = e.event.target as HTMLElement | null;
            if (!el?.closest?.('.bin-submesh-pick')) return;
            const line = e.target.position?.lineNumber;
            if (!line) return;
            e.event.preventDefault();
            e.event.stopPropagation();
            void openSubmeshPickerRef.current(line);
        });

        const inlineProvider = monaco.languages.registerInlineCompletionsProvider(RITOBIN_LANGUAGE_ID, {
            provideInlineCompletions(model, position) {
                const lineContent = model.getLineContent(position.lineNumber);
                const trimmed = lineContent.trim();
                if (trimmed.length > 0 && position.column <= lineContent.length) return { items: [] };

                /* Only offer a closer where one is actually MISSING. The old check was "is any
                   block open here", which is true on every blank line inside a nested structure
                   — so a complete file suggested a spurious `}` everywhere. The bracket checker
                   already knows which blocks are unclosed and where their closer belongs. */
                const unclosed = bracketStatusRef.current.errors.find(
                    (e) => e.suggestLine === position.lineNumber - 1 || e.suggestLine === position.lineNumber,
                );
                if (!unclosed) return { items: [] };

                const fullText = model.getValue();
                const stack = bracketStackAtLine(fullText, position.lineNumber);
                if (stack.length === 0) return { items: [] };
                const last = stack[stack.length - 1];
                const closingChar = CLOSER_FOR[last.char];
                const suggestion = last.indent + closingChar;
                if (trimmed === closingChar) return { items: [] };
                return {
                    items: [{ insertText: suggestion, range: new monaco.Range(position.lineNumber, 1, position.lineNumber, lineContent.length + 1) }],
                };
            },
            disposeInlineCompletions() {},
        });

        /* Monaco only re-queries inline completions on a CONTENT change, so simply moving the
           caret onto a blank line showed nothing until you typed and deleted a character. The
           hint depends on cursor position, not on edits, so ask for it again whenever the line
           changes and the caret sits on an empty line. */
        let lastHintLine = -1;
        const cursorMove = ed.onDidChangeCursorPosition((e) => {
            const lineNo = e.position.lineNumber;
            if (lineNo === lastHintLine) return;
            lastHintLine = lineNo;
            if (bracketStatusRef.current.valid) return;
            const m = ed.getModel();
            if (!m || m.getLineContent(lineNo).trim().length > 0) return;
            ed.trigger('flint', 'editor.action.inlineSuggest.trigger', {});
        });

        const model = ed.getModel();
        if (model) {
            setLineCount(model.getLineCount());
            model.onDidChangeContent(() => {
                const value = ed.getValue();
                setContent(value);
                setLineCount(model.getLineCount());
                runBracketCheck(value);
                refreshSubmeshDecorations();
            });

            const initialResult = checkRitobinBrackets(content);
            if (!initialResult.valid) {
                const newDecorations: editor.IModelDeltaDecoration[] = initialResult.errors.map(err => ({
                    range: new monaco.Range(err.line, 1, err.line, model.getLineMaxColumn(err.line)),
                    options: {
                        isWholeLine: true,
                        className: 'bracket-error-line',
                        glyphMarginClassName: 'bracket-error-glyph',
                        overviewRuler: { color: '#ff4444', position: monaco.editor.OverviewRulerLane.Right },
                    },
                }));
                decorationsRef.current = ed.deltaDecorations([], newDecorations);
            }

            emitterDecorationsRef.current = updateEmitterDecorations(ed, []);
        }

        return () => {
            const L = latestRef.current;
            editorSessionStore.save(filePath, {
                fileVersion: L.fileVersion,
                content: L.content,
                originalContent: L.originalContent,
                variant: L.variant,
                viewState: ed.saveViewState(),
            });
            editorRef.current = null;
            decorationsRef.current = [];
            emitterDecorationsRef.current = [];
            const styleEl = document.getElementById('flint-emitter-hint-styles');
            if (styleEl) styleEl.textContent = '';
            deferCleanup(() => {
                inlineProvider.dispose();
                scrollSub.dispose();
                layoutSub.dispose();
                cursorMove.dispose();
                submeshClick.dispose();
                ed.dispose();
            });
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, error]);

    // Apply minimap & editor options changes in place. The editor-creation effect
    // must not depend on these preferences — re-running it would dispose the model
    // and the undo stack — so toggling is pushed through updateOptions instead.
    useEffect(() => {
        editorRef.current?.updateOptions({ minimap: { enabled: minimapOn } });
    }, [minimapOn]);

    useEffect(() => {
        editorRef.current?.updateOptions({
            quickSuggestions: autoSuggestionsPref ? { other: 'on', comments: 'off', strings: 'off' } : false,
            suggestOnTriggerCharacters: autoSuggestionsPref,
            wordBasedSuggestions: autoSuggestionsPref ? 'currentDocument' : 'off',
            acceptSuggestionOnEnter: autoSuggestionsPref ? 'on' : 'off',
            parameterHints: { enabled: autoSuggestionsPref },
        });
    }, [autoSuggestionsPref]);

    useEffect(() => {
        editorRef.current?.updateOptions({ wordWrap: wordWrapPref ? 'on' : 'off' });
    }, [wordWrapPref]);

    useEffect(() => {
        editorRef.current?.updateOptions({ fontSize: fontSizePref });
    }, [fontSizePref]);

    useEffect(() => {
        if (editorRef.current) {
            applyRitobinTheme(monaco as any, syntaxThemePref);
        }
    }, [syntaxThemePref]);

    useEffect(() => {
        return () => { if (bracketCheckTimerRef.current) clearTimeout(bracketCheckTimerRef.current); };
    }, []);

    useEffect(() => {
        if (!searchRoot || loading || error) { setAuditIssues([]); return; }
        let cancelled = false;
        fileIssues(searchRoot, filePath)
            .then((found) => { if (!cancelled) { setAuditIssues(found); setAuditIndex(0); } })
            .catch((e) => { console.debug('[bin-editor] audit failed:', e); });
        return () => { cancelled = true; };
    }, [searchRoot, filePath, fileVersion, loading, error]);

    /* Markers, not decorations: they carry the message in the hover and paint the
       overview ruler for free, and they live under their own owner so the bracket
       decorations above cannot clobber them. A finding with no line is reported by
       the toolbar chip instead of being parked on line 1. */
    useEffect(() => {
        const model = editorRef.current?.getModel();
        if (!model) return;
        monaco.editor.setModelMarkers(
            model,
            AUDIT_MARKER_OWNER,
            auditIssues
                .filter((issue) => issue.line && issue.line <= model.getLineCount())
                .map((issue) => ({
                    severity: issue.severity === 'critical'
                        ? monaco.MarkerSeverity.Error
                        : monaco.MarkerSeverity.Warning,
                    message: issue.expected
                        ? `${issue.message}\n\nExpected: ${issue.expected}`
                        : issue.message,
                    source: issue.code,
                    startLineNumber: issue.line!,
                    startColumn: 1,
                    endLineNumber: issue.line!,
                    endColumn: model.getLineMaxColumn(issue.line!),
                })),
        );
        return () => {
            const m = editorRef.current?.getModel();
            if (m) monaco.editor.setModelMarkers(m, AUDIT_MARKER_OWNER, []);
        };
    }, [auditIssues, loading, error]);

    const handleSave = useCallback(async () => {
        if (!bracketStatus.valid) {
            const firstError = bracketStatus.errors[0];
            showToast('error', `Cannot save: ${firstError.message} (line ${firstError.line})`);
            if (editorRef.current) {
                editorRef.current.revealLineInCenter(firstError.line);
                editorRef.current.setPosition({ lineNumber: firstError.line, column: firstError.column });
                editorRef.current.focus();
            }
            return;
        }

        try {
            setWorking('Saving BIN file...');
            await api.saveRitobinToBin(filePath, content);
            setOriginalContent(content);
            setReady('Saved');
            showToast('success', 'BIN file saved successfully');

            const tabStore = useProjectTabStore.getState();
            const tab = tabStore.activeTabId ? tabStore.openTabs.find((t) => t.id === tabStore.activeTabId) : null;
            if (tab?.projectPath) recheckFile(tab.projectPath, filePath);
            if (tab?.project && tab.projectPath) {
                const projPath = tab.projectPath.replace(/\\/g, '/');
                const normalizedFile = filePath.replace(/\\/g, '/');
                if (normalizedFile.startsWith(projPath + '/')) {
                    const relPath = normalizedFile.slice(projPath.length + 1);
                    api.syncChromaBins(tab.projectPath, relPath, tab.project.champion, tab.project.skin_id)
                        .then((synced) => {
                            if (synced.length > 0) showToast('info', `Synced ${synced.length} chroma BIN${synced.length === 1 ? '' : 's'}`);
                        }).catch(() => {});
                }
            }
        } catch (err) {
            console.error('[BinEditor] Save error:', err);
            const flintError = err as api.FlintError;
            const msg = flintError.getUserMessage?.() || String(err) || 'Failed to save';

            const lineMatch = /line\s+(\d+)/i.exec(msg);
            if (lineMatch && editorRef.current) {
                const line = parseInt(lineMatch[1], 10);
                const ed = editorRef.current;
                const maxLine = ed.getModel()?.getLineCount() ?? line;
                const target = Math.min(Math.max(line, 1), maxLine);
                ed.revealLineInCenter(target);
                ed.setPosition({ lineNumber: target, column: 1 });
                ed.focus();
                showToast('error', `Save failed at line ${line}: ${msg.replace(/^.*?at line \d+:\s*/i, '')}`);
            } else {
                showToast('error', msg);
            }
            setReady('Save failed');
        }
    }, [filePath, content, setWorking, setReady, showToast, bracketStatus]);
    saveRef.current = handleSave;

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

    const handleFixBracket = useCallback(() => {
        const err = bracketStatus.errors[0];
        if (!err || !editorRef.current) return;
        const model = editorRef.current.getModel();
        if (!model) return;
        const targetLine = err.suggestLine;
        const lineContent = model.getLineContent(targetLine);
        const indent = lineContent.match(/^(\s*)/)?.[1] ?? '';
        const closingChar = CLOSER_FOR[err.char] ?? err.char;
        const insertText = '\n' + indent + closingChar;
        const col = model.getLineMaxColumn(targetLine);
        model.pushEditOperations([], [{
            range: new monaco.Range(targetLine, col, targetLine, col),
            text: insertText,
        }], () => null);
        editorRef.current.revealLineInCenter(targetLine + 1);
        editorRef.current.focus();
    }, [bracketStatus]);

    /** Re-entry guard for the unhash pass. A ref, not state: the trigger lives
     *  in a sibling component, so nothing here re-renders to disable it. */
    const unhashingRef = useRef(false);

    /* Resolve the SKN this BIN drives (its `simpleSkin` asset path) and read the
       material-range names off it. Any failure returns a note instead of throwing
       so the picker can fall back to plain text editing. */
    const openSubmeshPicker = useCallback(async (line: number) => {
        const ed = editorRef.current;
        const model = ed?.getModel();
        if (!model) return;

        const current = model.getLineContent(line).match(/"([^"]*)"/)?.[1] ?? '';
        const simpleSkin = model.getValue().match(/simpleSkin:\s*(?:string|file)\s*=\s*"([^"]+)"/i)?.[1];

        if (!simpleSkin) {
            setSubmeshPicker({ line, current, names: [], note: 'This BIN has no simpleSkin field, so no mesh could be located.' });
            return;
        }

        try {
            const sknPath = await api.resolveAssetPath(simpleSkin, filePath);
            if (!sknPath) throw new Error('unresolved');
            const names = await api.readSknSubmeshNames(sknPath);
            setSubmeshPicker({
                line,
                current,
                names,
                note: names.length === 0 ? 'The mesh reported no submeshes.' : null,
            });
        } catch {
            setSubmeshPicker({ line, current, names: [], note: `Could not read the mesh at "${simpleSkin}".` });
        }
    }, [filePath]);

    /* The CodeLens command is registered once with the editor, so it calls
       through a ref rather than capturing the first render's closure. */
    openSubmeshPickerRef.current = openSubmeshPicker;

    const applySubmeshName = useCallback((line: number, name: string) => {
        const ed = editorRef.current;
        const model = ed?.getModel();
        if (!ed || !model) return;
        const text = model.getLineContent(line);
        const match = text.match(/"([^"]*)"/);
        if (!match || match.index === undefined) return;
        const startCol = match.index + 2;
        ed.executeEdits('flint.submeshPicker', [{
            range: new monaco.Range(line, startCol, line, startCol + match[1].length),
            text: name,
        }]);
        setSubmeshPicker(null);
        ed.focus();
    }, []);

    const handleUnhash = useCallback(async () => {
        const ed = editorRef.current;
        if (!ed) return;
        // The trigger now lives in the preview panel's info bar, which has no
        // disabled state tied to this component — so the guard has to be here,
        // or a double-click would run two passes over the same text.
        if (unhashingRef.current) return;
        const current = ed.getModel()?.getValue() ?? content;
        try {
            unhashingRef.current = true;
            setWorking('Unhashing BIN...');
            const { text: unhashed, replaced } = await api.unhashBinText(current);
            if (replaced === 0) {
                showToast('info', 'No resolvable hashes found');
                setReady('Ready');
                return;
            }
            // Single undoable edit; the change listener syncs React `content`.
            applyContentToEditor(ed, unhashed);
            setReady(`Unhashed ${replaced}`);
            showToast('success', `Unhashed ${replaced} hash${replaced === 1 ? '' : 'es'}`);
        } catch (err) {
            showToast('error', `Unhash failed: ${String(err)}`);
            setReady('Ready');
        } finally {
            unhashingRef.current = false;
        }
    }, [content, setWorking, setReady, showToast]);

    /* Unhash lives in the preview panel's bottom info bar (next to Jade/Quartz),
       which is a sibling component, so it reaches the editor through a window
       event rather than by lifting the whole editor's state up. The listener is
       filtered by path so a second open editor never runs someone else's edit. */
    const unhashRef = useRef(handleUnhash);
    unhashRef.current = handleUnhash;
    useEffect(() => {
        const onRequest = (e: Event) => {
            const detail = (e as CustomEvent<{ filePath: string }>).detail;
            if (detail?.filePath !== filePath) return;
            void unhashRef.current();
        };
        window.addEventListener(UNHASH_REQUEST_EVENT, onRequest);
        return () => window.removeEventListener(UNHASH_REQUEST_EVENT, onRequest);
    }, [filePath]);

    const goToLine = useCallback((line: number) => {
        const ed = editorRef.current;
        if (!ed) return;
        // Near the top, not centred: a block header reads as a heading for what
        // follows it, the same way clicking a sticky-scroll line behaves.
        ed.revealLineNearTop(line);
        ed.setPosition({ lineNumber: line, column: 1 });
        ed.focus();
    }, []);

    const stepSystem = useCallback((forward: boolean) => {
        const ed = editorRef.current;
        const model = ed?.getModel();
        if (!ed || !model) return;
        const blocks = indexNavigable(model.getValue()).blocks;
        const ranges = ed.getVisibleRanges();
        const from = ranges.length > 0
            ? (forward ? ranges[ranges.length - 1].endLineNumber : ranges[0].startLineNumber)
            : (ed.getPosition()?.lineNumber ?? 0);
        const target = forward
            ? (blocks.find((b) => b.line > from) ?? nextSystem(blocks, from))
            : ([...blocks].reverse().find((b) => b.line < from) ?? previousSystem(blocks, from));
        if (target) goToLine(target.line);
    }, [goToLine]);
    const stepSystemRef = useRef(stepSystem);
    stepSystemRef.current = stepSystem;

    const navigable = useMemo(() => indexNavigable(content), [content]);
    const systems = navigable.blocks;
    /* Monaco's sticky scroll pins the blocks you are INSIDE to the top. This bar
       is the other half: the block coming up NEXT below the viewport. It follows
       the VIEWPORT, not the cursor — the cursor stays on line 1 until you click,
       which would pin the bar to the first block no matter where you scrolled. */
    const [viewportEnd, setViewportEnd] = useState(1);
    const [layout, setLayout] = useState({
        numbersLeft: 0,
        numbersWidth: 0,
        decorationsLeft: 0,
        decorationsWidth: 0,
        contentLeft: 0,
        rightInset: 0,
    });
    const upcomingIndex = useMemo(
        () => systems.findIndex((s) => s.line > viewportEnd),
        [systems, viewportEnd],
    );
    const upcoming = upcomingIndex >= 0 ? systems[upcomingIndex] : null;
    const blockNoun = navigable.kind === 'system' ? 'VFX system' : 'entry';

    /* One row, drawn as an EDITOR LINE — the block's own source text, the
       editor's font, Monaco's columns, the theme's colours. Anything else reads
       as a toolbar bolted under the editor instead of as sticky scroll. */
    const leapRow = useMemo(() => {
        if (!leapBarPref || !upcoming) return null;
        const text = content.split('\n')[upcoming.line - 1] ?? upcoming.label;
        return {
            line: upcoming.line,
            label: upcoming.label,
            spans: colorizeRitobinLine(monaco, text, syntaxThemePref),
        };
    }, [leapBarPref, syntaxThemePref, content, upcoming]);

    const leapColors = useMemo(() => {
        const preset = resolvePreset(syntaxThemePref);
        return {
            background: preset.colors['editor.background'],
            hover: preset.colors['editor.lineHighlightBackground'],
            lineNumber: preset.colors['editorLineNumber.foreground'],
        };
    }, [syntaxThemePref]);

    /* Auto-unhash runs once per opened file, keyed on the path — not on
       `content`, which the pass itself rewrites. */
    const autoUnhashedRef = useRef<string | null>(null);
    useEffect(() => {
        if (!autoUnhashPref || loading || !content) return;
        if (autoUnhashedRef.current === filePath) return;
        autoUnhashedRef.current = filePath;
        void unhashRef.current();
    }, [autoUnhashPref, loading, content, filePath]);

    useEffect(() => {
        editorRef.current?.updateOptions({
            wordWrap: wordWrapPref ? 'on' : 'off',
            fontSize: fontSizePref,
        });
    }, [wordWrapPref, fontSizePref]);

    useEffect(() => {
        applyRitobinTheme(monaco as never, syntaxThemePref);
    }, [syntaxThemePref]);

    /* Reveal a name in the text — the Paint panel's double-click gesture. The
       search runs over the live model (not React `content`) so it lands on the
       right line even with unsaved edits above it. */
    useEffect(() => {
        const onReveal = (e: Event) => {
            const detail = (e as CustomEvent<RevealTextDetail>).detail;
            if (detail?.filePath !== filePath) return;
            const ed = editorRef.current;
            const model = ed?.getModel();
            if (!ed || !model || !detail.needle) return;

            // Quoted first: emitter/particle names are string VALUES in ritobin,
            // so the quoted form pins the definition rather than a stray mention.
            const match =
                model.findMatches(`"${detail.needle}"`, true, false, true, null, false, 1)[0] ??
                model.findMatches(detail.needle, true, false, true, null, false, 1)[0];
            if (!match) {
                showToast('info', `"${detail.needle}" not found in the text`);
                return;
            }
            ed.revealRangeInCenter(match.range);
            ed.setSelection(match.range);
            ed.focus();
        };
        window.addEventListener(REVEAL_TEXT_EVENT, onReveal);
        return () => window.removeEventListener(REVEAL_TEXT_EVENT, onReveal);
    }, [filePath, showToast]);

    useEffect(() => {
        const onRevealLine = (e: Event) => {
            const detail = (e as CustomEvent<RevealLineDetail>).detail;
            if (!detail || !isSameRevealTarget(detail.filePath, filePath)) return;
            const ed = editorRef.current;
            if (!ed) return;
            takeRevealLine(filePath);
            ed.revealLineInCenter(detail.line);
            ed.setPosition({ lineNumber: detail.line, column: 1 });
            ed.focus();
        };
        window.addEventListener(REVEAL_LINE_EVENT, onRevealLine);
        return () => window.removeEventListener(REVEAL_LINE_EVENT, onRevealLine);
    }, [filePath]);

    // Split on BOTH separators in one pass. Chaining `split('\\') || split('/')`
    // never reaches the second branch: on a forward-slash path the first split
    // returns [wholePath], whose `pop()` is truthy, so the whole path leaked
    // through as the "basename" and blew the toolbar past its buttons.
    const fileName = filePath.split(/[/\\]/).pop() || 'file.bin';

    const bracketLabel = useMemo(() => {
        if (bracketStatus.valid) return null;
        const count = bracketStatus.errors.length;
        const idx = Math.min(bracketErrorIndex, count - 1);
        const err = bracketStatus.errors[idx];
        const displayLine = err.suggestLine !== err.line ? err.suggestLine : err.line;
        const suffix = err.suggestLine !== err.line ? `insert after line ${displayLine}` : `line ${displayLine}`;
        if (count === 1) {
            // A surplus closer reports AT the offending line; an unclosed block reports at its
            // header and points forward, so suggestLine differs from line.
            if (err.suggestLine === err.line) return `Unexpected '${err.char}' — line ${err.line}`;
            return `Missing '${CLOSER_FOR[err.char] ?? err.char}' — ${suffix}`;
        }
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
                    {!hideFilename && (
                        <span className="bin-editor__filename-text" title={filePath}>
                            {fileName}{isDirty ? ' \u2022' : ''}
                        </span>
                    )}
                    <button
                        className={`bin-editor__chip bin-editor__chip--ghost${searchOpen ? ' bin-editor__chip--on' : ''}`}
                        onClick={() => toggleSearch(filePath)}
                        disabled={!searchRoot}
                        title={searchRoot
                            ? 'Find and replace across every BIN in this project'
                            : 'This BIN is not inside a Flint project'}
                    >
                        <Icon className="bin-editor__chip-icon" name="search" />
                    </button>
                    <span className="bin-editor__stats" style={{ marginLeft: 0 }}>
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
                    {auditIssues.length > 0 && (
                        <span
                            className={`bin-editor__audit${auditIssues.some((i) => i.severity === 'critical') ? ' bin-editor__audit--critical' : ''}`}
                            title={auditIssues
                                .map((i, n) => `${n + 1}. ${i.line ? `Line ${i.line}: ` : ''}${i.message}${i.expected ? ` (expected ${i.expected})` : ''}`)
                                .join('\n')}
                            onClick={() => {
                                const placed = auditIssues.filter((i) => i.line);
                                if (!placed.length || !editorRef.current) return;
                                const idx = auditIndex % placed.length;
                                const line = placed[idx].line!;
                                editorRef.current.revealLineInCenter(line);
                                editorRef.current.setPosition({ lineNumber: line, column: 1 });
                                editorRef.current.focus();
                                setAuditIndex((idx + 1) % placed.length);
                            }}
                        >
                            {auditIssues.length} {auditIssues.length === 1 ? 'issue' : 'issues'}
                        </span>
                    )}
                </span>
                <div className="bin-editor__toolbar-actions">
                    {!bracketStatus.valid && (
                        <button
                            className="btn btn--icon"
                            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--warning, #f0a020)' }}
                            onClick={handleFixBracket}
                            title="Insert missing closing bracket at suggested position"
                        >
                            {'}'}
                        </button>
                    )}
                    <button
                        className={`btn btn--icon${sidePanelOpen ? ' btn--primary' : ''}`}
                        style={!sidePanelOpen ? { background: 'var(--bg-tertiary)', border: '1px solid var(--border)' } : undefined}
                        onClick={() => setSidePanelOpen(!sidePanelOpen)}
                        title="Toggle BIN tools panel (skinScale, materialOverride, VFX)"
                    >
                        <Icon name="settings" />
                    </button>
                    {hasMaskMap && (
                        <button
                            className={`btn btn--icon${maskEditorOpen ? ' btn--primary' : ''}`}
                            style={!maskEditorOpen ? { background: 'var(--bg-tertiary)', border: '1px solid var(--border)' } : undefined}
                            onClick={() => setMaskEditorOpen(!maskEditorOpen)}
                            title="Toggle animation mask weight editor"
                        >
                            <Icon name="contrast" />
                        </button>
                    )}
                    {hasVfx && (
                        <button
                            className={`btn btn--icon${paintOpen ? ' btn--primary' : ''}`}
                            style={!paintOpen ? { background: 'var(--bg-tertiary)', border: '1px solid var(--border)' } : undefined}
                            onClick={() => setPaintOpen(!paintOpen)}
                            title="Toggle VFX paint (recolor emitters and materials)"
                        >
                            <Icon name="texture" />
                        </button>
                    )}
                    <button
                        className="btn btn--icon"
                        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
                        onClick={() => void handleUnhash()}
                        title="Unhash: re-resolve any 0x… hash tokens against the known BIN hash dictionary"
                    >
                        <Icon name="target" />
                    </button>
                    <button
                        className="btn btn--primary btn--icon"
                        onClick={handleSave}
                        disabled={!isDirty}
                        title={!bracketStatus.valid ? 'Fix bracket errors before saving' : 'Save (Ctrl+S)'}
                    >
                        <SaveIcon />
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

                    {/* Monaco's sticky scroll pins the blocks you are INSIDE to
                        the TOP. This is its mirror along the BOTTOM: the blocks
                        coming up next, drawn as their own source lines. */}
                    {leapRow && (
                        <button
                            className="bin-editor__leap"
                            onClick={() => goToLine(leapRow.line)}
                            title={`Leap to ${blockNoun}: ${leapRow.label} — line ${leapRow.line}`}
                            style={{
                                right: layout.rightInset,
                                height: EDITOR_LINE_HEIGHT,
                                fontFamily: EDITOR_FONT_FAMILY,
                                fontSize: fontSizePref,
                                lineHeight: `${EDITOR_LINE_HEIGHT}px`,
                                background: leapColors.background,
                                ['--leap-hover' as string]: leapColors.hover,
                            }}
                        >
                            <span
                                className="bin-editor__leap-num"
                                style={{
                                    left: layout.numbersLeft,
                                    width: layout.numbersWidth,
                                    color: leapColors.lineNumber,
                                }}
                            >
                                {leapRow.line}
                            </span>
                            <span
                                className="bin-editor__leap-chev"
                                style={{
                                    left: layout.decorationsLeft,
                                    width: layout.decorationsWidth,
                                    color: leapColors.lineNumber,
                                }}
                            >
                                <Icon name="chevronDown" />
                            </span>
                            <span
                                className="bin-editor__leap-text"
                                style={{ paddingLeft: layout.contentLeft }}
                            >
                                {leapRow.spans.map((span, i) => (
                                    <span key={i} style={{ color: span.color }}>{span.text}</span>
                                ))}
                            </span>
                        </button>
                    )}
                </div>

                {sidePanelOpen && (
                    <BinToolsPanel
                        content={content}
                        filePath={filePath}
                        onContentChange={(newContent) => {
                            setContent(newContent);
                            runBracketCheck(newContent);
                        }}
                        editorRef={editorRef}
                        onClose={() => setSidePanelOpen(false)}
                    />
                )}

                {maskEditorOpen && hasMaskMap && (
                    <div
                        style={{
                            position: 'absolute',
                            inset: 0,
                            zIndex: 40,
                            background: 'var(--bg-secondary)',
                        }}
                    >
                        <MaskEditor binPath={filePath} />
                    </div>
                )}

                {paintOpen && hasVfx && (
                    /* No inline background here — the panel paints its own, so
                       an opaque layer underneath would defeat its glass. */
                    <div
                        className="bin-editor__paint-overlay"
                        style={{ position: 'absolute', inset: 0, zIndex: 40 }}
                    >
                        <PaintPanel
                            binPath={filePath}
                            /* Paint writes the BIN directly and drops the
                               .ritobin sidecar, so the cached editor text is
                               now stale — bump the version to force a
                               re-decode from disk. */
                            onSaved={() => incrementFileVersion(filePath)}
                            onClose={() => setPaintOpen(false)}
                        />
                    </div>
                )}
            </div>

            {submeshPicker && (
                <SubmeshPicker
                    request={submeshPicker}
                    onPick={applySubmeshName}
                    onClose={() => setSubmeshPicker(null)}
                />
            )}

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
