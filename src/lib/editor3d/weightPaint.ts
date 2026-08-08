export type BrushMode = 'add' | 'subtract' | 'replace' | 'smooth';

export interface BrushSettings {
    mode: BrushMode;
    radius: number;
    strength: number;
    falloff: number;
}

export interface WeightBuffers {
    vertexCount: number;
    jointIds: Uint16Array;
    weights: Float32Array;
}

export interface Influence {
    jointId: number;
    weight: number;
}

const SLOTS = 4;
const EPSILON = 1e-4;

export function buildWeightBuffers(
    boneIndices: Uint8Array,
    boneWeights: Float32Array,
    influenceTable: ArrayLike<number>,
): WeightBuffers {
    const vertexCount = Math.floor(boneIndices.length / SLOTS);
    const jointIds = new Uint16Array(vertexCount * SLOTS);
    const weights = new Float32Array(vertexCount * SLOTS);
    for (let i = 0; i < vertexCount * SLOTS; i++) {
        const slot = boneIndices[i];
        jointIds[i] = slot < influenceTable.length ? influenceTable[slot] : slot;
        weights[i] = boneWeights[i];
    }
    return { vertexCount, jointIds, weights };
}

export function influencesOf(buffers: WeightBuffers, vertex: number): Influence[] {
    const base = vertex * SLOTS;
    const out: Influence[] = [];
    for (let s = 0; s < SLOTS; s++) {
        const w = buffers.weights[base + s];
        if (w > EPSILON) out.push({ jointId: buffers.jointIds[base + s], weight: w });
    }
    out.sort((a, b) => b.weight - a.weight);
    return out;
}

export function weightOf(buffers: WeightBuffers, vertex: number, jointId: number): number {
    const base = vertex * SLOTS;
    for (let s = 0; s < SLOTS; s++) {
        if (buffers.jointIds[base + s] === jointId) return buffers.weights[base + s];
    }
    return 0;
}

/**
 * Writes `target` into the vertex's slot for `jointId`, then rescales the other slots so the four
 * sum to 1. Returns false when the joint is absent and every slot already carries real weight —
 * a .skn has exactly four, so something has to give and the caller decides nothing does.
 */
export function setNormalizedWeight(
    buffers: WeightBuffers,
    vertex: number,
    jointId: number,
    target: number,
): boolean {
    const base = vertex * SLOTS;
    const clamped = Math.min(1, Math.max(0, target));

    let slot = -1;
    for (let s = 0; s < SLOTS; s++) {
        if (buffers.jointIds[base + s] === jointId && buffers.weights[base + s] > 0) {
            slot = s;
            break;
        }
    }
    if (slot < 0) {
        if (clamped <= EPSILON) return true;
        let weakest = -1;
        let weakestWeight = Infinity;
        for (let s = 0; s < SLOTS; s++) {
            const w = buffers.weights[base + s];
            if (w < weakestWeight) {
                weakestWeight = w;
                weakest = s;
            }
        }
        if (weakest < 0 || weakestWeight >= clamped) return false;
        slot = weakest;
        buffers.jointIds[base + slot] = jointId;
        buffers.weights[base + slot] = 0;
    }

    let others = 0;
    for (let s = 0; s < SLOTS; s++) {
        if (s !== slot) others += buffers.weights[base + s];
    }

    buffers.weights[base + slot] = clamped;
    const remainder = 1 - clamped;
    if (others > EPSILON) {
        const scale = remainder / others;
        for (let s = 0; s < SLOTS; s++) {
            if (s !== slot) buffers.weights[base + s] *= scale;
        }
    } else if (remainder > EPSILON) {
        buffers.weights[base + slot] = 1;
    }

    for (let s = 0; s < SLOTS; s++) {
        if (buffers.weights[base + s] <= EPSILON) {
            buffers.weights[base + s] = 0;
            buffers.jointIds[base + s] = 0;
        }
    }
    return true;
}

export function falloffAt(distance: number, radius: number, exponent: number): number {
    if (radius <= 0) return 0;
    const t = Math.min(1, Math.max(0, distance / radius));
    return Math.pow(1 - t * t, Math.max(0.01, exponent));
}

export interface StrokeSample {
    center: [number, number, number];
    positions: Float32Array;
    paintable: Uint8Array;
    jointId: number;
    brush: BrushSettings;
}

