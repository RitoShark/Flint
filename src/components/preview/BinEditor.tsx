import React, { useState, useEffect, useCallback, useRef, useMemo } from 'react';
import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';
import { useAppMetadataStore, useFileEditorStore, useNotificationStore } from '../../lib/stores';
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
import { EmitterPalette, EMITTER_DROP_EVENT, type EmitterDropDetail } from './EmitterPalette';
import { useEmitterPaletteStore, type CopiedBlock } from '../../lib/stores/emitterPaletteStore';
import {
    findEnclosingBlock,
    reindentBlock,
    renameEmitterIfCollision,
    computeInsertPosition,
    extractAssetPaths,
} from '../../lib/editor/blockExtraction';

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

function deriveProjectPath(filePath: string): string | null {
    const norm = filePath.replace(/\\/g, '/');
    const tabs = useProjectTabStore.getState().openTabs;
    let best: string | null = null;
    for (const tab of tabs) {
        if (!tab.projectPath) continue;
        const proj = tab.projectPath.replace(/\\/g, '/');
        if (norm === proj || norm.startsWith(proj + '/')) {
            if (!best || proj.length > best.length) best = tab.projectPath;
        }
    }
    if (best) return best;

    const idx = norm.toLowerCase().indexOf('/content/');
    if (idx > 0) return filePath.slice(0, idx);
    return null;
}

interface AssetCopyResult {
    copied: number;
    /** Assets that could not be resolved to a real file in the source project. */
    missing: number;
}

