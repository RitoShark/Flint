import React, { useEffect, useState } from 'react';
import { Icon } from '../../ui';
import { Section } from './Section';
import { useSectionDefault } from './sectionDefaults';
import {
    ensureMaterialOverride,
    insertMaterialOverrideEntry,
    type MaterialOverrideKind,
} from '../../../lib/editor/binTools/materialOverride';
import { ToonShadingForm } from './ToonShadingForm';

interface MaterialOverrideSectionProps {
    content: string;
    filePath: string;
    onApply: (text: string) => void;
}

export const MaterialOverrideSection: React.FC<MaterialOverrideSectionProps> = ({ content, filePath, onApply }) => {
    const [collapsed, setCollapsed] = useState(!useSectionDefault('Material Override'));
    const [exists, setExists] = useState(false);
    const [status, setStatus] = useState('');
    const [path, setPath] = useState('');
    const [submesh, setSubmesh] = useState('');
    const [kind, setKind] = useState<MaterialOverrideKind>('texture');
    const [formOpen, setFormOpen] = useState(false);
    const [toonOpen, setToonOpen] = useState(false);

    useEffect(() => {
        setExists(content.includes('materialOverride:'));
    }, [content]);

    const handleAddBlock = () => {
        onApply(ensureMaterialOverride(content));
        setExists(true);
        setStatus('materialOverride added');
    };

    const handleInsert = () => {
        if (!path.trim() || !submesh.trim()) { setStatus('Fill in path and submesh'); return; }
        onApply(insertMaterialOverrideEntry(content, path.trim(), submesh.trim(), kind));
        setStatus(`Inserted ${kind} entry`);
        setPath('');
        setSubmesh('');
        setFormOpen(false);
    };

    return (
        <Section
            title="Material Override"
            badge={exists ? 'exists' : undefined}
            collapsed={collapsed}
            onToggle={() => setCollapsed(!collapsed)}
        >
            <div className="bin-tools__body">
                {!exists ? (
                    <button className="dl-btn dl-btn--sm" style={{ width: '100%' }} onClick={handleAddBlock}>
                        Add materialOverride block
                    </button>
                ) : (
                    <>
                        {!formOpen && !toonOpen && (
                            <>
                                <div className="bin-tools__row">
                                    <button
                                        className="dl-btn dl-btn--sm"
                                        style={{ flex: 1 }}
                                        onClick={() => { setKind('texture'); setFormOpen(true); }}
                                    >
                                        <Icon className="bin-tools__glyph" name="texture" />
                                        Texture
                                    </button>
                                    <button
                                        className="dl-btn dl-btn--sm"
                                        style={{ flex: 1 }}
                                        onClick={() => { setKind('material'); setFormOpen(true); }}
                                    >
                                        <Icon className="bin-tools__glyph" name="contrast" />
                                        Material
                                    </button>
                                </div>
                                <button
                                    className="dl-btn dl-btn--sm"
                                    style={{ width: '100%' }}
                                    onClick={() => setToonOpen(true)}
                                >
                                    <Icon className="bin-tools__glyph" name="color-palette" />
                                    Toon shading
                                </button>
                            </>
                        )}
                        {toonOpen && (
                            <ToonShadingForm
                                content={content}
                                filePath={filePath}
                                onApply={onApply}
                                onDone={() => setToonOpen(false)}
                            />
                        )}
                        {formOpen && (
                            <div className="bin-tools__body">
                                <div style={{ color: 'var(--text-muted)', fontSize: 10 }}>
                                    Insert {kind} override:
                                </div>
                                <input
                                    className="dl-input"
                                    placeholder={kind === 'texture' ? 'assets/characters/.../texture.tex' : 'Material name'}
                                    value={path}
                                    onChange={e => setPath(e.target.value)}
                                />
                                <input
                                    className="dl-input"
                                    placeholder="Submesh name"
                                    value={submesh}
                                    onChange={e => setSubmesh(e.target.value)}
                                    onKeyDown={e => {
                                        if (e.key === 'Enter') handleInsert();
                                        if (e.key === 'Escape') setFormOpen(false);
                                    }}
                                />
                                <div className="bin-tools__row">
                                    <button className="dl-btn dl-btn--sm dl-btn--primary" style={{ flex: 1 }} onClick={handleInsert}>Insert</button>
                                    <button className="dl-btn dl-btn--sm" style={{ flex: 1 }} onClick={() => setFormOpen(false)}>Cancel</button>
                                </div>
                            </div>
                        )}
                    </>
                )}
                {status && <div className="bin-tools__status">{status}</div>}
            </div>
        </Section>
    );
};
