import type * as monacoNs from 'monaco-editor';
import { resolvePreset } from './ritobinThemes';
import { useUxStore } from '../stores/uxStore';

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

/*
 * ONE theme id whose rules are swapped, NOT one registered theme per preset.
 * Monaco's standalone theme is global to the instance, so a second theme id
 * would leak the ritobin choice into the ini / JSON / lua editors that share
 * it. Redefining the same id updates every open ritobin view at once.
 */
export function registerRitobinTheme(monaco: Monaco, presetId?: string): void {
    const preset = resolvePreset(presetId ?? useUxStore.getState().binEditorSyntaxTheme);
    monaco.editor.defineTheme(RITOBIN_THEME_ID, {
        base: 'vs-dark',
        inherit: false,
        rules: preset.rules,
        colors: preset.colors,
    });
}

/** Redefine and re-apply, so a live editor repaints without a remount. */
export function applyRitobinTheme(monaco: Monaco, presetId: string): void {
    registerRitobinTheme(monaco, presetId);
    monaco.editor.setTheme(RITOBIN_THEME_ID);
}
