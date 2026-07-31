import React, { useCallback } from 'react';
import { hexToVec4, vec4ToCss, vec4ToHex } from '../../../lib/paint/colorMath';
import type { Vec4 } from '../../../lib/paint/colorMath';
import type { RecolorModeId } from '../../../lib/api/paint';

/** Modes that sample the palette. In shift / shift-hue the palette is unused,
 *  so the strip gives way to the HSL controls. */
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

const MAX_STOPS = 12;

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

/** Rotate the hue of the last stop to seed a new one, so growing the palette
 *  produces a usable ramp instead of a row of identical swatches. */
function nextStop(from: Vec4 | undefined): Vec4 {
    if (!from) return [0.925, 0.725, 0.415, 1];
    const [r, g, b, a] = from;
    const max = Math.max(r, g, b);
    const min = Math.min(r, g, b);
    const l = (max + min) / 2;
    const d = max - min;
    let h = 0;
    if (d !== 0) {
        if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
        else if (max === g) h = ((b - r) / d + 2) / 6;
        else h = ((r - g) / d + 4) / 6;
    }
    const s = d === 0 ? 0.6 : l > 0.5 ? d / (2 - max - min) : d / (max + min);
    const nh = (h + 0.12) % 1;
    const ns = Math.min(1, Math.max(0.4, s));
    const nl = Math.min(0.8, Math.max(0.3, l));

    const q = nl < 0.5 ? nl * (1 + ns) : nl + ns - nl * ns;
    const p = 2 * nl - q;
    const conv = (t: number) => {
        let x = t;
        if (x < 0) x += 1;
        if (x > 1) x -= 1;
        if (x < 1 / 6) return p + (q - p) * 6 * x;
        if (x < 1 / 2) return q;
        if (x < 2 / 3) return p + (q - p) * (2 / 3 - x) * 6;
        return p;
    };
    return [conv(nh + 1 / 3), conv(nh), conv(nh - 1 / 3), a];
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
            // Junk keeps the previous color rather than writing black.
            if (!parsed) return;
            onPaletteChange(palette.map((c, i) => (i === index ? parsed : c)));
        },
        [palette, onPaletteChange],
    );

    const setCount = useCallback(
        (count: number) => {
            const next = palette.slice(0, count);
            while (next.length < count) next.push(nextStop(next[next.length - 1]));
            onPaletteChange(next);
        },
        [palette, onPaletteChange],
    );

    const usesPalette = modeUsesPalette(mode);

    return (
        <div className="paint-palette">
            {usesPalette && (
                <>
                    <div className="paint-palette__strip">
                        {palette.map((c, i) => (
                            <label
                                key={i}
                                className="paint-palette__stop"
                                style={{ background: vec4ToCss(c) }}
                                title={`Stop ${i + 1} — ${vec4ToHex(c)}`}
                            >
                                <input
                                    type="color"
                                    value={vec4ToHex(c)}
                                    onChange={(e) => setStop(i, e.target.value)}
                                    aria-label={`Palette stop ${i + 1}`}
                                />
                            </label>
                        ))}
                    </div>

                    <div className="paint-palette__controls">
                        <label className="paint-palette__count">
                            <span>Colors</span>
                            <input
                                type="range"
                                min={1}
                                max={MAX_STOPS}
                                value={palette.length}
                                onChange={(e) => setCount(Number(e.target.value))}
                            />
                            <span className="paint-palette__count-value">{palette.length}</span>
                        </label>

                        <select
                            className="dl-select paint-palette__mode"
                            value={mode}
                            onChange={(e) => onModeChange(e.target.value as RecolorModeId)}
                            aria-label="Recolor mode"
                        >
                            {(Object.keys(MODE_LABELS) as RecolorModeId[]).map((m) => (
                                <option key={m} value={m}>
                                    {MODE_LABELS[m]}
                                </option>
                            ))}
                        </select>
                    </div>
                </>
            )}

            {!usesPalette && (
                <div className="paint-palette__controls paint-palette__controls--sliders">
                    {mode === 'shift' &&
                        (['Hue', 'Sat', 'Light'] as const).map((name, i) => {
                            const range = i === 0 ? 180 : 100;
                            return (
                                <label key={name} className="paint-palette__slider">
                                    <span className="paint-palette__slider-label">
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

                    {mode === 'shift-hue' && (
                        <label className="paint-palette__slider paint-palette__slider--hue">
                            <span className="paint-palette__slider-label">Hue {hueTarget}°</span>
                            <input
                                type="range"
                                min={0}
                                max={360}
                                value={hueTarget}
                                onChange={(e) => onHueTargetChange(Number(e.target.value))}
                            />
                            <span
                                className="paint-palette__hue-preview"
                                style={{ background: `hsl(${hueTarget}, 80%, 50%)` }}
                            />
                        </label>
                    )}

                    <select
                        className="dl-select paint-palette__mode"
                        value={mode}
                        onChange={(e) => onModeChange(e.target.value as RecolorModeId)}
                        aria-label="Recolor mode"
                    >
                        {(Object.keys(MODE_LABELS) as RecolorModeId[]).map((m) => (
                            <option key={m} value={m}>
                                {MODE_LABELS[m]}
                            </option>
                        ))}
                    </select>
                </div>
            )}
        </div>
    );
};
