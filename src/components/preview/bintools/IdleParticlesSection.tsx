import React, { useState } from 'react';
import { Section } from './Section';
import { useSectionDefault } from './sectionDefaults';
import { insertIdleEffect, type IdleEffectFields } from '../../../lib/editor/binTools/idleParticles';

interface IdleParticlesSectionProps {
    content: string;
    onApply: (text: string) => void;
}

const EMPTY: IdleEffectFields = {
    effectKey: '',
    boneName: '',
    targetBoneName: '',
    effectName: '',
    position: ['0', '0', '0'],
};

export const IdleParticlesSection: React.FC<IdleParticlesSectionProps> = ({ content, onApply }) => {
    const [collapsed, setCollapsed] = useState(!useSectionDefault('Idle Particles'));
    const [fields, setFields] = useState<IdleEffectFields>(EMPTY);
    const [status, setStatus] = useState('');

    const set = <K extends keyof IdleEffectFields>(key: K, value: IdleEffectFields[K]) =>
        setFields((prev) => ({ ...prev, [key]: value }));

    const setAxis = (index: 0 | 1 | 2, value: string) =>
        setFields((prev) => {
            const position = [...prev.position] as IdleEffectFields['position'];
            position[index] = value;
            return { ...prev, position };
        });

    const handleAdd = () => {
        if (!fields.effectKey.trim()) { setStatus('An effect key is required'); return; }
        const next = insertIdleEffect(content, fields);
        if (next === content) {
            setStatus('No SkinCharacterDataProperties block in this BIN');
            return;
        }
        onApply(next);
        setStatus(`Added ${fields.effectKey.trim()}`);
        setFields(EMPTY);
    };

    return (
        <Section title="Idle Particles" collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}>
            <div className="bin-tools__body">
                <input
                    className="dl-input"
                    placeholder="effectKey"
                    value={fields.effectKey}
                    onChange={e => set('effectKey', e.target.value)}
                />
                <div className="bin-tools__row">
                    <input
                        className="dl-input"
                        style={{ flex: 1, minWidth: 0 }}
                        placeholder="boneName"
                        value={fields.boneName}
                        onChange={e => set('boneName', e.target.value)}
                    />
                    <input
                        className="dl-input"
                        style={{ flex: 1, minWidth: 0 }}
                        placeholder="targetBoneName"
                        value={fields.targetBoneName}
                        onChange={e => set('targetBoneName', e.target.value)}
                    />
                </div>
                <input
                    className="dl-input"
                    placeholder="effectName"
                    value={fields.effectName}
                    onChange={e => set('effectName', e.target.value)}
                />
                <div className="bin-tools__row">
                    {(['x', 'y', 'z'] as const).map((axis, i) => (
                        <input
                            key={axis}
                            className="dl-input"
                            style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)' }}
                            placeholder={axis}
                            value={fields.position[i]}
                            onChange={e => setAxis(i as 0 | 1 | 2, e.target.value)}
                        />
                    ))}
                </div>
                <button className="dl-btn dl-btn--sm dl-btn--primary" style={{ width: '100%' }} onClick={handleAdd}>
                    Add idle effect
                </button>
                {status && <div className="bin-tools__status">{status}</div>}
            </div>
        </Section>
    );
};
