import React, { useCallback, useMemo } from 'react';
import { ColorSwatch } from './ColorSwatch';
import { hexToVec4, vec4ToHex } from '../../../lib/paint/colorMath';
import type { Vec4 } from '../../../lib/paint/colorMath';
import type {
    ColorData,
    EmitterColors,
    VfxEmitter,
    VfxMaterial,
    VfxModel,
} from '../../../lib/api/paint';

const SLOT_LABELS: Array<[keyof EmitterColors, string]> = [
    ['color', 'Color'],
    ['birthColor', 'BC'],
    ['fresnelColor', 'OC'],
    ['lingerColor', 'LC'],
];

interface SystemListProps {
    model: VfxModel;
    selected: Set<string>;
    onToggleEmitter: (key: string, additive: boolean) => void;
    onToggleSystem: (systemKey: string) => void;
    expanded: Set<string>;
    onToggleExpand: (key: string) => void;
    onSetBlendMode: (emitterKey: string, mode: number) => void;
    onSetMaterialParam: (selectionKey: string, value: Vec4) => void;
    /** Lowercased search text; empty shows everything. */
    filter: string;
}

/** All keyframes of one slot, or an empty list when the slot is absent. */
function keyframesOf(data: ColorData | null): Vec4[] {
    return data ? data.keyframes.map((k) => k.rgba as Vec4) : [];
}

const EmitterRow: React.FC<{
    emitter: VfxEmitter;
    isSelected: boolean;
    onToggle: (key: string, additive: boolean) => void;
    onSetBlendMode: (emitterKey: string, mode: number) => void;
}> = ({ emitter, isSelected, onToggle, onSetBlendMode }) => (
    <div
        className={`paint-emitter${isSelected ? ' paint-emitter--selected' : ''}`}
        onClick={(e) => onToggle(emitter.key, e.ctrlKey || e.metaKey || e.shiftKey)}
        role="button"
        tabIndex={0}
        onKeyDown={(e) => {
            if (e.key === 'Enter' || e.key === ' ') {
                e.preventDefault();
                onToggle(emitter.key, e.ctrlKey || e.metaKey);
            }
        }}
    >
        <input
            type="checkbox"
            className="paint-emitter__check"
            checked={isSelected}
            onChange={() => onToggle(emitter.key, true)}
            onClick={(e) => e.stopPropagation()}
            aria-label={`Select emitter ${emitter.name}`}
        />
        <span className="paint-emitter__name" title={emitter.name}>
            {emitter.name}
        </span>

        <span className="paint-emitter__colors">
            {SLOT_LABELS.map(([slot, label]) => {
                const frames = keyframesOf(emitter.colors[slot]);
                if (frames.length === 0) return null;
                return (
                    <span key={slot} className="paint-emitter__slot" title={label}>
                        <span className="paint-emitter__slot-label">{label}</span>
                        {frames.map((rgba, i) => (
                            <ColorSwatch
                                key={i}
                                rgba={rgba}
                                label={`${emitter.name} ${label} kf ${i + 1}`}
                            />
                        ))}
                    </span>
                );
            })}
        </span>

        <select
            className="dl-select paint-emitter__bm"
            value={emitter.blendMode}
            onChange={(e) => onSetBlendMode(emitter.key, Number(e.target.value))}
            onClick={(e) => e.stopPropagation()}
            title="Blend mode"
            aria-label={`Blend mode for ${emitter.name}`}
        >
            {[0, 1, 2, 3, 4].map((n) => (
                <option key={n} value={n}>
                    {n}
                </option>
            ))}
        </select>
    </div>
);

