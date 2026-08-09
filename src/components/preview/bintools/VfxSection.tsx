import React, { useState } from 'react';
import type * as monacoNs from 'monaco-editor';
import { Section } from './Section';
import { setEmittersFolded } from '../../../lib/editor/binTools/vfx';

interface VfxSectionProps {
    editorRef: React.RefObject<monacoNs.editor.IStandaloneCodeEditor | null>;
}

export const VfxSection: React.FC<VfxSectionProps> = ({ editorRef }) => {
    const [collapsed, setCollapsed] = useState(false);

    const fold = (collapse: boolean) => {
        const ed = editorRef.current;
        if (ed) setEmittersFolded(ed, collapse);
    };

    return (
        <Section title="VFX Emitters" collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}>
            <div className="bin-tools__row">
                <button
                    className="dl-btn dl-btn--sm"
                    style={{ flex: 1 }}
                    onClick={() => fold(true)}
                    title="Fold all VfxEmitterDefinitionData blocks"
                >
                    Fold All
                </button>
                <button
                    className="dl-btn dl-btn--sm"
                    style={{ flex: 1 }}
                    onClick={() => fold(false)}
                    title="Unfold all VfxEmitterDefinitionData blocks"
                >
                    Unfold All
                </button>
            </div>
        </Section>
    );
};
