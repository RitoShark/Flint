import React from 'react';
import type { ColorKeyframe } from '../../../lib/api/paint';

export type ColorBlockVariant = 'standard' | 'secondary' | 'wide';

interface ColorBlockProps {
    colors: ColorKeyframe[];
    title: string;
    variant?: ColorBlockVariant;
    onClick?: (e: React.MouseEvent) => void;
}

const DIMENSIONS: Record<ColorBlockVariant, { width: number; height: number }> = {
    standard: { width: 40, height: 26 },
    secondary: { width: 34, height: 24 },
    wide: { width: 110, height: 26 },
};

function rgbaToCss(rgba: number[]): string {
    if (!rgba || rgba.length < 3) return 'transparent';
    const toInt = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    const a = rgba[3] !== undefined ? Math.max(0, Math.min(1, rgba[3])) : 1;
    return `rgba(${toInt(rgba[0])}, ${toInt(rgba[1])}, ${toInt(rgba[2])}, ${a})`;
}

const alphaOf = (c: ColorKeyframe) => (c.rgba[3] !== undefined ? c.rgba[3] : 1);

/**
 * A color slot rendered as the thing it actually is: one solid block for a
 * constant, a left-to-right gradient for an animated list. Colors are drawn with
 * their REAL alpha over a checkerboard, so a translucent keyframe reads as
 * translucent instead of as a lighter opaque color.
 */
export const ColorBlock: React.FC<ColorBlockProps> = React.memo(function ColorBlock({
    colors,
    title,
    variant = 'standard',
    onClick,
}) {
    const dims = DIMENSIONS[variant];

    if (!colors || colors.length === 0) {
        return (
            <span
                className="paint-block paint-block--empty"
                style={{ width: dims.width, height: dims.height }}
                title={`${title}: not present on this emitter`}
            />
        );
    }

    let background: string;
    if (colors.length === 1) {
        background = rgbaToCss(colors[0].rgba);
    } else {
        // Clamp the gradient to the block's full width so the first and last
        // keyframes are visible even when their times don't span 0..1.
        const sorted = [...colors].sort((a, b) => a.time - b.time);
        const stops = [
            `${rgbaToCss(sorted[0].rgba)} 0%`,
            ...sorted.map((c) => `${rgbaToCss(c.rgba)} ${c.time * 100}%`),
            `${rgbaToCss(sorted[sorted.length - 1].rgba)} 100%`,
        ];
        background = `linear-gradient(90deg, ${stops.join(', ')})`;
    }

    const hasAlpha = colors.some((c) => alphaOf(c) < 0.999);
    const tooltip =
        colors.length === 1
            ? `${title}: ${colors[0].rgba.map((v) => v.toFixed(2)).join(', ')}`
            : `${title}: ${colors.length} keyframes`;

    return (
        <span
            className="paint-block"
            style={{ width: dims.width, height: dims.height }}
            title={tooltip}
            onClick={onClick}
            role={onClick ? 'button' : undefined}
        >
            {hasAlpha && <span className="paint-block__checker" />}
            <span className="paint-block__fill" style={{ background }} />
        </span>
    );
});
