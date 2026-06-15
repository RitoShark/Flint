import React, { useEffect, useRef } from 'react';
import * as monaco from 'monaco-editor';
import type { editor } from 'monaco-editor';

interface ReadOnlyMonacoProps {
    value: string;
    language: string;
}

export const ReadOnlyMonaco: React.FC<ReadOnlyMonacoProps> = ({ value, language }) => {
    const containerRef = useRef<HTMLDivElement>(null);
    const editorRef = useRef<editor.IStandaloneCodeEditor | null>(null);

    useEffect(() => {
        if (!containerRef.current) return;
        const ed = monaco.editor.create(containerRef.current, {
            value,
            language,
            theme: 'vs-dark',
            readOnly: true,
            domReadOnly: true,
            automaticLayout: true,
            fontFamily: 'var(--font-mono), Consolas, monospace',
            fontSize: 13,
            lineHeight: 20,
            minimap: { enabled: false },
            scrollBeyondLastLine: false,
            wordWrap: 'off',
            renderWhitespace: 'none',
            contextmenu: false,
        });
        editorRef.current = ed;
        return () => {
            ed.dispose();
            editorRef.current = null;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [language]);

    useEffect(() => {
        const ed = editorRef.current;
        if (ed && ed.getValue() !== value) {
            ed.setValue(value);
        }
    }, [value]);

    return <div ref={containerRef} style={{ width: '100%', height: '100%' }} />;
};
