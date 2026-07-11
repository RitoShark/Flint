import React from 'react';

export interface DlSliderProps {
    value: number;
    onChange: (value: number) => void;
    min?: number;
    max?: number;
    step?: number;
    /** Rendered inside the hover value bubble (e.g. `46px`, `120°`). Defaults to the raw value. */
    bubble?: React.ReactNode;
    hue?: boolean;
    disabled?: boolean;
    'aria-label'?: string;
    onPointerDown?: (e: React.PointerEvent<HTMLInputElement>) => void;
    onPointerUp?: (e: React.PointerEvent<HTMLInputElement>) => void;
}

/**
 * Design-lab range slider (`.dl-slider`) with a hover value bubble. Replaces
 * the bare `.rng` input so the accent-tracked fill + bubble are consistent.
 * `onPointerDown`/`onPointerUp` are forwarded so callers can bracket a drag
 * for undo-gesture recording (begin/commit).
 */
export const DlSlider: React.FC<DlSliderProps> = ({
    value,
    onChange,
    min = 0,
    max = 100,
    step,
    bubble,
    hue,
    disabled,
    onPointerDown,
    onPointerUp,
    ...aria
}) => {
    const pct = max > min ? ((value - min) / (max - min)) * 100 : 0;
    return (
        <div
            className={`dl-slider ${hue ? 'dl-slider--hue' : ''}`.trim()}
            style={{ ['--_value' as never]: `${pct}%` }}
        >
            <input
                type="range"
                min={min}
                max={max}
                step={step}
                value={value}
                disabled={disabled}
                onChange={(e) => onChange(Number(e.target.value))}
                onPointerDown={onPointerDown}
                onPointerUp={onPointerUp}
                aria-label={aria['aria-label']}
            />
            <span className="dl-slider__bubble">{bubble ?? value}</span>
        </div>
    );
};
