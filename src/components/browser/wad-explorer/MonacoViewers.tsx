import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import {
    RITOBIN_LANGUAGE_ID,
    RITOBIN_THEME_ID,
    registerRitobinLanguage,
    registerRitobinTheme,
} from '../../../lib/editor/ritobinLanguage';

registerRitobinLanguage(monaco as any);
registerRitobinTheme(monaco as any);

export const MonacoBinViewer: React.FC<{ text: string }> = ({ text }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const editor = monaco.editor.create(containerRef.current, {
            value: text,
            language: RITOBIN_LANGUAGE_ID,
            theme: RITOBIN_THEME_ID,
            readOnly: true,
            automaticLayout: true,
            fontFamily: 'var(--font-mono), "Cascadia Code", "Fira Code", Consolas, monospace',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderWhitespace: 'none',
            folding: false,
            lineNumbers: 'on',
        });

        editorRef.current = editor;

        return () => {
            editor.dispose();
            editorRef.current = null;
        };
    }, []);

    useEffect(() => {
        if (editorRef.current) {
            const model = editorRef.current.getModel();
            if (model && model.getValue() !== text) {
                model.setValue(text);
            }
        }
    }, [text]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
};

export const MonacoTextViewer: React.FC<{ text: string; language: string }> = ({ text, language }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<monaco.editor.IStandaloneCodeEditor | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;

        const editor = monaco.editor.create(containerRef.current, {
            value: text,
            language,
            theme: 'vs-dark',
            readOnly: true,
            automaticLayout: true,
            fontFamily: 'var(--font-mono), "Cascadia Code", "Fira Code", Consolas, monospace',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            renderWhitespace: 'none',
            folding: true,
            lineNumbers: 'on',
        });

        editorRef.current = editor;

        return () => {
            editor.dispose();
            editorRef.current = null;
        };
    }, [language]);

    useEffect(() => {
        if (editorRef.current) {
            const model = editorRef.current.getModel();
            if (model && model.getValue() !== text) {
                model.setValue(text);
            }
        }
    }, [text]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
};
