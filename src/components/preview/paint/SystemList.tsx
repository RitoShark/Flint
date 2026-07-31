import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { VirtualList } from '../VirtualList';
import { Icon } from '../../ui/Icon';
import { ColorBlock } from './ColorBlock';
import { hexToVec4, vec4ToHex } from '../../../lib/paint/colorMath';
import type { Vec4 } from '../../../lib/paint/colorMath';
import type {
    ColorKeyframe,
    MaterialParam,
    VfxEmitter,
    VfxMaterial,
    VfxModel,
    VfxSystem,
} from '../../../lib/api/paint';

/** Fallback only — the real value is `--paint-row-h` in PaintPanel.css, read at
 *  mount by `useRowHeight`. The windowed list needs a NUMBER (it positions rows
 *  by index), which is the one place a CSS length has to cross into JS. */
const ROW_HEIGHT_FALLBACK = 42;

/** Resolve `--paint-row-h` off the mounted panel so the stylesheet stays the
 *  single source of truth for row geometry. */
function useRowHeight(ref: React.RefObject<HTMLElement | null>): number {
    const [height, setHeight] = useState(ROW_HEIGHT_FALLBACK);
    useEffect(() => {
        if (!ref.current) return;
        const raw = getComputedStyle(ref.current).getPropertyValue('--paint-row-h');
        const parsed = parseFloat(raw);
        if (Number.isFinite(parsed) && parsed > 0) setHeight(parsed);
    }, [ref]);
    return height;
}

type ListRow =
    | { type: 'system'; key: string; system: VfxSystem; matchingCount: number }
    | { type: 'emitter'; key: string; emitter: VfxEmitter; systemKey: string }
    | { type: 'material'; key: string; material: VfxMaterial }
    | {
          type: 'materialParam';
          key: string;
          selectionKey: string;
          param: MaterialParam;
          materialKey: string;
      };

/** Per-row state, derived once per render so each row takes plain booleans. */
interface RowState {
    selected: boolean;
    someSelected: boolean;
    locked: boolean;
    expanded: boolean;
}

interface SystemListProps {
    model: VfxModel;
    selection: Set<string>;
    lockedSystems: Set<string>;
    expandedSystems: Set<string>;
    expandedMaterials: Set<string>;
    searchQuery: string;
    showBaseColor: boolean;
    showBirthColor: boolean;
    showOC: boolean;
    showLingerColor: boolean;
    onToggleEmitter: (key: string) => void;
    onToggleSystem: (key: string, selected: boolean) => void;
    onToggleLock: (key: string) => void;
    onToggleExpand: (key: string) => void;
    onToggleMaterialExpand: (key: string) => void;
    onSetBlendMode: (emitterKey: string, mode: number) => void;
    onSetMaterialParam: (selectionKey: string, value: Vec4) => void;
    /** Pull a block's colors into the working palette. */
    onPickColors: (colors: ColorKeyframe[]) => void;
    /** Double-click a row: reveal that name in the ritobin text. */
    onRevealInText: (needle: string) => void;
}

function keyframesOf(slot: VfxEmitter['colors']['color']): ColorKeyframe[] {
    return slot?.keyframes ?? [];
}

/** A tri-state checkbox. `indeterminate` is a DOM property, not an attribute,
 *  so it has to be set through a ref — React will not render it. */
const TriCheckbox: React.FC<{
    checked: boolean;
    indeterminate?: boolean;
    disabled?: boolean;
    onChange: () => void;
    label: string;
    className?: string;
}> = ({ checked, indeterminate = false, disabled, onChange, label, className }) => (
    <input
        type="checkbox"
        className={className}
        checked={checked}
        disabled={disabled}
        ref={(el) => {
            if (el) el.indeterminate = indeterminate && !checked;
        }}
        onChange={onChange}
        onClick={(e) => e.stopPropagation()}
        aria-label={label}
    />
);

