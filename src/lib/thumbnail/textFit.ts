/** Measures a single line of text at a given font size. Injected so
 *  `fitFontSize` stays pure/testable — the real caller measures with a
 *  canvas 2D context, tests use a cheap fake. */
export type TextMeasure = (text: string, size: number) => { w: number; h: number };

const DEFAULT_MIN_SIZE = 6;

/**
 * Returns the largest font size (<= maxSize, >= minSize) at which every line
 * in `lines` measures within `boxW` and the lines' total height fits within
 * `boxH`. Steps down from maxSize by 1px until it fits or minSize is hit —
 * simple and plenty fast for the handful of sizes/lines a thumbnail editor
 * ever measures per keystroke.
 */
export function fitFontSize(
  measure: TextMeasure,
  lines: string[],
  boxW: number,
  boxH: number,
  maxSize: number,
  minSize: number = DEFAULT_MIN_SIZE,
): number {
  if (lines.length === 0) return maxSize;

  const fits = (size: number): boolean => {
    let totalH = 0;
    for (const line of lines) {
      const { w, h } = measure(line, size);
      if (w > boxW) return false;
      totalH += h;
    }
    return totalH <= boxH;
  };

  for (let size = maxSize; size > minSize; size--) {
    if (fits(size)) return size;
  }
  return minSize;
}
