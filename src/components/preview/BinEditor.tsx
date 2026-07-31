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
    registerRitobinLanguage,
    registerRitobinTheme
} from '../../lib/editor/ritobinLanguage';
import { AssetPreviewTooltip } from './AssetPreviewTooltip';
import { MaskEditor } from './MaskEditor';
import { SubmeshPicker, type SubmeshPickerRequest } from './SubmeshPicker';

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

            if (!inString) {
                if (ch === '#') { isComment = true; break; }
                if (ch === '/' && col + 1 < line.length && line[col + 1] === '/') {
                    isComment = true;
                    break;
                }
            }

            if (ch === '"' && (col === 0 || line[col - 1] !== '\\')) {
                inString = !inString;
                continue;
            }

            if (inString || isComment) continue;

            if (BRACKET_PAIRS[ch]) {
                stack.push({ char: ch, line: lineIdx + 1, column: col + 1 });
            }
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

    for (let i = stack.length - 1; i >= 0; i--) {
        const unclosed = stack[i];
        const openerLineIdx = unclosed.line - 1;
        const openerIndent = lines[openerLineIdx].match(/^(\s*)/)?.[1].length ?? 0;

        let blockEnd = openerLineIdx;
        for (let j = openerLineIdx + 1; j < lines.length; j++) {
            const trimmed = lines[j].trim();
            if (trimmed === '' || trimmed.startsWith('#') || trimmed.startsWith('//')) continue;
            const indent = lines[j].match(/^(\s*)/)?.[1].length ?? 0;
            if (indent <= openerIndent) break;
            blockEnd = j;
        }
        const suggestLine = blockEnd + 1;

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

/** Monaco renders the WHOLE document into the minimap canvas, which is what
 *  degrades on very large VFX bins — so the minimap is force-disabled above
 *  this many lines regardless of the user preference. Folding is NOT capped:
 *  bracket-range computation is cheap. */
const MINIMAP_MAX_LINES = 150_000;

const EDITOR_OPTIONS: editor.IStandaloneEditorConstructionOptions = {
    automaticLayout: true,
    fontFamily: 'var(--font-mono), "Cascadia Code", "Fira Code", Consolas, "Courier New", monospace',
    fontSize: 13,
    lineHeight: 20,
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
    inlineSuggest: { enabled: true, mode: 'prefix' },
    contextmenu: true,
    accessibilitySupport: 'off',
};

// =============================================================================
// Side Panel — skinScale, materialOverride, VFX helpers
// =============================================================================

/** Apply new content in a single undoable edit (preserves cursor). */
function applyContentToEditor(
    ed: editor.IStandaloneCodeEditor,
    newContent: string,
) {
    const model = ed.getModel();
    if (!model) return;
    const full = model.getFullModelRange();
    model.pushEditOperations([], [{ range: full, text: newContent }], () => null);
}

function parseSkinScale(text: string): { value: string; exists: boolean } {
    for (const line of text.split('\n')) {
        const t = line.trim().toLowerCase();
        if (t.startsWith('skinscale:')) {
            const colonIdx = line.indexOf(':');
            let vPart = line.substring(colonIdx + 1).trim();
            if (vPart.includes('=')) vPart = vPart.substring(vPart.indexOf('=') + 1).trim();
            return { value: vPart, exists: true };
        }
    }
    return { value: '1.0', exists: false };
}

function applySkinScaleToText(text: string, newVal: string): string {
    const lines = text.split('\n');
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].trim().toLowerCase().startsWith('skinscale:')) {
            const colonIdx = lines[i].indexOf(':');
            const afterColon = lines[i].substring(colonIdx + 1).trim();
            if (afterColon.includes('=')) {
                const eqIdx = lines[i].indexOf('=', colonIdx);
                lines[i] = lines[i].substring(0, eqIdx + 1) + ' ' + newVal;
            } else {
                lines[i] = lines[i].substring(0, colonIdx + 1) + ' ' + newVal;
            }
            return lines.join('\n');
        }
    }
    const out: string[] = [];
    let added = false;
    for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        if (!added && lines[i].includes('skinMeshProperties:') && lines[i].includes('SkinMeshDataProperties')) {
            let indent = '        ';
            if (i + 1 < lines.length) { const m = lines[i + 1].match(/^(\s*)/); if (m) indent = m[1]; }
            out.push(`${indent}skinScale: f32 = ${newVal}`);
            added = true;
        }
    }
    return out.join('\n');
}