export interface StrokeResult {
    touched: number[];
    blocked: number;
}

/**
 * Applies one brush dab in place. `positions` is the global vertex buffer in the same space the
 * viewport renders, `paintable` gates vertices belonging to hidden submeshes.
 */
export function applyStroke(buffers: WeightBuffers, sample: StrokeSample): StrokeResult {
    const { center, positions, paintable, jointId, brush } = sample;
    const [cx, cy, cz] = center;
    const r2 = brush.radius * brush.radius;
    const touched: number[] = [];
    let blocked = 0;

    const inRange: number[] = [];
    const falloffs: number[] = [];
    for (let v = 0; v < buffers.vertexCount; v++) {
        if (!paintable[v]) continue;
        const dx = positions[v * 3] - cx;
        const dy = positions[v * 3 + 1] - cy;
        const dz = positions[v * 3 + 2] - cz;
        const d2 = dx * dx + dy * dy + dz * dz;
        if (d2 > r2) continue;
        inRange.push(v);
        falloffs.push(falloffAt(Math.sqrt(d2), brush.radius, brush.falloff));
    }
    if (inRange.length === 0) return { touched, blocked };

    let neighbourhoodAverage = 0;
    if (brush.mode === 'smooth') {
        for (const v of inRange) neighbourhoodAverage += weightOf(buffers, v, jointId);
        neighbourhoodAverage /= inRange.length;
    }

    for (let i = 0; i < inRange.length; i++) {
        const v = inRange[i];
        const amount = brush.strength * falloffs[i];
        if (amount <= 0) continue;
        const current = weightOf(buffers, v, jointId);

        let target: number;
        switch (brush.mode) {
            case 'add':
                target = current + amount;
                break;
            case 'subtract':
                target = current - amount;
                break;
            case 'replace':
                target = current + (1 - current) * amount;
                break;
            case 'smooth':
                target = current + (neighbourhoodAverage - current) * amount;
                break;
        }
        if (Math.abs(target - current) < EPSILON) continue;

        if (setNormalizedWeight(buffers, v, jointId, target)) touched.push(v);
        else blocked++;
    }

    return { touched, blocked };
}

const RAMP: ReadonlyArray<readonly [number, number, number]> = [
    [0.10, 0.10, 0.32],
    [0.00, 0.45, 0.95],
    [0.00, 0.85, 0.55],
    [0.95, 0.90, 0.10],
    [0.95, 0.15, 0.10],
];

export function rampColor(weight: number): [number, number, number] {
    const t = Math.min(1, Math.max(0, weight)) * (RAMP.length - 1);
    const lo = Math.floor(t);
    const hi = Math.min(RAMP.length - 1, lo + 1);
    const f = t - lo;
    return [
        RAMP[lo][0] + (RAMP[hi][0] - RAMP[lo][0]) * f,
        RAMP[lo][1] + (RAMP[hi][1] - RAMP[lo][1]) * f,
        RAMP[lo][2] + (RAMP[hi][2] - RAMP[lo][2]) * f,
    ];
}

export function writeWeightColors(
    buffers: WeightBuffers,
    jointId: number,
    colors: Float32Array,
    vertices?: Iterable<number>,
): void {
    const paint = (v: number) => {
        const [r, g, b] = rampColor(weightOf(buffers, v, jointId));
        colors[v * 4] = r;
        colors[v * 4 + 1] = g;
        colors[v * 4 + 2] = b;
        colors[v * 4 + 3] = 1;
    };
    if (vertices) {
        for (const v of vertices) paint(v);
    } else {
        for (let v = 0; v < buffers.vertexCount; v++) paint(v);
    }
}

export interface WeightEntryPayload {
    vertex: number;
    joints: number[];
    weights: number[];
}

export function entriesFor(buffers: WeightBuffers, vertices: Iterable<number>): WeightEntryPayload[] {
    const out: WeightEntryPayload[] = [];
    for (const v of vertices) {
        const influences = influencesOf(buffers, v);
        if (influences.length === 0) continue;
        out.push({
            vertex: v,
            joints: influences.map((i) => i.jointId),
            weights: influences.map((i) => i.weight),
        });
    }
    return out;
}
