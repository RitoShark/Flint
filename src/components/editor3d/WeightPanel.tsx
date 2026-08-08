import React, { useMemo, useState } from 'react';
import { useModelEditorStore } from '../../lib/stores/modelEditorStore';
import { rampColor, type BrushMode } from '../../lib/editor3d/weightPaint';
import type { WeightEntry } from '../../lib/api/modelEdit';

export interface WeightPanelProps {
    onPaint: (entries: WeightEntry[]) => Promise<void>;
}

const BRUSH_MODES: ReadonlyArray<{ mode: BrushMode; label: string }> = [
    { mode: 'add', label: 'Add' },
    { mode: 'subtract', label: 'Subtract' },
    { mode: 'replace', label: 'Replace' },
    { mode: 'smooth', label: 'Smooth' },
];

function rampCss(weight: number): string {
    const [r, g, b] = rampColor(weight);
    return `rgb(${Math.round(r * 255)}, ${Math.round(g * 255)}, ${Math.round(b * 255)})`;
}

interface SliderProps {
    label: string;
    value: number;
    min: number;
    max: number;
    step: number;
    format: (value: number) => string;
    onChange: (value: number) => void;
}

const Slider: React.FC<SliderProps> = ({ label, value, min, max, step, format, onChange }) => (
    <label className="m3d__slider">
        <span className="m3d__slider-label">
            {label}
            <span className="m3d__slider-value">{format(value)}</span>
        </span>
        <input
            type="range"
            min={min}
            max={max}
            step={step}
            value={value}
            onChange={(e) => onChange(parseFloat(e.target.value))}
        />
    </label>
);

export const WeightPanel: React.FC<WeightPanelProps> = ({ onPaint }) => {
    const skeleton = useModelEditorStore((s) => s.skeleton);
    const summary = useModelEditorStore((s) => s.summary);
    const activeJointId = useModelEditorStore((s) => s.activeJointId);
    const setActiveJointId = useModelEditorStore((s) => s.setActiveJointId);
    const brush = useModelEditorStore((s) => s.brush);
    const setBrush = useModelEditorStore((s) => s.setBrush);
    const sampledVertex = useModelEditorStore((s) => s.sampledVertex);

    const [filter, setFilter] = useState('');

    const boundJoints = useMemo(() => {
        if (!skeleton) return [];
        const bound = new Set(summary?.influences ?? skeleton.influences);
        const trimmed = filter.trim().toLowerCase();
        return skeleton.bones
            .filter((b) => !trimmed || b.name.toLowerCase().includes(trimmed))
            .map((b) => ({ bone: b, bound: bound.has(b.id) }));
    }, [skeleton, summary, filter]);

    const nameById = useMemo(() => {
        const map = new Map<number, string>();
        skeleton?.bones.forEach((b) => map.set(b.id, b.name));
        return map;
    }, [skeleton]);

    if (!skeleton) {
        return (
            <div className="m3d__inspector">
                <div className="m3d__hint">This .skn has no sibling .skl — weights cannot be edited.</div>
            </div>
        );
    }

    const setSampledWeight = (jointId: number, weight: number) => {
        if (!sampledVertex) return;
        const others = sampledVertex.influences.filter((i) => i.jointId !== jointId);
        const remainder = 1 - weight;
        const otherTotal = others.reduce((sum, i) => sum + i.weight, 0);
        const joints = [jointId];
        const weights = [weight];
        for (const other of others) {
            joints.push(other.jointId);
            weights.push(otherTotal > 0 ? (other.weight / otherTotal) * remainder : 0);
        }
        void onPaint([{ vertex: sampledVertex.vertex, joints, weights }]);
    };

    return (
        <div className="m3d__inspector m3d__weights">
            <div className="m3d__section-title">Brush</div>
            <div className="m3d__seg">
                {BRUSH_MODES.map(({ mode, label }) => (
                    <button
                        type="button"
                        key={mode}
                        className={`m3d__seg-btn ${brush.mode === mode ? 'm3d__seg-btn--active' : ''}`}
                        onClick={() => setBrush({ mode })}
                    >
                        {label}
                    </button>
                ))}
            </div>
            <Slider
                label="Radius"
                value={brush.radius}
                min={0.01}
                max={Math.max(brush.radius, 1) * 4}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(radius) => setBrush({ radius })}
            />
            <Slider
                label="Strength"
                value={brush.strength}
                min={0.01}
                max={1}
                step={0.01}
                format={(v) => v.toFixed(2)}
                onChange={(strength) => setBrush({ strength })}
            />
            <Slider
                label="Falloff"
                value={brush.falloff}
                min={0.2}
                max={6}
                step={0.1}
                format={(v) => v.toFixed(1)}
                onChange={(falloff) => setBrush({ falloff })}
            />
            <p className="m3d__hint">
                Drag to paint · Ctrl+click samples a vertex · middle-drag orbits, right-drag pans.
            </p>

            <div className="m3d__section-title">Joint</div>
            <input
                className="m3d__filter"
                placeholder="Filter joints…"
                value={filter}
                onChange={(e) => setFilter(e.target.value)}
            />
            <div className="m3d__joint-list">
                {boundJoints.length === 0 ? (
                    <div className="m3d__hint">No joints match “{filter.trim()}”.</div>
                ) : (
                    boundJoints.map(({ bone, bound }) => (
                        <button
                            type="button"
                            key={bone.id}
                            className={`m3d__joint-row ${activeJointId === bone.id ? 'm3d__joint-row--active' : ''}`}
                            onClick={() => setActiveJointId(bone.id)}
                            title={bound ? undefined : 'Not bound yet — painting it adds it to the influence table'}
                        >
                            <span className="m3d__joint-name">{bone.name}</span>
                            {!bound && <span className="m3d__joint-unbound">unbound</span>}
                        </button>
                    ))
                )}
            </div>

            <div className="m3d__section-title">Vertex</div>
            {!sampledVertex ? (
                <div className="m3d__hint">Ctrl+click a vertex in the viewport to inspect its influences.</div>
            ) : (
                <>
                    <div className="m3d__field">
                        <span className="m3d__field-label">Index</span>
                        <span className="m3d__field-value">{sampledVertex.vertex}</span>
                    </div>
                    {sampledVertex.influences.map((influence) => (
                        <div className="m3d__influence" key={influence.jointId}>
                            <span className="m3d__influence-swatch" style={{ background: rampCss(influence.weight) }} />
                            <span className="m3d__influence-name">
                                {nameById.get(influence.jointId) ?? `#${influence.jointId}`}
                            </span>
                            <input
                                className="m3d__influence-input"
                                type="number"
                                min={0}
                                max={1}
                                step={0.01}
                                value={Number(influence.weight.toFixed(3))}
                                onChange={(e) => {
                                    const next = parseFloat(e.target.value);
                                    if (Number.isFinite(next)) setSampledWeight(influence.jointId, Math.min(1, Math.max(0, next)));
                                }}
                            />
                        </div>
                    ))}
                </>
            )}
        </div>
    );
};
