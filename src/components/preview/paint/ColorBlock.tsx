import React from 'react';
import type { ColorKeyframe } from '../../../lib/api/paint';

/** Which slot column this block belongs to. Size comes from CSS (a
 *  `--paint-block-*` custom property per variant), never from inline styles. */
export type ColorBlockVariant = 'standard' | 'secondary' | 'wide';

interface ColorBlockProps {
    colors: ColorKeyframe[];
    title: string;
    variant?: ColorBlockVariant;
    /** Slot switched off in the toolbar. Kept in the DOM (just invisible) so the
     *  block columns stay aligned across rows. */
    hidden?: boolean;
    onClick?: (e: React.MouseEvent) => void;
}

function rgbaToCss(rgba: number[]): string {
    if (!rgba || rgba.length < 3) return 'transparent';
    const toInt = (v: number) => Math.round(Math.max(0, Math.min(1, v)) * 255);
    const a = rgba[3] !== undefined ? Math.max(0, Math.min(1, rgba[3])) : 1;
    return `rgba(${toInt(rgba[0])}, ${toInt(rgba[1])}, ${toInt(rgba[2])}, ${a})`;
}

const alphaOf = (c: ColorKeyframe) => (c.rgba[3] !== undefined ? c.rgba[3] : 1);

/**
 * A colour slot rendered as the thing it actually is: one solid block for a
 * constant, a left-to-right gradient for an animated list. Colours are drawn at
 * their REAL alpha over a checkerboard that only appears when something is
 * genuinely translucent.
 *
 * An absent slot still renders (as a hollow placeholder) so the blocks stay in
 * fixed columns down the list — that vertical alignment is what makes a long
 * emitter list scannable.
 */
export const ColorBlock: React.FC<ColorBlockProps> = React.memo(function ColorBlock({
    colors,
    title,
    variant = 'standard',
    hidden = false,
    onClick,
}) {
    const className = `paint-block paint-block--${variant}${hidden ? ' paint-block--off' : ''}`;

    if (!colors || colors.length === 0) {
        return (
            <span
                className={`${className} paint-block--empty`}
                title={`${title}: not present on this emitter`}
            />
        );
    }

    let background: string;
    if (colors.length === 1) {
        background = rgbaToCss(colors[0].rgba);
    } else {
        // Clamp the gradient to the block's full width so the first and last
        // keyframes stay visible even when their times don't span 0..1.
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
        <span className={className} title={tooltip} onClick={onClick} role={onClick ? 'button' : undefined}>
            {hasAlpha && <span className="paint-block__checker" />}
            {/* The only inline style in the panel: the computed gradient itself,
                which is data and cannot live in a stylesheet. */}
            <span className="paint-block__fill" style={{ background }} />
        </span>
    );
});