async function copyBlockAssets(
    block: CopiedBlock,
    sourceProject: string,
    destProject: string,
): Promise<AssetCopyResult> {
    const assets = block.assets ?? [];
    const srcRoot = sourceProject.replace(/\\/g, '/').replace(/\/+$/, '');
    const baseBinPath = block.sourceBinPath ?? sourceProject;

    let copied = 0;
    let missing = 0;

    for (const assetPath of assets) {
        let absolute: string;
        try {
            absolute = await api.resolveAssetPath(assetPath, baseBinPath);
        } catch {
            missing += 1;
            continue;
        }
        if (!absolute) {
            missing += 1;
            continue;
        }

        const absNorm = absolute.replace(/\\/g, '/');
        const prefix = srcRoot + '/';
        if (!absNorm.toLowerCase().startsWith(prefix.toLowerCase())) {
            missing += 1;
            continue;
        }
        const relPath = absNorm.slice(prefix.length);
        const parentFolder = relPath.includes('/') ? relPath.slice(0, relPath.lastIndexOf('/')) : '';

        try {
            if (parentFolder) {
                await api.createDirectory(destProject, parentFolder).catch(() => {});
            }
            await api.copyBetweenProjects(sourceProject, [relPath], destProject, parentFolder);
            copied += 1;
        } catch {
            missing += 1;
        }
    }

    return { copied, missing };
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

function setEmittersFolded(ed: editor.IStandaloneCodeEditor, collapse: boolean) {
    const model = ed.getModel();
    if (!model) return;
    const lines = model.getValue().split('\n');
    const emitterLines = new Set<number>();
    for (let i = 0; i < lines.length; i++) {
        if (/VfxEmitterDefinitionData\s*\{/.test(lines[i])) emitterLines.add(i + 1);
    }
    if (emitterLines.size === 0) return;
    const ctrl = (ed as any).getContribution('editor.contrib.folding');
    if (!ctrl?.getFoldingModel) return;
    ctrl.getFoldingModel().then((fm: any) => {
        if (!fm) return;
        const regions = fm.regions;
        if (!regions) return;
        for (let i = 0; i < regions.length; i++) {
            const start = regions.getStartLineNumber(i);
            if (emitterLines.has(start) && regions.isCollapsed(i) !== collapse) {
                regions.setCollapsed(i, collapse);
            }
        }
        fm.update(regions);
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

    const panelStyle: React.CSSProperties = {
        position: 'absolute',
        top: 0,
        right: 0,
        width: 280,
        zIndex: 35,
        backgroundColor: 'var(--bg-secondary)',
        border: '1px solid var(--border)',
        borderTop: 'none',
        borderBottomLeftRadius: 8,
        borderBottomRightRadius: 0,
        borderTopRightRadius: 0,
        boxShadow: '-4px 4px 18px rgba(0,0,0,0.35)',
        fontFamily: 'var(--font-sans)',
        fontSize: 12,
        color: 'var(--text-primary)',
        overflow: 'hidden',
    };

    const sectionStyle: React.CSSProperties = {
        borderTop: '1px solid var(--border)',
        padding: '6px 14px 8px',
    };

    const sectionHeaderStyle: React.CSSProperties = {
        display: 'flex', alignItems: 'center', gap: 4,
        height: 22, cursor: 'pointer', userSelect: 'none',
        marginBottom: 4,
    };

    const inputStyle: React.CSSProperties = {
        height: 24, padding: '2px 6px',
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border)',
        borderRadius: 4, color: 'var(--text-primary)',
        fontSize: 12, fontFamily: 'var(--font-mono)',
        outline: 'none',
        width: '100%',
        boxSizing: 'border-box',
    };

    const btnStyle: React.CSSProperties = {
        height: 24, padding: '2px 10px',
        background: 'var(--bg-tertiary)',
        border: '1px solid var(--border)',
        borderRadius: 4, color: 'var(--text-primary)',
        fontSize: 11, cursor: 'pointer', whiteSpace: 'nowrap',
    };

    const btnPrimaryStyle: React.CSSProperties = {
        ...btnStyle,
        background: 'var(--accent-primary)',
        border: '1px solid var(--accent-primary)',
        color: '#fff',
    };

    const statusStyle: React.CSSProperties = {
        fontSize: 10, color: 'var(--text-muted)',
        marginTop: 3, overflow: 'hidden',
        textOverflow: 'ellipsis', whiteSpace: 'nowrap',
    };

    return (
        <div style={panelStyle}>
            <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between', padding: '5px 14px', borderBottom: '1px solid var(--border)', background: 'var(--bg-tertiary)' }}>
                <span style={{ fontSize: 11, fontWeight: 600, color: 'var(--text-secondary)', letterSpacing: '0.04em', textTransform: 'uppercase' }}>BIN Tools</span>
                <button style={{ ...btnStyle, padding: '1px 6px', fontSize: 13, border: 'none', background: 'transparent' }} onClick={onClose} title="Close">✕</button>
            </div>

            {/* ── Skin Scale ──────────────────────────────────────────────────── */}
            <div style={sectionStyle}>
                <div style={sectionHeaderStyle} onClick={() => setSkinScaleCollapsed(!skinScaleCollapsed)}>
                    <span style={{ fontSize: 9, opacity: 0.6, transform: skinScaleCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▼</span>
                    <span style={{ fontWeight: 600, fontSize: 11 }}>Skin Scale</span>
                </div>
                {!skinScaleCollapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        <div style={{ display: 'flex', gap: 4, alignItems: 'center' }}>
                            <input
                                style={{ ...inputStyle, flex: 2, fontFamily: 'var(--font-mono)' }}
                                value={skinScaleVal}
                                onChange={e => handleSkinScaleChange(e.target.value)}
                                placeholder="1.0"
                                title="skinScale value"
                            />
                            <div style={{ display: 'flex', alignItems: 'center', gap: 2, flex: 1 }}>
                                <input
                                    style={{ ...inputStyle, fontFamily: 'var(--font-mono)' }}
                                    value={skinScalePct}
                                    onChange={e => handlePctChange(e.target.value)}
                                    placeholder="100"
                                    title="% of original"
                                />
                                <span style={{ fontSize: 11, color: 'var(--text-muted)', flexShrink: 0 }}>%</span>
                            </div>
                            <button
                                style={{ ...btnStyle, padding: '2px 8px', flexShrink: 0, fontWeight: 700, fontSize: 13 }}
                                onClick={handleApplySkinScale}
                                title={skinScaleExists ? 'Apply value' : 'Add skinScale property'}
                            >
                                {skinScaleExists ? '✓' : '+'}
                            </button>
                        </div>
                        {skinScaleStatus && <div style={statusStyle}>{skinScaleStatus}</div>}
                    </div>
                )}
            </div>

            {/* ── Material Override ───────────────────────────────────────────── */}
            <div style={sectionStyle}>
                <div style={sectionHeaderStyle} onClick={() => setMatCollapsed(!matCollapsed)}>
                    <span style={{ fontSize: 9, opacity: 0.6, transform: matCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▼</span>
                    <span style={{ fontWeight: 600, fontSize: 11 }}>Material Override</span>
                    {matExists && <span style={{ marginLeft: 'auto', fontSize: 9, color: 'var(--accent-primary)', background: 'color-mix(in oklab, var(--accent-primary) 15%, transparent)', borderRadius: 4, padding: '1px 5px' }}>exists</span>}
                </div>
                {!matCollapsed && (
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 4 }}>
                        {!matExists ? (
                            <button style={{ ...btnStyle, width: '100%' }} onClick={handleAddMatOverride}>
                                + Add materialOverride block
                            </button>
                        ) : (
                            <>
                                {!matFormOpen && (
                                    <div style={{ display: 'flex', gap: 4 }}>
                                        <button style={{ ...btnStyle, flex: 1 }} onClick={() => { setMatKind('texture'); setMatFormOpen(true); }}>◻ Texture</button>
                                        <button style={{ ...btnStyle, flex: 1 }} onClick={() => { setMatKind('material'); setMatFormOpen(true); }}>◆ Material</button>
                                    </div>
                                )}
                                {matFormOpen && (
                                    <div style={{ display: 'flex', flexDirection: 'column', gap: 3 }}>
                                        <div style={{ fontSize: 10, color: 'var(--text-muted)', marginBottom: 2 }}>
                                            Insert {matKind} override:
                                        </div>
                                        <input
                                            style={inputStyle}
                                            placeholder={matKind === 'texture' ? 'assets/characters/.../texture.tex' : 'Material name'}
                                            value={matPath}
                                            onChange={e => setMatPath(e.target.value)}
                                        />
                                        <input
                                            style={inputStyle}
                                            placeholder="Submesh name"
                                            value={matSubmesh}
                                            onChange={e => setMatSubmesh(e.target.value)}
                                            onKeyDown={e => { if (e.key === 'Enter') handleInsertMat(); if (e.key === 'Escape') setMatFormOpen(false); }}
                                        />
                                        <div style={{ display: 'flex', gap: 4 }}>
                                            <button style={{ ...btnPrimaryStyle, flex: 1 }} onClick={handleInsertMat}>Insert</button>
                                            <button style={{ ...btnStyle, flex: 1 }} onClick={() => setMatFormOpen(false)}>Cancel</button>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                        {matStatus && <div style={statusStyle}>{matStatus}</div>}
                    </div>
                )}
            </div>

            {/* ── VFX Emitters ────────────────────────────────────────────────── */}
            {isVfx && (
                <div style={sectionStyle}>
                    <div style={sectionHeaderStyle} onClick={() => setVfxCollapsed(!vfxCollapsed)}>
                        <span style={{ fontSize: 9, opacity: 0.6, transform: vfxCollapsed ? 'rotate(-90deg)' : 'none', transition: 'transform 0.15s', display: 'inline-block' }}>▼</span>
                        <span style={{ fontWeight: 600, fontSize: 11 }}>VFX Emitters</span>
                    </div>
                    {!vfxCollapsed && (
                        <div style={{ display: 'flex', gap: 4 }}>
                            <button style={{ ...btnStyle, flex: 1 }} onClick={handleFoldEmitters} title="Fold all VfxEmitterDefinitionData blocks">
                                ▶ Fold All
                            </button>
                            <button style={{ ...btnStyle, flex: 1 }} onClick={handleUnfoldEmitters} title="Unfold all VfxEmitterDefinitionData blocks">
                                ▼ Unfold All
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
    const [sidePanelOpen, setSidePanelOpen] = useState(false);
    const [paletteOpen, setPaletteOpen] = useState(false);

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

    useEffect(() => {
        if (loading || error || !editorContainerRef.current) return;

        const ed = monaco.editor.create(editorContainerRef.current, {
            ...EDITOR_OPTIONS,
            value: content,
            language: RITOBIN_LANGUAGE_ID,
            theme: RITOBIN_THEME_ID,
        });

        editorRef.current = ed;

        ed.addCommand(monaco.KeyMod.CtrlCmd | monaco.KeyCode.KeyS, () => { saveRef.current(); });

        // ── Right-click "copy block" context actions ────────────────────────────
        const copyBlockToPalette = (filter: string[] | undefined, outermost: boolean) => {
            const m = ed.getModel();
            const pos = ed.getPosition();
            if (!m || !pos) return;
            const text = m.getValue();
            let block = findEnclosingBlock(text, pos.lineNumber, filter, outermost);
            if (!block) block = findEnclosingBlock(text, pos.lineNumber, undefined, outermost);
            if (!block) {
                showToast('info', 'No block found at cursor');
                return;
            }
            const nameMatch = block.blockText.match(/emitterName:\s*string\s*=\s*"([^"]+)"/);
            const label = nameMatch ? nameMatch[1] : block.className;
            const assets = extractAssetPaths(block.blockText);
            useEmitterPaletteStore.getState().add({
                label,
                className: block.className,
                text: block.blockText,
                sourceProject: deriveProjectPath(filePath) ?? undefined,
                sourceBinPath: filePath,
                assets,
            });
            setPaletteOpen(true);
            const assetSuffix = assets.length ? ` (${assets.length} asset${assets.length === 1 ? '' : 's'})` : '';
            showToast('success', `Copied ${label} to palette${assetSuffix}`);
        };

        const copyEmitterAction = ed.addAction({
            id: 'flint.copyEmitterBlock',
            label: 'Copy emitter block',
            contextMenuGroupId: 'flint',
            contextMenuOrder: 1,
            run: () => copyBlockToPalette(['VfxEmitterDefinitionData'], false),
        });

        const copyFullVfxAction = ed.addAction({
            id: 'flint.copyFullVfx',
            label: 'Copy full VfxEmitter / VfxSystem',
            contextMenuGroupId: 'flint',
            contextMenuOrder: 2,
            run: () => copyBlockToPalette(['VfxSystemDefinitionData', 'VfxEmitterDefinitionData'], true),
        });

        const restored = editorSessionStore.get(filePath);
        if (restored?.viewState && restored.fileVersion === fileVersion) {
            ed.restoreViewState(restored.viewState);
            ed.focus();
        }

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
                copyEmitterAction.dispose();
                copyFullVfxAction.dispose();
                ed.dispose();
            });
        };
    // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [loading, error]);

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

    const insertBlockAt = useCallback((id: string, clientX: number, clientY: number) => {
        const block = useEmitterPaletteStore.getState().getById(id);
        const ed = editorRef.current;
        const model = ed?.getModel();
        if (!block || !ed || !model) return;

        const target = ed.getTargetAtClientPoint(clientX, clientY);
        const dropLine = target?.position?.lineNumber ?? model.getLineCount();

        const fullText = model.getValue();
        const { line, indent } = computeInsertPosition(fullText, dropLine, getBracketStackAtLine);

        let blockText = reindentBlock(block.text, indent);
        blockText = renameEmitterIfCollision(blockText, fullText);

        const insertCol = model.getLineMaxColumn(line);
        model.pushEditOperations(
            [],
            [{ range: new monaco.Range(line, insertCol, line, insertCol), text: '\n' + blockText }],
            () => null,
        );
        ed.revealLineInCenter(line + 1);
        ed.focus();

        const destProject = deriveProjectPath(filePath);
        const sourceProject = block.sourceProject;
        const assets = block.assets ?? [];
        const crossProject =
            !!destProject && !!sourceProject &&
            destProject.replace(/\\/g, '/').toLowerCase() !== sourceProject.replace(/\\/g, '/').toLowerCase();

        if (crossProject && assets.length > 0) {
            void copyBlockAssets(block, sourceProject!, destProject!).then((res) => {
                if (res.copied > 0 && res.missing === 0) {
                    showToast('success', `Inserted ${block.label} (+${res.copied} asset${res.copied === 1 ? '' : 's'})`);
                } else if (res.copied > 0) {
                    showToast('warning', `Inserted ${block.label} — copied ${res.copied}/${assets.length} assets, ${res.missing} unresolved`);
                } else {
                    showToast('warning', `Inserted ${block.label} — could not copy ${assets.length} asset${assets.length === 1 ? '' : 's'} (unresolved)`);
                }
            }).catch(() => {
                showToast('warning', `Inserted ${block.label} — asset copy failed`);
            });
        } else {
            showToast('success', `Inserted ${block.label}`);
        }
    }, [showToast, filePath]);

    useEffect(() => {
        const el = containerRef.current;
        if (!el) return;
        const onEmitterDrop = (e: Event) => {
            const { blockId, clientX, clientY } = (e as CustomEvent<EmitterDropDetail>).detail;
            insertBlockAt(blockId, clientX, clientY);
        };
        el.addEventListener(EMITTER_DROP_EVENT, onEmitterDrop as EventListener);
        return () => el.removeEventListener(EMITTER_DROP_EVENT, onEmitterDrop as EventListener);
    }, [insertBlockAt]);

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

    const fileName = filePath.split('\\').pop() || filePath.split('/').pop() || 'file.bin';

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
                        <>
                            {fileName}{isDirty ? ' \u2022' : ''}
                        </>
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
                            className="btn btn--sm"
                            style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)', color: 'var(--warning, #f0a020)' }}
                            onClick={handleFixBracket}
                            title="Insert missing closing bracket at suggested position"
                        >
                            Fix {'}'}
                        </button>
                    )}
                    <button
                        className="btn btn--sm"
                        style={{ background: 'var(--bg-tertiary)', border: '1px solid var(--border)' }}
                        onClick={handleUnhash}
                        disabled={unhashing}
                        title="Unhash: re-resolve any 0x… hash tokens against the known BIN hash dictionary"
                    >
                        {unhashing ? 'Unhashing…' : 'Unhash'}
                    </button>
                    <button
                        className={`btn btn--sm${paletteOpen ? ' btn--primary' : ''}`}
                        style={!paletteOpen ? { background: 'var(--bg-tertiary)', border: '1px solid var(--border)' } : undefined}
                        onClick={() => setPaletteOpen(!paletteOpen)}
                        title="Toggle copied-block palette (drag emitter/VFX blocks into any BIN)"
                    >
                        ▤
                    </button>
                    <button
                        className={`btn btn--sm${sidePanelOpen ? ' btn--primary' : ''}`}
                        style={!sidePanelOpen ? { background: 'var(--bg-tertiary)', border: '1px solid var(--border)' } : undefined}
                        onClick={() => setSidePanelOpen(!sidePanelOpen)}
                        title="Toggle BIN tools panel (skinScale, materialOverride, VFX)"
                    >
                        ⚙
                    </button>
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

            <div style={{ flex: 1, display: 'flex', minHeight: 0, position: 'relative' }}>
                {paletteOpen && <EmitterPalette onClose={() => setPaletteOpen(false)} />}
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
