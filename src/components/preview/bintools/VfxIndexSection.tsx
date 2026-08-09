import React, { useMemo, useState } from 'react';
import type * as monacoNs from 'monaco-editor';
import { Section } from './Section';
import { indexVfxSystems } from '../../../lib/editor/binTools/vfxIndex';

interface VfxIndexSectionProps {
    content: string;
    editorRef: React.RefObject<monacoNs.editor.IStandaloneCodeEditor | null>;
}

export const VfxIndexSection: React.FC<VfxIndexSectionProps> = ({ content, editorRef }) => {
    const [collapsed, setCollapsed] = useState(false);
    const systems = useMemo(() => indexVfxSystems(content), [content]);

    if (systems.length === 0) return null;

    const reveal = (line: number) => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: 1 });
        ed.focus();
    };

    return (
        <Section
            title="VFX Systems"
            badge={String(systems.length)}
            collapsed={collapsed}
            onToggle={() => setCollapsed(!collapsed)}
        >
            <div className="bin-tools__body">
                <div className="bin-tools__hint">Alt+] next &middot; Alt+[ previous</div>
                <ul className="bin-tools__index">
                    {systems.map((system) => (
                        <li key={`${system.line}-${system.label}`}>
                            <button
                                className="bin-tools__index-row"
                                onClick={() => reveal(system.line)}
                                title={`${system.label} — line ${system.line}`}
                            >
                                <span className="bin-tools__index-label">{system.label}</span>
                                <span className="bin-tools__index-line">{system.line}</span>
                            </button>
                        </li>
                    ))}
                </ul>
            </div>
        </Section>
    );
};
