export type EffectFields = Record<string, unknown>;

export function record(value: unknown): EffectFields {
    return value !== null && typeof value === 'object' && !Array.isArray(value) ? value as EffectFields : {};
}

export function number(value: unknown, fallback = 0): number {
    return typeof value === 'number' && Number.isFinite(value) ? value : fallback;
}

function components(value: unknown, fallback: number[]): number[] {
    if (Array.isArray(value)) return fallback.map((v, i) => number(value[i], v));
    return fallback.map(v => number(value, v));
}

function interpolate(times: unknown, values: unknown, time: number, fallback: number[]): number[] {
    if (!Array.isArray(times) || !Array.isArray(values)) return fallback;
    const keys = times.map((t, i) => ({ time: number(t, NaN), value: values[i] }))
        .filter(k => Number.isFinite(k.time) && k.value !== undefined).sort((a, b) => a.time - b.time);
    if (!keys.length) return fallback;
    const right = keys.findIndex(k => k.time > time);
    if (right === 0) return components(keys[0].value, fallback);
    if (right < 0) return components(keys[keys.length - 1].value, fallback);
    const a = keys[right - 1], b = keys[right];
    const fraction = (time - a.time) / (b.time - a.time);
    const left = components(a.value, fallback), next = components(b.value, fallback);
    return left.map((v, i) => v + (next[i] - v) * fraction);
}

export function sampleEffectValue(value: unknown, time: number, fallback: number[], rolls: number[] = []): number[] {
    if (typeof value === 'number' || Array.isArray(value)) return components(value, fallback);
    const data = record(value);
    const base = components(data.constantValue, fallback);
    const dynamics = record(data.dynamics);
    const multiplier = interpolate(dynamics.times, dynamics.values, time, fallback.map(() => 1));
    const tables = Array.isArray(dynamics.probabilityTables) ? dynamics.probabilityTables : [];
    return base.map((v, i) => {
        const table = record(tables[i]);
        const probability = interpolate(table.keyTimes, table.keyValues, rolls[i] ?? 0.5, [1])[0];
        return v * multiplier[i] * probability;
    });
}
