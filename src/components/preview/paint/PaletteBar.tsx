import React from 'react';

interface PaletteBarProps {
    /** Target hue in degrees, 0–360. */
    hueTarget: number;
    onHueTargetChange: (v: number) => void;
}

/**
 * Hue-target control — the panel's only recolor mode.
 *
 * Flint deliberately ships ONE mode: shift every selected colour to a target
 * hue, keeping its saturation and lightness. The full palette workflow (random,
 * linear ramps, per-keyframe palettes, saved palettes) stays in Quartz, which is
 * the tool built for it. Adding those here would duplicate Quartz badly rather
 * than complement it.
 */
export const PaletteBar: React.FC<PaletteBarProps> = ({ hueTarget, onHueTargetChange }) => (
    <div className="paint-palette">
        <div className="paint-hue">
            <span className="paint-hue__label">Hue</span>
            {/* The track carries the full spectrum, so the slider itself shows
                what it does — no legend needed. */}
            <input
                className="paint-hue__slider"
                type="range"
                min={0}
                max={360}
                value={hueTarget}
                onChange={(e) => onHueTargetChange(Number(e.target.value))}
                aria-label="Target hue"
            />
            <span className="paint-hue__value">{hueTarget}°</span>
            <span
                className="paint-hue__preview"
                style={{ background: `hsl(${hueTarget}, 85%, 55%)` }}
                title={`Target hue ${hueTarget}°`}
            />
        </div>
    </div>
);