function ensureMaterialOverride(text: string): string {
    if (text.includes('materialOverride:')) return text;
    const lines = text.split('\n');
    const out: string[] = [];
    let added = false;
    for (let i = 0; i < lines.length; i++) {
        out.push(lines[i]);
        if (!added && lines[i].includes('skinMeshProperties:') && lines[i].includes('SkinMeshDataProperties')) {
            let indent = '        ';
            if (i + 1 < lines.length) { const m = lines[i + 1].match(/^(\s*)/); if (m) indent = m[1]; }
            out.push(`${indent}materialOverride: list[embed] = {`);
            out.push(`${indent}}`);
            added = true;
        }
    }
    return out.join('\n');
}

function insertMaterialOverrideEntry(
    text: string,
    path: string,
    submesh: string,
    kind: 'texture' | 'material',
): string {
    let content = ensureMaterialOverride(text);
    const lines = content.split('\n');
    let matIdx = -1;
    for (let i = 0; i < lines.length; i++) {
        if (lines[i].includes('materialOverride:') && lines[i].includes('list[embed]')) { matIdx = i; break; }
    }
    if (matIdx === -1) return content;

    let depth = 0; let insertIdx = -1;
    for (let j = matIdx; j < lines.length; j++) {
        for (const c of lines[j]) { if (c === '{') depth++; else if (c === '}') depth--; }
        if (depth === 0 && j > matIdx) { insertIdx = j; break; }
    }
    if (insertIdx === -1) return content;

    let indent = '            ';
    if (matIdx + 1 < lines.length && lines[matIdx + 1].trim()) {
        const m = lines[matIdx + 1].match(/^(\s*)/); if (m) indent = m[1];
    }
    const propType = kind === 'texture' ? 'string' : 'link';
    const propName = kind === 'texture' ? 'texture' : 'material';
    const entry = [
        `${indent}SkinMeshDataProperties_MaterialOverride {`,
        `${indent}    ${propName}: ${propType} = "${path}"`,
        `${indent}    Submesh: string = "${submesh}"`,
        `${indent}}`,
    ];
    return [...lines.slice(0, insertIdx), ...entry, ...lines.slice(insertIdx)].join('\n');
}

