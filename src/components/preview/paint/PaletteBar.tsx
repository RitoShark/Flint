import React, { useCallback } from 'react';
import { hexToVec4, vec4ToCss, vec4ToHex } from '../../../lib/paint/colorMath';
import type { Vec4 } from '../../../lib/paint/colorMath';
import type { RecolorModeId } from '../../../lib/api/paint';

/** Modes that sample the palette. In shift / shift-hue the palette is unused,
 *  so its editor is hidden and the HSL controls take its place. */
const PALETTE_MODES: RecolorModeId[] = ['random', 'random-keyframe', 'linear', 'materials'];

export function modeUsesPalette(mode: RecolorModeId): boolean {
    return PALETTE_MODES.includes(mode);
}

const MODE_LABELS: Record<RecolorModeId, string> = {
    random: 'Random',
    'random-keyframe': 'Random / keyframe',
    linear: 'Linear',
    shift: 'HSL shift',
    'shift-hue': 'Hue target',
    materials: 'Materials',
};

interface PaletteBarProps {
    mode: RecolorModeId;
    onModeChange: (mode: RecolorModeId) => void;
    palette: Vec4[];
    onPaletteChange: (palette: Vec4[]) => void;
    hslShift: [number, number, number];
    onHslShiftChange: (v: [number, number, number]) => void;
    hueTarget: number;
    onHueTargetChange: (v: number) => void;
}

export const PaletteBar: React.FC<PaletteBarProps> = ({
    mode,
    onModeChange,
    palette,
    onPaletteChange,
    hslShift,
    onHslShiftChange,
    hueTarget,
    onHueTargetChange,
}) => {
    const setStop = useCallback(
        (index: number, hex: string) => {
            const parsed = hexToVec4(hex, palette[index]?.[3] ?? 1);
            // A junk value keeps the previous color rather than writing black.
            if (!parsed) return;
            onPaletteChange(palette.map((c, i) => (i === index ? parsed : c)));
        },
        [palette, onPaletteChange],
    );

    const addStop = useCallback(() => {
        const last = palette[palette.length - 1] ?? ([0.5, 0.5, 0.5, 1] as Vec4);
        onPaletteChange([...palette, [...last] as Vec4]);
    }, [palette, onPaletteChange]);

    const removeStop = useCallback(
        (index: number) => {
            // Keep at least one stop — an empty palette makes every palette
            // mode a silent no-op, which reads as "recolor is broken".
            if (palette.length <= 1) return;
            onPaletteChange(palette.filter((_, i) => i !== index));
        },
        [palette, onPaletteChange],
    );

    return (
        <div className="paint-palette">
            <div className="paint-palette__row">
                <label className="paint-palette__label" htmlFor="paint-mode">
                    Mode
                </label>
                <select
                    id="paint-mode"
                    className="dl-select paint-palette__mode"
                    value={mode}
                    onChange={(e) => onModeChange(e.target.value as RecolorModeId)}
                >
                    {(Object.keys(MODE_LABELS) as RecolorModeId[]).map((m) => (
                        <option key={m} value={m}>
                            {MODE_LABELS[m]}
                        </option>
                    ))}
                </select>

                {modeUsesPalette(mode) && (
                    <div className="paint-palette__stops">
                        {palette.map((c, i) => (
                            <span key={i} className="paint-palette__stop">
                                <input
                                    type="color"
                                    className="paint-palette__picker"
                                    value={vec4ToHex(c)}
                                    onChange={(e) => setStop(i, e.target.value)}
                                    style={{ background: vec4ToCss(c) }}
                                    title={`Palette stop ${i + 1}`}
                                    aria-label={`Palette stop ${i + 1}`}
                                />
                                {palette.length > 1 && (
                                    <button
                                        type="button"
                                        className="paint-palette__remove"
                                        onClick={() => removeStop(i)}
                                        title="Remove this stop"
                                        aria-label={`Remove palette stop ${i + 1}`}
                                    >
                                        ×
                                    </button>
                                )}
                            </span>
                        ))}
                        <button
                            type="button"
                            className="dl-btn dl-btn--ghost dl-btn--sm"
                            onClick={addStop}
                            title="Add a palette stop"
                        >
                            +
                        </button>
                    </div>
                )}
            </div>

            {mode === 'shift' && (
                <div className="paint-palette__row paint-palette__row--sliders">
                    {(['Hue', 'Sat', 'Light'] as const).map((name, i) => {
                        const range = i === 0 ? 180 : 100;
                        return (
                            <label key={name} className="paint-palette__slider">
                                <span>
                                    {name} {hslShift[i] > 0 ? `+${hslShift[i]}` : hslShift[i]}
                                </span>
                                <input
                                    type="range"
                                    min={-range}
                                    max={range}
                                    value={hslShift[i]}
                                    onChange={(e) => {
                                        const next: [number, number, number] = [...hslShift];
                                        next[i] = Number(e.target.value);
                                        onHslShiftChange(next);
                                    }}
                                />
                            </label>
                        );
                    })}
                </div>
            )}

            {mode === 'shift-hue' && (
                <div className="paint-palette__row paint-palette__row--sliders">
                    <label className="paint-palette__slider">
                        <span>Hue {hueTarget}°</span>
                        <input
                            type="range"
                            min={0}
                            max={360}
                            value={hueTarget}
                            onChange={(e) => onHueTargetChange(Number(e.target.value))}
                        />
                    </label>
                    <span
                        className="paint-palette__hue-preview"
                        style={{ background: `hsl(${hueTarget}, 80%, 50%)` }}
                        title={`Target hue ${hueTarget}°`}
                    />
                </div>
            )}
        </div>
    );
};
