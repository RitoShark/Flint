import React, { useEffect, useState } from 'react';
import type * as monacoNs from 'monaco-editor';
import { Icon } from '../../ui';
import { SkinScaleSection } from './SkinScaleSection';
import { MaterialOverrideSection } from './MaterialOverrideSection';
import { VfxSection } from './VfxSection';
import { VfxIndexSection } from './VfxIndexSection';
import { IdleParticlesSection } from './IdleParticlesSection';
import { PersistentVfxSection } from './PersistentVfxSection';
import { applyContentToEditor } from '../../../lib/editor/applyContent';
import { hasVfxEmitters } from '../../../lib/editor/binTools/vfx';

interface BinToolsPanelProps {
    content: string;
    onContentChange: (newContent: string) => void;
    editorRef: React.RefObject<monacoNs.editor.IStandaloneCodeEditor | null>;
    onClose: () => void;
}

const PARSE_DEBOUNCE_MS = 300;

export const BinToolsPanel: React.FC<BinToolsPanelProps> = ({
    content,
    onContentChange,
    editorRef,
    onClose,
}) => {
    const [settled, setSettled] = useState(content);

    useEffect(() => {
        const timer = setTimeout(() => setSettled(content), PARSE_DEBOUNCE_MS);
        return () => clearTimeout(timer);
    }, [content]);

    const isSkin = /SkinCharacterDataProperties\s*\{/.test(settled);

    const apply = (text: string) => {
        const ed = editorRef.current;
        if (ed) applyContentToEditor(ed, text);
        else onContentChange(text);
    };

    return (
        <div className="bin-tools">
            <div className="bin-tools__head">
                <span className="bin-tools__title">BIN Tools</span>
                <button className="bin-tools__close" onClick={onClose} title="Close">
                    <Icon className="bin-tools__glyph" name="close" />
                </button>
            </div>

            <SkinScaleSection content={settled} onApply={apply} />
            <MaterialOverrideSection content={settled} onApply={apply} />
            {isSkin && <IdleParticlesSection content={settled} onApply={apply} />}
            {isSkin && <PersistentVfxSection content={settled} onApply={apply} />}
            {hasVfxEmitters(settled) && <VfxSection editorRef={editorRef} />}
            <VfxIndexSection content={settled} editorRef={editorRef} />
        </div>
    );
};
