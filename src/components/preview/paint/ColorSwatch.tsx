import React from 'react';
import { describeVec4, vec4ToCss } from '../../../lib/paint/colorMath';
import type { Vec4 } from '../../../lib/paint/colorMath';

interface ColorSwatchProps {
    rgba: Vec4;
    /** Shown in the tooltip ahead of the color, e.g. "birthColor kf 2". */
    label?: string;
    size?: number;
}

/**
 * One keyframe's color. The checkerboard sits *behind* the color layer rather
 * than being blended into it, so a translucent keyframe reads as translucent
 * instead of as a lighter opaque color.
 */
export const ColorSwatch: React.FC<ColorSwatchProps> = ({ rgba, label, size = 16 }) => (
    <span
        className="paint-swatch"
        style={{ width: size, height: size }}
        title={label ? `${label} — ${describeVec4(rgba)}` : describeVec4(rgba)}
    >
        <span className="paint-swatch__fill" style={{ background: vec4ToCss(rgba) }} />
    </span>
);
