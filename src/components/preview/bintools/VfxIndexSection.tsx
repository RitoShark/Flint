import React, { useMemo, useState } from 'react';
import type * as monacoNs from 'monaco-editor';
import { Button } from '../../ui/Button';
import { Checkbox } from '../../ui/Checkbox';
import { Section } from './Section';
import { useSectionDefault } from './sectionDefaults';
import {
    ABILITY_LABELS,
    ABILITY_ORDER,
    indexVfxSystems,
    type VfxSystemEntry,
} from '../../../lib/editor/binTools/vfxIndex';
import { sortVfxBySkill } from '../../../lib/editor/binTools/sortVfx';

interface VfxIndexSectionProps {
    content: string;
    editorRef: React.RefObject<monacoNs.editor.IStandaloneCodeEditor | null>;
    onApply: (text: string) => void;
}

export const VfxIndexSection: React.FC<VfxIndexSectionProps> = ({ content, editorRef, onApply }) => {
    const [collapsed, setCollapsed] = useState(!useSectionDefault('VFX Systems'));
    const [grouped, setGrouped] = useState(false);
    const [status, setStatus] = useState('');
    const systems = useMemo(() => indexVfxSystems(content), [content]);

    const groups = useMemo(
        () => ABILITY_ORDER
            .map((bucket) => ({ bucket, items: systems.filter((s) => (s.bucket ?? 'misc') === bucket) }))
            .filter((g) => g.items.length > 0),
        [systems],
    );

    if (systems.length === 0) return null;

    const reveal = (line: number) => {
        const ed = editorRef.current;
        if (!ed) return;
        ed.revealLineInCenter(line);
        ed.setPosition({ lineNumber: line, column: 1 });
        ed.focus();
    };

    const handleOrder = () => {
        const result = sortVfxBySkill(editorRef.current?.getModel()?.getValue() ?? content);
        if (!result) {
            setStatus('Could not safely order entries. Check braces and put each entry on separate lines.');
            return;
        }
        if (result.systems === 0) {
            setStatus('No top-level VFX systems to order');
            return;
        }
        if (result.moved === 0) {
            setStatus('Already ordered by skill');
            return;
        }
        onApply(result.text);
        setStatus(`Reordered ${result.moved} of ${result.systems} systems`);
    };

    const row = (system: VfxSystemEntry) => (
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
    );

    return (
        <Section
            title="VFX Systems"
            badge={String(systems.length)}
            collapsed={collapsed}
            onToggle={() => setCollapsed(!collapsed)}
        >
            <div className="bin-tools__body">
                <div className="bin-tools__hint">Alt+] next &middot; Alt+[ previous</div>
                <div className="bin-tools__row">
                    <Checkbox
                        className="bin-tools__check"
                        checked={grouped}
                        onChange={(e) => setGrouped(e.target.checked)}
                        label="Group by skill"
                    />
                    <Button
                        size="sm"
                        variant="secondary"
                        className="bin-tools__push"
                        onClick={handleOrder}
                        title="Reorder VfxSystemDefinitionData entries: Passive, Basic Attack, Q, W, E, R, Misc"
                    >
                        Order by Skill
                    </Button>
                </div>
                <ul className="bin-tools__index">
                    {grouped
                        ? groups.map((group) => (
                            <React.Fragment key={group.bucket}>
                                <li className="bin-tools__index-group">
                                    <span>{ABILITY_LABELS[group.bucket]}</span>
                                    <span className="bin-tools__index-line">{group.items.length}</span>
                                </li>
                                {group.items.map(row)}
                            </React.Fragment>
                        ))
                        : systems.map(row)}
                </ul>
                {status && <div className="bin-tools__status">{status}</div>}
            </div>
        </Section>
    );
};
