import React, { useState } from 'react';
import { Section } from './Section';
import { useSectionDefault } from './sectionDefaults';
import {
    insertPersistentCondition,
    type PersistentVfxFields,
} from '../../../lib/editor/binTools/persistentVfx';

interface PersistentVfxSectionProps {
    content: string;
    onApply: (text: string) => void;
}

const EMPTY: PersistentVfxFields = {
    effectKey: '',
    boneName: '',
    targetBoneName: '',
    scale: '',
    playSpeedModifier: '',
    showToOwnerOnly: false,
    attachToCamera: false,
    useDifferentKeyForOtherTeam: false,
    effectKeyForOtherTeam: '',
    submeshesToShow: '',
    submeshesToHide: '',
    forceRenderVfx: false,
    condition: null,
};

const EMPTY_CONDITION = {
    spell: '',
    scriptName: '',
    deactivateEarlySeconds: '',
    negate: false,
};

export const PersistentVfxSection: React.FC<PersistentVfxSectionProps> = ({ content, onApply }) => {
    const [collapsed, setCollapsed] = useState(!useSectionDefault('Persistent VFX'));
    const [fields, setFields] = useState<PersistentVfxFields>(EMPTY);
    const [status, setStatus] = useState('');

    const set = <K extends keyof PersistentVfxFields>(key: K, value: PersistentVfxFields[K]) =>
        setFields((prev) => ({ ...prev, [key]: value }));

    const condition = fields.condition;
    const setCondition = (patch: Partial<NonNullable<PersistentVfxFields['condition']>>) =>
        setFields((prev) => ({
            ...prev,
            condition: prev.condition ? { ...prev.condition, ...patch } : null,
        }));

    const handleAdd = () => {
        if (!fields.effectKey.trim()) { setStatus('An effect key is required'); return; }
        const next = insertPersistentCondition(content, fields);
        if (next === content) {
            setStatus('No SkinCharacterDataProperties block in this BIN');
            return;
        }
        onApply(next);
        setStatus(`Added ${fields.effectKey.trim()}`);
        setFields(EMPTY);
    };

    return (
        <Section title="Persistent VFX" collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}>
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
                <div className="bin-tools__row">
                    <input
                        className="dl-input"
                        style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)' }}
                        placeholder="Scale"
                        value={fields.scale}
                        onChange={e => set('scale', e.target.value)}
                    />
                    <input
                        className="dl-input"
                        style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)' }}
                        placeholder="PlaySpeedModifier"
                        value={fields.playSpeedModifier}
                        onChange={e => set('playSpeedModifier', e.target.value)}
                    />
                </div>

                <label className="bin-tools__check">
                    <input
                        type="checkbox"
                        checked={fields.showToOwnerOnly}
                        onChange={e => set('showToOwnerOnly', e.target.checked)}
                    />
                    ShowToOwnerOnly
                </label>
                <label className="bin-tools__check">
                    <input
                        type="checkbox"
                        checked={fields.attachToCamera}
                        onChange={e => set('attachToCamera', e.target.checked)}
                    />
                    AttachToCamera
                </label>
                <label className="bin-tools__check">
                    <input
                        type="checkbox"
                        checked={fields.forceRenderVfx}
                        onChange={e => set('forceRenderVfx', e.target.checked)}
                    />
                    ForceRenderVfx
                </label>
                <label className="bin-tools__check">
                    <input
                        type="checkbox"
                        checked={fields.useDifferentKeyForOtherTeam}
                        onChange={e => set('useDifferentKeyForOtherTeam', e.target.checked)}
                    />
                    Different key for the other team
                </label>
                {fields.useDifferentKeyForOtherTeam && (
                    <input
                        className="dl-input"
                        placeholder="EffectKeyForOtherTeam"
                        value={fields.effectKeyForOtherTeam}
                        onChange={e => set('effectKeyForOtherTeam', e.target.value)}
                    />
                )}

                <input
                    className="dl-input"
                    placeholder="SubmeshesToShow (comma separated)"
                    value={fields.submeshesToShow}
                    onChange={e => set('submeshesToShow', e.target.value)}
                />
                <input
                    className="dl-input"
                    placeholder="SubmeshesToHide (comma separated)"
                    value={fields.submeshesToHide}
                    onChange={e => set('submeshesToHide', e.target.value)}
                />

                <label className="bin-tools__check">
                    <input
                        type="checkbox"
                        checked={condition !== null}
                        onChange={e => set('condition', e.target.checked ? { ...EMPTY_CONDITION } : null)}
                    />
                    Only while a buff is active
                </label>
                {condition && (
                    <>
                        <input
                            className="dl-input"
                            placeholder="Spell hash"
                            value={condition.spell}
                            onChange={e => setCondition({ spell: e.target.value })}
                        />
                        <div className="bin-tools__row">
                            <input
                                className="dl-input"
                                style={{ flex: 2, minWidth: 0 }}
                                placeholder="mScriptName"
                                value={condition.scriptName}
                                onChange={e => setCondition({ scriptName: e.target.value })}
                            />
                            <input
                                className="dl-input"
                                style={{ flex: 1, minWidth: 0, fontFamily: 'var(--font-mono)' }}
                                placeholder="early s"
                                value={condition.deactivateEarlySeconds}
                                onChange={e => setCondition({ deactivateEarlySeconds: e.target.value })}
                            />
                        </div>
                        <label className="bin-tools__check">
                            <input
                                type="checkbox"
                                checked={condition.negate}
                                onChange={e => setCondition({ negate: e.target.checked })}
                            />
                            Invert (only while the buff is NOT active)
                        </label>
                    </>
                )}

                <button className="dl-btn dl-btn--sm dl-btn--primary" style={{ width: '100%' }} onClick={handleAdd}>
                    Add persistent VFX
                </button>
                {status && <div className="bin-tools__status">{status}</div>}
            </div>
        </Section>
    );
};
