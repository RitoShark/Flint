import type * as monacoNs from 'monaco-editor';

export interface RitobinPreset {
    id: string;
    label: string;
    rules: monacoNs.editor.ITokenThemeRule[];
    colors: Record<string, string>;
}

const DEFAULT_COLORS: Record<string, string> = {
    'editor.background': '#1b1b1b',
    'editor.foreground': '#c0c0c0',

    'editorLineNumber.foreground': '#707070',
    'editorLineNumber.activeForeground': '#c0c0c0',

    'editorGutter.background': '#191919',

    'editor.lineHighlightBackground': '#222222',
    'editor.lineHighlightBorder': '#00000000',

    'editor.selectionBackground': '#264f78',
    'editor.inactiveSelectionBackground': '#2a2a2a',

    'editorCursor.foreground': '#0e639c',

    'scrollbarSlider.background': '#3a3a3a88',
    'scrollbarSlider.hoverBackground': '#454545aa',
    'scrollbarSlider.activeBackground': '#555555ee',

    'editorWidget.background': '#1e1e1e',
    'editorWidget.border': '#2d2d2d',
    'input.background': '#2a2a2a',
    'input.border': '#2d2d2d',
    'input.foreground': '#c0c0c0',

    'editorFindMatch.background': '#515c6a',
    'editorFindMatchHighlight.background': '#314365',

    'editorBracketMatch.background': '#0e639c44',
    'editorBracketMatch.border': '#0e639c',

    'minimap.background': '#191919',
    'minimapSlider.background': '#3a3a3a44',
    'minimapSlider.hoverBackground': '#3a3a3a66',
    'minimapSlider.activeBackground': '#3a3a3a88',
};

export const DEFAULT_PRESET_ID = 'default';

/**
 * Every preset paints the same eleven ritobin token classes. `default` is the
 * palette Flint shipped before the picker existed and must stay byte-identical.
 */
export const RITOBIN_PRESETS: RitobinPreset[] = [
    {
        id: DEFAULT_PRESET_ID,
        label: 'Flint Dark',
        rules: [
            { token: '', foreground: 'c0c0c0' },
            { token: 'comment', foreground: '6a9955', fontStyle: 'italic' },
            { token: 'variable', foreground: 'dcdcaa' },
            { token: 'type', foreground: '569cd6' },
            { token: 'type.identifier', foreground: '4ec9b0' },
            { token: 'keyword.bool', foreground: '569cd6' },
            { token: 'number.hex', foreground: 'bd93f9' },
            { token: 'number.float', foreground: 'b5cea8' },
            { token: 'number', foreground: 'b5cea8' },
            { token: 'string', foreground: 'ce9178' },
            { token: 'delimiter', foreground: 'd4d4d4' },
            { token: 'delimiter.bracket', foreground: 'ffd700' },
            { token: 'delimiter.square', foreground: 'da70d6' },
            { token: 'delimiter.parenthesis', foreground: '179fff' },
            { token: 'identifier', foreground: 'c0c0c0' },
        ],
        colors: DEFAULT_COLORS,
    },
    {
        id: 'ember',
        label: 'Ember',
        rules: [
            { token: '', foreground: 'd6cfc7' },
            { token: 'comment', foreground: '6f6257', fontStyle: 'italic' },
            { token: 'variable', foreground: 'e8b14c' },
            { token: 'type', foreground: 'e0644a' },
            { token: 'type.identifier', foreground: 'f0a05a' },
            { token: 'keyword.bool', foreground: 'e0644a' },
            { token: 'number.hex', foreground: 'c2708f' },
            { token: 'number.float', foreground: 'b0b566' },
            { token: 'number', foreground: 'b0b566' },
            { token: 'string', foreground: 'd99a6c' },
            { token: 'delimiter', foreground: 'a99f95' },
            { token: 'delimiter.bracket', foreground: 'f2c14e' },
            { token: 'delimiter.square', foreground: 'cf7a52' },
            { token: 'delimiter.parenthesis', foreground: 'd8874f' },
            { token: 'identifier', foreground: 'd6cfc7' },
        ],
        colors: {
            ...DEFAULT_COLORS,
            'editor.background': '#181513',
            'editor.foreground': '#d6cfc7',
            'editorGutter.background': '#151210',
            'editor.lineHighlightBackground': '#221d19',
            'editorCursor.foreground': '#e0644a',
            'editorBracketMatch.border': '#e0644a',
            'minimap.background': '#151210',
        },
    },
    {
        id: 'slate',
        label: 'Slate',
        rules: [
            { token: '', foreground: 'c3cad3' },
            { token: 'comment', foreground: '5c6773', fontStyle: 'italic' },
            { token: 'variable', foreground: '8ab4d8' },
            { token: 'type', foreground: '7aa2c8' },
            { token: 'type.identifier', foreground: '9ec5a4' },
            { token: 'keyword.bool', foreground: '7aa2c8' },
            { token: 'number.hex', foreground: 'a99bd4' },
            { token: 'number.float', foreground: 'a3c9a8' },
            { token: 'number', foreground: 'a3c9a8' },
            { token: 'string', foreground: 'c9a58a' },
            { token: 'delimiter', foreground: '9aa4b0' },
            { token: 'delimiter.bracket', foreground: 'd0b57a' },
            { token: 'delimiter.square', foreground: 'b18cc4' },
            { token: 'delimiter.parenthesis', foreground: '7fb2d0' },
            { token: 'identifier', foreground: 'c3cad3' },
        ],
        colors: {
            ...DEFAULT_COLORS,
            'editor.background': '#1c2026',
            'editor.foreground': '#c3cad3',
            'editorGutter.background': '#191d22',
            'editor.lineHighlightBackground': '#232830',
            'editorCursor.foreground': '#7aa2c8',
            'editorBracketMatch.border': '#7aa2c8',
            'minimap.background': '#191d22',
        },
    },
    {
        id: 'high-contrast',
        label: 'High Contrast',
        rules: [
            { token: '', foreground: 'ffffff' },
            { token: 'comment', foreground: '7ca668', fontStyle: 'italic' },
            { token: 'variable', foreground: 'ffe066' },
            { token: 'type', foreground: '5cc8ff' },
            { token: 'type.identifier', foreground: '4ee6b0' },
            { token: 'keyword.bool', foreground: '5cc8ff' },
            { token: 'number.hex', foreground: 'd58bff' },
            { token: 'number.float', foreground: 'a6e22e' },
            { token: 'number', foreground: 'a6e22e' },
            { token: 'string', foreground: 'ff9e64' },
            { token: 'delimiter', foreground: 'ffffff' },
            { token: 'delimiter.bracket', foreground: 'ffd700' },
            { token: 'delimiter.square', foreground: 'ff6ec7' },
            { token: 'delimiter.parenthesis', foreground: '4cc2ff' },
            { token: 'identifier', foreground: 'ffffff' },
        ],
        colors: {
            ...DEFAULT_COLORS,
            'editor.background': '#000000',
            'editor.foreground': '#ffffff',
            'editorGutter.background': '#000000',
            'editor.lineHighlightBackground': '#1a1a1a',
            'editorLineNumber.foreground': '#9a9a9a',
            'editorCursor.foreground': '#ffffff',
            'editorBracketMatch.border': '#ffd700',
            'minimap.background': '#000000',
        },
    },
];

/** Falls back to the default preset so a removed id never renders uncoloured. */
export function resolvePreset(id: string | undefined): RitobinPreset {
    return RITOBIN_PRESETS.find((p) => p.id === id) ?? RITOBIN_PRESETS[0];
}