function hasVfxEmitters(text: string): boolean {
    return /VfxEmitterDefinitionData\s*\{/.test(text);
}

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
                cssRules.push(`.${cls}::after { content: "  // ${escaped}"; color: #6a9955; font-style: italic; opacity: 0.75; }`);
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

/* Fold/unfold every VfxEmitterDefinitionData block — and ONLY those, so an
 * emitter's parent VfxSystem and unrelated blocks keep their state.
 *
 * Monaco builds the folding model on a debounced scheduler, so right after a
 * load or an edit `getFoldingModel()` can resolve before any region exists.
 * That is what made the buttons look dead. `awaitFoldingRegions` retries a few
 * animation frames until regions appear.
 *
 * The collapse itself goes through `toggleCollapseState`: it repaints the fold
 * decorations and fires the model's change event. Setting `regions.setCollapsed`
 * and calling `foldingModel.update(regions)` does neither — `update()` wants NEW
 * ranges from a range provider, not the regions it already owns. */
async function awaitFoldingRegions(ctrl: any, tries = 12): Promise<any | null> {
    for (let attempt = 0; attempt < tries; attempt++) {
        const fm = await ctrl.getFoldingModel();
        if (fm?.regions?.length > 0) return fm;
        await new Promise((resolve) => requestAnimationFrame(resolve));
    }
    return null;
}

function setEmittersFolded(ed: editor.IStandaloneCodeEditor, collapse: boolean) {
    const model = ed.getModel();
    if (!model) return;

    const emitterLines = new Set<number>();
    const total = model.getLineCount();
    for (let line = 1; line <= total; line++) {
        if (/VfxEmitterDefinitionData\s*\{/.test(model.getLineContent(line))) emitterLines.add(line);
    }
    if (emitterLines.size === 0) return;

    const ctrl = (ed as any).getContribution('editor.contrib.folding');
    if (!ctrl?.getFoldingModel) return;

    void awaitFoldingRegions(ctrl).then((fm) => {
        if (!fm?.regions) return;
        const regions = fm.regions;
        // toggleCollapseState FLIPS what it is given, so pass only the regions
        // that are currently in the wrong state.
        const toToggle: unknown[] = [];
        for (let i = 0; i < regions.length; i++) {
            if (emitterLines.has(regions.getStartLineNumber(i)) && regions.isCollapsed(i) !== collapse) {
                toToggle.push(regions.toRegion(i));
            }
        }
        if (toToggle.length > 0) fm.toggleCollapseState(toToggle);
    });
}

interface BinSidePanelProps {
    content: string;
    onContentChange: (newContent: string) => void;
    editorRef: React.RefObject<editor.IStandaloneCodeEditor | null>;
    onClose: () => void;
}

const BinSidePanel: React.FC<BinSidePanelProps> = ({ content, onContentChange, editorRef, onClose }) => {
    // ── skinScale ──────────────────────────────────────────────────────────────
    const [skinScaleVal, setSkinScaleVal] = useState('1.0');
    const [skinScalePct, setSkinScalePct] = useState('100');
    const [skinScaleExists, setSkinScaleExists] = useState(false);
    const [skinScaleStatus, setSkinScaleStatus] = useState('');
    const [skinScaleCollapsed, setSkinScaleCollapsed] = useState(false);
    const originalScaleRef = useRef(1.0);
    const pctUpdatingRef = useRef(false);

    // ── materialOverride ───────────────────────────────────────────────────────
    const [matExists, setMatExists] = useState(false);
    const [matStatus, setMatStatus] = useState('');
    const [matCollapsed, setMatCollapsed] = useState(false);
    const [matPath, setMatPath] = useState('');
    const [matSubmesh, setMatSubmesh] = useState('');
    const [matKind, setMatKind] = useState<'texture' | 'material'>('texture');
    const [matFormOpen, setMatFormOpen] = useState(false);

    // ── VFX ────────────────────────────────────────────────────────────────────
    const [vfxCollapsed, setVfxCollapsed] = useState(false);
    const isVfx = hasVfxEmitters(content);

    // ── Parse content on change (debounced) ────────────────────────────────────
    const parseRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    useEffect(() => {
        if (parseRef.current) clearTimeout(parseRef.current);
        parseRef.current = setTimeout(() => {
            const sk = parseSkinScale(content);
            setSkinScaleVal(sk.value);
            setSkinScaleExists(sk.exists);
            if (sk.exists) { originalScaleRef.current = parseFloat(sk.value) || 1.0; }
            setSkinScalePct('100');
            setMatExists(content.includes('materialOverride:'));
        }, 300);
        return () => { if (parseRef.current) clearTimeout(parseRef.current); };
    }, [content]);

    const handleApplySkinScale = () => {
        const v = skinScaleVal.trim();
        if (!v) return;
        const ed = editorRef.current;
        const newText = applySkinScaleToText(content, v);
        if (ed) applyContentToEditor(ed, newText);
        else onContentChange(newText);
        setSkinScaleStatus(`Applied: ${v}`);
        const parsed = parseFloat(v);
        if (!isNaN(parsed)) { originalScaleRef.current = parsed; setSkinScalePct('100'); }
    };

    const handleSkinScaleChange = (val: string) => {
        setSkinScaleVal(val);
        const p = parseFloat(val);
        if (!isNaN(p) && originalScaleRef.current !== 0) {
            setSkinScalePct(((p / originalScaleRef.current) * 100).toFixed(0));
        }
    };

    const handlePctChange = (val: string) => {
        setSkinScalePct(val);
        if (pctUpdatingRef.current) return;
        const pct = parseFloat(val);
        if (!isNaN(pct)) {
            pctUpdatingRef.current = true;
            setSkinScaleVal((originalScaleRef.current * (pct / 100)).toFixed(4));
            pctUpdatingRef.current = false;
        }
    };

    const handleAddMatOverride = () => {
        const ed = editorRef.current;
        const newText = ensureMaterialOverride(content);
        if (ed) applyContentToEditor(ed, newText);
        else onContentChange(newText);
        setMatExists(true);
        setMatStatus('materialOverride added');
    };

    const handleInsertMat = () => {
        if (!matPath.trim() || !matSubmesh.trim()) { setMatStatus('Fill in path and submesh'); return; }
        const ed = editorRef.current;
        const newText = insertMaterialOverrideEntry(content, matPath.trim(), matSubmesh.trim(), matKind);
        if (ed) applyContentToEditor(ed, newText);
        else onContentChange(newText);
        setMatStatus(`Inserted ${matKind} entry`);
        setMatPath(''); setMatSubmesh(''); setMatFormOpen(false);
    };

    const handleFoldEmitters = () => { const ed = editorRef.current; if (ed) setEmittersFolded(ed, true); };
    const handleUnfoldEmitters = () => { const ed = editorRef.current; if (ed) setEmittersFolded(ed, false); };

    return (
        <div className="bin-tools">
            <div className="bin-tools__head">
                <span className="bin-tools__title">BIN Tools</span>
                <button className="bin-tools__close" onClick={onClose} title="Close">✕</button>
            </div>

            {/* ── Skin Scale ──────────────────────────────────────────────────── */}
            <div className="bin-tools__section">
                <div className="bin-tools__section-head" onClick={() => setSkinScaleCollapsed(!skinScaleCollapsed)}>
                    <span className={`bin-tools__chevron${skinScaleCollapsed ? ' bin-tools__chevron--collapsed' : ''}`}>▼</span>
                    <span>Skin Scale</span>
                </div>
                {!skinScaleCollapsed && (
                    <div className="bin-tools__body">
                        <div className="bin-tools__row">
                            <input
                                className="dl-input"
                                style={{ flex: 2, minWidth: 0, fontFamily: 'var(--font-mono)' }}
                                value={skinScaleVal}
                                onChange={e => handleSkinScaleChange(e.target.value)}
                                placeholder="1.0"
                                title="skinScale value"
                            />
                            <div className="bin-tools__row" style={{ flex: 1, gap: 3 }}>
                                <input
                                    className="dl-input"
                                    style={{ minWidth: 0, fontFamily: 'var(--font-mono)' }}
                                    value={skinScalePct}
                                    onChange={e => handlePctChange(e.target.value)}
                                    placeholder="100"
                                    title="% of original"
                                />
                                <span style={{ flexShrink: 0, color: 'var(--text-muted)', fontSize: 11 }}>%</span>
                            </div>
                            <button
                                className="dl-btn dl-btn--sm dl-btn--icon"
                                onClick={handleApplySkinScale}
                                title={skinScaleExists ? 'Apply value' : 'Add skinScale property'}
                            >
                                {skinScaleExists ? '✓' : '+'}
                            </button>
                        </div>
                        {skinScaleStatus && <div className="bin-tools__status">{skinScaleStatus}</div>}
                    </div>
                )}
            </div>

            {/* ── Material Override ───────────────────────────────────────────── */}
            <div className="bin-tools__section">
                <div className="bin-tools__section-head" onClick={() => setMatCollapsed(!matCollapsed)}>
                    <span className={`bin-tools__chevron${matCollapsed ? ' bin-tools__chevron--collapsed' : ''}`}>▼</span>
                    <span>Material Override</span>
                    {matExists && <span className="bin-tools__badge">exists</span>}
                </div>
                {!matCollapsed && (
                    <div className="bin-tools__body">
                        {!matExists ? (
                            <button className="dl-btn dl-btn--sm" style={{ width: '100%' }} onClick={handleAddMatOverride}>
                                + Add materialOverride block
                            </button>
                        ) : (
                            <>
                                {!matFormOpen && (
                                    <div className="bin-tools__row">
                                        <button className="dl-btn dl-btn--sm" style={{ flex: 1 }} onClick={() => { setMatKind('texture'); setMatFormOpen(true); }}>◻ Texture</button>
                                        <button className="dl-btn dl-btn--sm" style={{ flex: 1 }} onClick={() => { setMatKind('material'); setMatFormOpen(true); }}>◆ Material</button>
                                    </div>
                                )}
                                {matFormOpen && (
                                    <div className="bin-tools__body">
                                        <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                                            Insert {matKind} override:
                                        </div>
                                        <input
                                            className="dl-input"
                                            placeholder={matKind === 'texture' ? 'assets/characters/.../texture.tex' : 'Material name'}
                                            value={matPath}
                                            onChange={e => setMatPath(e.target.value)}
                                        />
                                        <input
                                            className="dl-input"
                                            placeholder="Submesh name"
                                            value={matSubmesh}
                                            onChange={e => setMatSubmesh(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') handleInsertMat(); if (e.key === 'Escape') setMatFormOpen(false); }}
                                        />
                                        <div className="bin-tools__row">
                                            <button className="dl-btn dl-btn--sm dl-btn--primary" style={{ flex: 1 }} onClick={handleInsertMat}>Insert</button>
                                            <button className="dl-btn dl-btn--sm" style={{ flex: 1 }} onClick={() => setMatFormOpen(false)}>Cancel</button>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                        {matStatus && <div className="bin-tools__status">{matStatus}</div>}
                    </div>
                )}
            </div>

            {/* ── VFX Emitters ────────────────────────────────────────────────── */}
            {isVfx && (
                <div className="bin-tools__section">
                    <div className="bin-tools__section-head" onClick={() => setVfxCollapsed(!vfxCollapsed)}>
                        <span className={`bin-tools__chevron${vfxCollapsed ? ' bin-tools__chevron--collapsed' : ''}`}>▼</span>
                        <span>VFX Emitters</span>
                    </div>
                    {!vfxCollapsed && (
                        <div className="bin-tools__row">
                            <button className="dl-btn dl-btn--sm" style={{ flex: 1 }} onClick={handleFoldEmitters} title="Fold all VfxEmitterDefinitionData blocks">
                                Fold All
                            </button>
                            <button className="dl-btn dl-btn--sm" style={{ flex: 1 }} onClick={handleUnfoldEmitters} title="Unfold all VfxEmitterDefinitionData blocks">
                                Unfold All
                            </button>
                        </div>
                    )}
                </div>
            )}
        </div>
    );
};

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
    const setMinimapPref = useUxStore((s) => s.setBinEditorMinimap);
    // Above the cap the preference is overridden, and the toggle is disabled.
    const minimapAllowed = lineCount <= MINIMAP_MAX_LINES;
    const minimapOn = minimapPref && minimapAllowed;
    const [sidePanelOpen, setSidePanelOpen] = useState(false);
    const [hasMaskMap, setHasMaskMap] = useState(false);
    const [maskEditorOpen, setMaskEditorOpen] = useState(false);
    /* Submesh picker for `Submesh: string = "..."` lines. `line` is the line the
       CodeLens was clicked on; `names` empty with a `note` means the SKN could
       not be read, in which case the field stays free text. */
    const [submeshPicker, setSubmeshPicker] = useState<SubmeshPickerRequest | null>(null);

    const [bracketStatus, setBracketStatus] = useState<BracketValidation>({ valid: true, errors: [] });
    const [bracketErrorIndex, setBracketErrorIndex] = useState(0);
    const bracketCheckTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null);
    const decorationsRef = useRef<string[]>([]);
    const emitterDecorationsRef = useRef<string[]>([]);

    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });

    const variant = 'ritoshark';

    const editorContainerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);
    const openSubmeshPickerRef = useRef<(line: number) => void>(() => {});
    const submeshDecorationsRef = useRef<string[]>([]);

    const latestRef = useRef({ content: '', originalContent: '', fileVersion: 0, variant });
    latestRef.current = { content, originalContent, fileVersion, variant };
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
            const result = validateBrackets(text);
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
            }
        }, BRACKET_CHECK_DEBOUNCE_MS);
    }, []);

    useEffect(() => {
        const cached = editorSessionStore.get(filePath);
        if (cached && cached.fileVersion === fileVersion && cached.variant === variant) {
            setContent(cached.content);
            setOriginalContent(cached.originalContent);
            setLineCount(cached.content.split('\n').length);
            setBracketStatus(validateBrackets(cached.content));
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
                const result = validateBrackets(text);
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

    useEffect(() => {
        if (loading || error || !editorContainerRef.current) return;

        const ed = monaco.editor.create(editorContainerRef.current, {
            ...EDITOR_OPTIONS,
            minimap: { enabled: minimapOn },
            value: content,
            language: RITOBIN_LANGUAGE_ID,
            theme: RITOBIN_THEME_ID,
        });

        editorRef.current = ed;

        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saveRef.current(); });

        const restored = editorSessionStore.get(filePath);
        if (restored?.viewState && restored.fileVersion === fileVersion) {
            ed.restoreViewState(restored.viewState);
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
                const fullText = model.getValue();
                const stack = getBracketStackAtLine(fullText, position.lineNumber);
                if (stack.length === 0) return { items: [] };
                const last = stack[stack.length - 1];
                const closingChar = BRACKET_PAIRS[last.char];
                const suggestion = last.indent + closingChar;
                if (trimmed === closingChar) return { items: [] };
                return {
                    items: [{ insertText: suggestion, range: new monaco.Range(position.lineNumber, 1, position.lineNumber, lineContent.length + 1) }],
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
                refreshSubmeshDecorations();
            });

            const initialResult = validateBrackets(content);
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
                submeshClick.dispose();
                ed.dispose();
            });
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, error]);

    // Apply minimap changes in place. The editor-creation effect must not
    // depend on the preference — re-running it would dispose the model and
    // the undo stack — so toggling is pushed through updateOptions instead.
    useEffect(() => {
        editorRef.current?.updateOptions({ minimap: { enabled: minimapOn } });
    }, [minimapOn]);

    useEffect(() => {
        return () => { if (bracketCheckTimerRef.current) clearTimeout(bracketCheckTimerRef.current); };
    }, []);

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
        const closingChar = BRACKET_PAIRS[err.char] ?? err.char;
        const insertText = '\n' + indent + closingChar;
        const col = model.getLineMaxColumn(targetLine);
        model.pushEditOperations([], [{
            range: new monaco.Range(targetLine, col, targetLine, col),
            text: insertText,
        }], () => null);
        editorRef.current.revealLineInCenter(targetLine + 1);
        editorRef.current.focus();
    }, [bracketStatus]);

    const [unhashing, setUnhashing] = useState(false);

    /* Resolve the SKN this BIN drives (its `simpleSkin` asset path) and read the
       material-range names off it. Any failure returns a note instead of throwing
       so the picker can fall back to plain text editing. */
    const openSubmeshPicker = useCallback(async (line: number) => {
        const ed = editorRef.current;
        const model = ed?.getModel();
        if (!model) return;

        const current = model.getLineContent(line).match(/"([^"]*)"/)?.[1] ?? '';
        const simpleSkin = model.getValue().match(/simpleSkin:\s*string\s*=\s*"([^"]+)"/i)?.[1];

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
        const current = ed.getModel()?.getValue() ?? content;
        try {
            setUnhashing(true);
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
            setUnhashing(false);
        }
    }, [content, setWorking, setReady, showToast]);

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
                    {!hideFilename && (
                        <span className="bin-editor__filename-text" title={filePath}>
                            {fileName}{isDirty ? ' \u2022' : ''}
                        </span>
                    )}
                    <span className="bin-editor__stats" style={hideFilename ? { marginLeft: 0 } : undefined}>
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
                        className="btn btn--icon"
                        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
                        onClick={handleUnhash}
                        disabled={unhashing}
                        title="Unhash: re-resolve any 0x… hash tokens against the known BIN hash dictionary"
                    >
                        {unhashing ? '…' : '#'}
                    </button>
                    <button
                        className={`btn btn--icon${minimapOn ? ' btn--primary' : ''}`}
                        style={!minimapOn ? { background: 'var(--bg-tertiary)', border: '1px solid var(--border)' } : undefined}
                        onClick={() => setMinimapPref(!minimapPref)}
                        disabled={!minimapAllowed}
                        title={minimapAllowed
                            ? 'Toggle minimap (document overview bar on the right)'
                            : `Minimap is disabled above ${MINIMAP_MAX_LINES.toLocaleString()} lines for performance`}
                    >
                        ▭
                    </button>
                    <button
                        className={`btn btn--icon${sidePanelOpen ? ' btn--primary' : ''}`}
                        style={!sidePanelOpen ? { background: 'var(--bg-tertiary)', border: '1px solid var(--border)' } : undefined}
                        onClick={() => setSidePanelOpen(!sidePanelOpen)}
                        title="Toggle BIN tools panel (skinScale, materialOverride, VFX)"
                    >
                        ⚙
                    </button>
                    {hasMaskMap && (
                        <button
                            className={`btn btn--icon${maskEditorOpen ? ' btn--primary' : ''}`}
                            style={!maskEditorOpen ? { background: 'var(--bg-tertiary)', border: '1px solid var(--border)' } : undefined}
                            onClick={() => setMaskEditorOpen(!maskEditorOpen)}
                            title="Toggle animation mask weight editor"
                        >
                            ◑
                        </button>
                    )}
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
                </div>

                {sidePanelOpen && (
                    <BinSidePanel
                        content={content}
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