export const SystemList: React.FC<SystemListProps> = ({
    model,
    selection,
    lockedSystems,
    expandedSystems,
    expandedMaterials,
    searchQuery,
    showBaseColor,
    showBirthColor,
    showOC,
    showLingerColor,
    onToggleEmitter,
    onToggleSystem,
    onToggleLock,
    onToggleExpand,
    onToggleMaterialExpand,
    onSetBlendMode,
    onSetMaterialParam,
    onPickColors,
    onRevealInText,
}) => {
    const hostRef = useRef<HTMLDivElement>(null);
    const rowHeight = useRowHeight(hostRef);

    const systemMap = useMemo(
        () => new Map(model.systems.map((s) => [s.key, s])),
        [model.systems],
    );
    const emitterMap = useMemo(
        () => new Map(model.emitters.map((e) => [e.key, e])),
        [model.emitters],
    );
    const materialMap = useMemo(
        () => new Map(model.materials.map((m) => [m.key, m])),
        [model.materials],
    );

    /* Flatten the tree into the row list the window renders. A system whose
       emitters all filter out is dropped entirely, so the list never shows an
       expandable header with nothing under it. */
    const rows = useMemo<ListRow[]>(() => {
        const out: ListRow[] = [];
        const q = searchQuery.trim().toLowerCase();

        for (const systemKey of model.systemOrder) {
            const system = systemMap.get(systemKey);
            if (!system) continue;

            let emitters = system.emitterKeys
                .map((k) => emitterMap.get(k))
                .filter((e): e is VfxEmitter => Boolean(e));

            if (q) {
                const systemMatches =
                    system.name.toLowerCase().includes(q) || systemKey.toLowerCase().includes(q);
                if (!systemMatches) {
                    emitters = emitters.filter((e) => e.name.toLowerCase().includes(q));
                }
            }
            if (emitters.length === 0) continue;

            out.push({ type: 'system', key: systemKey, system, matchingCount: emitters.length });
            if (expandedSystems.has(systemKey)) {
                for (const emitter of emitters) {
                    out.push({ type: 'emitter', key: emitter.key, emitter, systemKey });
                }
            }
        }

        for (const materialKey of model.materialOrder) {
            const material = materialMap.get(materialKey);
            if (!material || material.colorParams.length === 0) continue;

            if (q) {
                const matches =
                    material.name.toLowerCase().includes(q) ||
                    materialKey.toLowerCase().includes(q) ||
                    material.colorParams.some((p) => p.name.toLowerCase().includes(q));
                if (!matches) continue;
            }

            out.push({ type: 'material', key: materialKey, material });
            if (expandedMaterials.has(materialKey)) {
                for (const param of material.colorParams) {
                    out.push({
                        type: 'materialParam',
                        key: param.selectionKey,
                        selectionKey: param.selectionKey,
                        param,
                        materialKey,
                    });
                }
            }
        }

        return out;
    }, [
        model.systemOrder,
        model.materialOrder,
        systemMap,
        emitterMap,
        materialMap,
        searchQuery,
        expandedSystems,
        expandedMaterials,
    ]);

    const rowStates = useMemo<RowState[]>(
        () =>
            rows.map((row): RowState => {
                switch (row.type) {
                    case 'emitter':
                        return {
                            selected: selection.has(row.key),
                            someSelected: false,
                            locked: lockedSystems.has(row.systemKey),
                            expanded: false,
                        };
                    case 'system': {
                        const keys = row.system.emitterKeys;
                        const all = keys.length > 0 && keys.every((k) => selection.has(k));
                        const some = !all && keys.some((k) => selection.has(k));
                        return {
                            selected: all,
                            someSelected: some,
                            locked: lockedSystems.has(row.key),
                            expanded: expandedSystems.has(row.key),
                        };
                    }
                    case 'material': {
                        const keys = row.material.colorParams.map((p) => p.selectionKey);
                        const all = keys.length > 0 && keys.every((k) => selection.has(k));
                        const some = !all && keys.some((k) => selection.has(k));
                        return {
                            selected: all,
                            someSelected: some,
                            locked: false,
                            expanded: expandedMaterials.has(row.key),
                        };
                    }
                    case 'materialParam':
                        return {
                            selected: selection.has(row.selectionKey),
                            someSelected: false,
                            locked: false,
                            expanded: false,
                        };
                }
            }),
        [rows, selection, lockedSystems, expandedSystems, expandedMaterials],
    );

    const renderRow = useCallback(
        (row: ListRow, index: number) => {
            const state = rowStates[index];

            if (row.type === 'system') {
                return (
                    <div
                        className={`paint-row paint-row--system${state.locked ? ' is-locked' : ''}`}
                        onClick={() => onToggleExpand(row.key)}
                        onDoubleClick={() => onRevealInText(row.system.particleName ?? row.system.name)}
                        title="Double-click to find this system in the text"
                    >
                        <TriCheckbox
                            className="paint-row__check"
                            checked={state.selected}
                            indeterminate={state.someSelected}
                            disabled={state.locked}
                            onChange={() => onToggleSystem(row.key, !state.selected)}
                            label={`Select all emitters in ${row.system.name}`}
                        />
                        <Icon
                            className="paint-row__chevron"
                            name={state.expanded ? 'chevronDown' : 'chevronRight'}
                        />
                        <span className="paint-row__name" title={row.system.name}>
                            {row.system.name.includes('/')
                                ? row.system.name.split('/').pop()
                                : row.system.name}
                        </span>
                        <span className="paint-row__meta">{row.matchingCount} emitters</span>
                        <button
                            type="button"
                            className={`paint-row__lock${state.locked ? ' is-locked' : ''}`}
                            onClick={(e) => {
                                e.stopPropagation();
                                onToggleLock(row.key);
                            }}
                            title={state.locked ? 'Unlock this system' : 'Lock this system'}
                            aria-label={state.locked ? 'Unlock system' : 'Lock system'}
                        >
                            <Icon name={state.locked ? 'lockClosed' : 'lockOpen'} />
                        </button>
                    </div>
                );
            }

            if (row.type === 'material') {
                return (
                    <div
                        className="paint-row paint-row--material"
                        onClick={() => onToggleMaterialExpand(row.key)}
                        onDoubleClick={() => onRevealInText(row.material.name)}
                        title="Double-click to find this material in the text"
                    >
                        <TriCheckbox
                            className="paint-row__check"
                            checked={state.selected}
                            indeterminate={state.someSelected}
                            onChange={() => {
                                const next = !state.selected;
                                for (const p of row.material.colorParams) {
                                    if (selection.has(p.selectionKey) !== next) {
                                        onToggleEmitter(p.selectionKey);
                                    }
                                }
                            }}
                            label={`Select all params in ${row.material.name}`}
                        />
                        <Icon
                            className="paint-row__chevron"
                            name={state.expanded ? 'chevronDown' : 'chevronRight'}
                        />
                        <span className="paint-row__badge">MAT</span>
                        <span className="paint-row__name" title={row.material.name}>
                            {row.material.name}
                        </span>
                        <span className="paint-row__meta">
                            {row.material.colorParams.length} colors
                        </span>
                    </div>
                );
            }

            if (row.type === 'materialParam') {
                const rgba = row.param.values as Vec4;
                return (
                    <div
                        className={`paint-row paint-row--param${state.selected ? ' is-selected' : ''}`}
                        onClick={() => onToggleEmitter(row.selectionKey)}
                        onDoubleClick={() => onRevealInText(row.param.name)}
                        title="Double-click to find this param in the text"
                    >
                        <TriCheckbox
                            className="paint-row__check"
                            checked={state.selected}
                            onChange={() => onToggleEmitter(row.selectionKey)}
                            label={`Select ${row.param.name}`}
                        />
                        <span className="paint-row__name" title={row.param.name}>
                            {row.param.name}
                        </span>
                        <span className="paint-row__spacer" />
                        <ColorBlock
                            colors={[{ rgba, time: 0 }]}
                            title={row.param.name}
                            variant="wide"
                            onClick={(e) => {
                                e.stopPropagation();
                                onPickColors([{ rgba, time: 0 }]);
                            }}
                        />
                        <input
                            type="color"
                            className="paint-row__picker"
                            value={vec4ToHex(rgba)}
                            onClick={(e) => e.stopPropagation()}
                            onChange={(e) => {
                                const parsed = hexToVec4(e.target.value, rgba[3]);
                                if (parsed) onSetMaterialParam(row.selectionKey, parsed);
                            }}
                            aria-label={`Set color for ${row.param.name}`}
                        />
                    </div>
                );
            }

            // Emitter row.
            const { emitter } = row;
            const colors = emitter.colors;
            return (
                <div
                    className={`paint-row paint-row--emitter${state.selected ? ' is-selected' : ''}${
                        state.locked ? ' is-locked' : ''
                    }`}
                    onClick={() => {
                        if (!state.locked) onToggleEmitter(row.key);
                    }}
                    onDoubleClick={() => onRevealInText(emitter.name)}
                    title="Double-click to find this emitter in the text"
                >
                    <TriCheckbox
                        className="paint-row__check"
                        checked={state.selected}
                        disabled={state.locked}
                        onChange={() => {
                            if (!state.locked) onToggleEmitter(row.key);
                        }}
                        label={`Select emitter ${emitter.name}`}
                    />
                    <span className="paint-row__name" title={emitter.name}>
                        {emitter.name}
                    </span>
                    <span className="paint-row__spacer" />

                    <span className="paint-row__blocks">
                        {showLingerColor && (
                            <ColorBlock
                                colors={keyframesOf(colors.lingerColor)}
                                title="Linger Color"
                                variant="secondary"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    const kf = keyframesOf(colors.lingerColor);
                                    if (kf.length) onPickColors(kf);
                                }}
                            />
                        )}
                        {showOC && (
                            <ColorBlock
                                colors={keyframesOf(colors.fresnelColor)}
                                title="OC / Fresnel"
                                variant="secondary"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    const kf = keyframesOf(colors.fresnelColor);
                                    if (kf.length) onPickColors(kf);
                                }}
                            />
                        )}
                        {showBirthColor && (
                            <ColorBlock
                                colors={keyframesOf(colors.birthColor)}
                                title="Birth Color"
                                variant="standard"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    const kf = keyframesOf(colors.birthColor);
                                    if (kf.length) onPickColors(kf);
                                }}
                            />
                        )}
                        {showBaseColor && (
                            <ColorBlock
                                colors={keyframesOf(colors.color)}
                                title="Base Color"
                                variant="wide"
                                onClick={(e) => {
                                    e.stopPropagation();
                                    const kf = keyframesOf(colors.color);
                                    if (kf.length) onPickColors(kf);
                                }}
                            />
                        )}

                        <span className="paint-row__bm" onClick={(e) => e.stopPropagation()}>
                            <span className="paint-row__bm-label">BM:</span>
                            <input
                                key={`${row.key}-${emitter.blendMode}`}
                                type="text"
                                className="paint-row__bm-input"
                                defaultValue={emitter.blendMode}
                                disabled={state.locked}
                                onKeyDown={(e) => {
                                    if (e.key === 'Enter') e.currentTarget.blur();
                                }}
                                onBlur={(e) => {
                                    if (state.locked) return;
                                    const val = parseInt(e.target.value, 10);
                                    if (!Number.isNaN(val) && val !== emitter.blendMode) {
                                        onSetBlendMode(row.key, val);
                                    }
                                }}
                                aria-label={`Blend mode for ${emitter.name}`}
                            />
                        </span>
                    </span>
                </div>
            );
        },
        [
            rowStates,
            selection,
            showBaseColor,
            showBirthColor,
            showOC,
            showLingerColor,
            onToggleEmitter,
            onToggleSystem,
            onToggleLock,
            onToggleExpand,
            onToggleMaterialExpand,
            onSetBlendMode,
            onSetMaterialParam,
            onPickColors,
            onRevealInText,
        ],
    );

    if (rows.length === 0) {
        return (
            <div ref={hostRef} className="paint-list paint-list--empty">
                {searchQuery ? 'Nothing matches this filter.' : 'This BIN has no VFX systems.'}
            </div>
        );
    }

    return (
        /* The probe div inherits the panel's custom properties, so the row
           height is read from CSS rather than duplicated as a JS constant. */
        <div ref={hostRef} className="paint-list-host">
            <VirtualList
                className="paint-list"
                items={rows}
                rowHeight={rowHeight}
                renderRow={renderRow}
            />
        </div>
    );
};
