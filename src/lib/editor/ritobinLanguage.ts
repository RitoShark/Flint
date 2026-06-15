import type * as monacoNs from 'monaco-editor';

type Monaco = typeof monacoNs;

export const RITOBIN_LANGUAGE_ID = 'ritobin';

export const RITOBIN_THEME_ID = 'ritobin-dark';

export function registerRitobinLanguage(monaco: Monaco): void {
    const languages = monaco.languages.getLanguages();
    if (languages.some((lang: { id: string }) => lang.id === RITOBIN_LANGUAGE_ID)) {
        return;
    }

    monaco.languages.register({ id: RITOBIN_LANGUAGE_ID });

    monaco.languages.setMonarchTokensProvider(RITOBIN_LANGUAGE_ID, {
        defaultToken: '',

        typeKeywords: [
            'type', 'embed', 'pointer', 'link', 'option', 'list', 'map', 'hash',
            'flag', 'struct', 'u8', 'u16', 'u32', 'u64', 'i8', 'i16', 'i32', 'i64',
            'f32', 'f64', 'bool', 'string', 'vec2', 'vec3', 'vec4', 'mtx44', 'rgba', 'path'
        ],

        boolKeywords: ['true', 'false'],

        tokenizer: {
            root: [
                [/#.*$/, 'comment'],
                [/\/\/.*$/, 'comment'],

                [/"[^"\\]*(?:\\.[^"\\]*)*"/, 'string'],

                [/0x[0-9a-fA-F]+/, 'number.hex'],

                [/-?\d+\.\d*f?/, 'number.float'],
                [/-?\d+f/, 'number.float'],
                [/-?\d+/, 'number'],

                [/[{}]/, 'delimiter.bracket'],
                [/[\[\]]/, 'delimiter.square'],
                [/[()]/, 'delimiter.parenthesis'],

                [/[=:,]/, 'delimiter'],

                [/\b(true|false)\b/, 'keyword.bool'],

                // Type keywords - must come before general identifier matching
                [/\b(type|embed|pointer|link|option|list|map|hash|flag|struct|u8|u16|u32|u64|i8|i16|i32|i64|f32|f64|bool|string|vec2|vec3|vec4|mtx44|rgba|path)\b/, 'type'],

                [/[A-Z][a-zA-Z0-9_]*/, 'type.identifier'],

                [/[a-zA-Z_][a-zA-Z0-9_]*(?=\s*[:=])/, 'variable'],

                [/[a-zA-Z_][a-zA-Z0-9_]*/, 'identifier'],

                [/\s+/, 'white']
            ]
        }
    });

    monaco.languages.setLanguageConfiguration(RITOBIN_LANGUAGE_ID, {
        brackets: [
            ['{', '}'],
            ['[', ']'],
            ['(', ')']
        ],
        autoClosingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' }
        ],
        surroundingPairs: [
            { open: '{', close: '}' },
            { open: '[', close: ']' },
            { open: '(', close: ')' },
            { open: '"', close: '"' }
        ],
        comments: {
            lineComment: '#'
        }
    });
}

export function registerRitobinTheme(monaco: Monaco): void {
    monaco.editor.defineTheme(RITOBIN_THEME_ID, {
        base: 'vs-dark',
        inherit: false,
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
            { token: 'identifier', foreground: 'c0c0c0' }
        ],
        colors: {
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
            'minimapSlider.activeBackground': '#3a3a3a88'
        }
    });
}