export const SystemList: React.FC<SystemListProps> = ({
    model,
    selected,
    onToggleEmitter,
    onToggleSystem,
    expanded,
    onToggleExpand,
    onSetBlendMode,
    onSetMaterialParam,
    filter,
}) => {
    const emitterByKey = useMemo(() => {
        const map = new Map<string, VfxEmitter>();
        for (const e of model.emitters) map.set(e.key, e);
        return map;
    }, [model.emitters]);

    const matches = useCallback(
        (systemKey: string): boolean => {
            if (!filter) return true;
            const system = model.systems.find((s) => s.key === systemKey);
            if (!system) return false;
            if (system.name.toLowerCase().includes(filter)) return true;
            // A system stays visible when any of its emitters matches, so
            // searching an emitter name doesn't hide the row that holds it.
            return system.emitterKeys.some((k) =>
                emitterByKey.get(k)?.name.toLowerCase().includes(filter),
            );
        },
        [filter, model.systems, emitterByKey],
    );

    const visibleSystems = useMemo(
        () => model.systemOrder.filter(matches),
        [model.systemOrder, matches],
    );

    const visibleMaterials = useMemo(() => {
        if (!filter) return model.materialOrder;
        return model.materialOrder.filter((key) => {
            const mat = model.materials.find((m) => m.key === key);
            if (!mat) return false;
            return (
                mat.name.toLowerCase().includes(filter) ||
                mat.colorParams.some((p) => p.name.toLowerCase().includes(filter))
            );
        });
    }, [filter, model.materialOrder, model.materials]);

    const materialByKey = useMemo(() => {
        const map = new Map<string, VfxMaterial>();
        for (const m of model.materials) map.set(m.key, m);
        return map;
    }, [model.materials]);

    if (visibleSystems.length === 0 && visibleMaterials.length === 0) {
        return (
            <div className="paint-list paint-list--empty">
                {filter ? 'Nothing matches this filter.' : 'This BIN has no VFX systems.'}
            </div>
        );
    }

    return (
        <div className="paint-list">
            {visibleSystems.map((systemKey) => {
                const system = model.systems.find((s) => s.key === systemKey);
                if (!system) return null;
                const isOpen = expanded.has(systemKey);
                const emitters = system.emitterKeys
                    .map((k) => emitterByKey.get(k))
                    .filter((e): e is VfxEmitter => Boolean(e));
                const allSelected =
                    emitters.length > 0 && emitters.every((e) => selected.has(e.key));

                return (
                    <div key={systemKey} className="paint-system">
                        <div className="paint-system__head">
                            <button
                                type="button"
                                className="paint-system__chevron"
                                onClick={() => onToggleExpand(systemKey)}
                                aria-label={isOpen ? 'Collapse system' : 'Expand system'}
                                aria-expanded={isOpen}
                            >
                                {isOpen ? '▾' : '▸'}
                            </button>
                            <input
                                type="checkbox"
                                className="paint-system__check"
                                checked={allSelected}
                                onChange={() => onToggleSystem(systemKey)}
                                aria-label={`Select all emitters in ${system.name}`}
                            />
                            <span className="paint-system__name" title={system.name}>
                                {system.name}
                            </span>
                            <span className="paint-system__count">{emitters.length}</span>
                        </div>

                        {isOpen && (
                            <div className="paint-system__body">
                                {emitters.map((emitter) => (
                                    <EmitterRow
                                        key={emitter.key}
                                        emitter={emitter}
                                        isSelected={selected.has(emitter.key)}
                                        onToggle={onToggleEmitter}
                                        onSetBlendMode={onSetBlendMode}
                                    />
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}

            {visibleMaterials.map((key) => {
                const material = materialByKey.get(key);
                if (!material) return null;
                const isOpen = expanded.has(key);
                return (
                    <div key={key} className="paint-system paint-system--material">
                        <div className="paint-system__head">
                            <button
                                type="button"
                                className="paint-system__chevron"
                                onClick={() => onToggleExpand(key)}
                                aria-label={isOpen ? 'Collapse material' : 'Expand material'}
                                aria-expanded={isOpen}
                            >
                                {isOpen ? '▾' : '▸'}
                            </button>
                            <span className="paint-system__badge">MAT</span>
                            <span className="paint-system__name" title={material.name}>
                                {material.name}
                            </span>
                            <span className="paint-system__count">
                                {material.colorParams.length}
                            </span>
                        </div>

                        {isOpen && (
                            <div className="paint-system__body">
                                {material.colorParams.map((param) => (
                                    <div key={param.selectionKey} className="paint-emitter">
                                        <span
                                            className="paint-emitter__name"
                                            title={param.name}
                                        >
                                            {param.name}
                                        </span>
                                        <span className="paint-emitter__colors">
                                            <ColorSwatch
                                                rgba={param.values as Vec4}
                                                label={param.name}
                                            />
                                        </span>
                                        <input
                                            type="color"
                                            className="paint-emitter__picker"
                                            value={vec4ToHex(param.values as Vec4)}
                                            onChange={(e) => {
                                                const parsed = hexToVec4(
                                                    e.target.value,
                                                    param.values[3],
                                                );
                                                if (parsed) {
                                                    onSetMaterialParam(
                                                        param.selectionKey,
                                                        parsed,
                                                    );
                                                }
                                            }}
                                            aria-label={`Color for ${param.name}`}
                                        />
                                    </div>
                                ))}
                            </div>
                        )}
                    </div>
                );
            })}
        </div>
    );
};
