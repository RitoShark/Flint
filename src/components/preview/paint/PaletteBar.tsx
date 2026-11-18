import { DlSlider } from '../../ui/design-lab/DlSlider';
import React from 'react';

interface PaletteBarProps {
    /** Target hue in degrees, 0–360. */
    hueTarget: number;
    onHueTargetChange: (v: number) => void;
}

export const PaletteBar: React.FC<PaletteBarProps> = ({ hueTarget, onHueTargetChange }) => (
    <div className="paint-palette">
        <div className="paint-hue">
            <span className="paint-hue__label">Hue</span>
            {/* The track carries the full spectrum, so the slider itself shows
                what it does — no legend needed. */}
            <DlSlider hue min={0} max={360} value={hueTarget} onChange={onHueTargetChange} aria-label="Target hue" bubble={`${hueTarget} degrees`} />
            <span className="paint-hue__value">{hueTarget}°</span>
            <span
                className="paint-hue__preview"
                style={{ background: `hsl(${hueTarget}, 85%, 55%)` }}
                title={`Target hue ${hueTarget}°`}
            />
        </div>
    </div>
);
