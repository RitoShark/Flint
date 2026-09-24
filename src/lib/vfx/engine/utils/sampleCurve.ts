import type { CurveKey, ProbabilityTable } from '../model/curve';
import type { ValueCurve } from '../model/model';

type Output = number[] | Float32Array;

function segment(keys: readonly CurveKey[], time: number): number {
    let next = 0;
    while (next < keys.length && !(keys[next].time > time)) next++;
    return Math.max(0, next - 1);
}

function blend(keys: readonly CurveKey[], index: number, time: number, channel: number, fallback: number): number {
    const a = keys[index];
    const b = keys[index + 1];
    const first = a?.values[channel] ?? fallback;
    if (!a || !b || time <= a.time || b.time <= a.time) return first;
    const factor = Math.min(1, (time - a.time) / (b.time - a.time));
    return first + ((b.values[channel] ?? first) - first) * factor;
}

function evaluate(value: ValueCurve, time: number, output: Output, offset: number, chance?: number): void {
    const index = segment(value.keys, time);
    const width = value.keys.length ? value.keys[index].values.length : value.constant.length;
    const count = Math.min(width, output.length - offset);
    for (let channel = 0; channel < count; channel++) {
        let result = value.keys.length ? blend(value.keys, index, time, channel, 0) : value.constant[channel];
        if (chance !== undefined) {
            for (const table of value.tables) {
                if (table.channel === channel) result *= tableValue(table, chance);
            }
        }
        output[offset + channel] = result;
    }
}

export function tableValue(table: ProbabilityTable, chance: number): number {
    return table.keys.length ? blend(table.keys, segment(table.keys, chance), chance, 0, table.single) : table.single;
}

export function sampleCurveInto(value: ValueCurve, time: number, output: Float32Array, offset: number): void {
    evaluate(value, time, output, offset);
}

export function drawCurveInto(value: ValueCurve, time: number, chance: number, output: Float32Array, offset: number): void {
    evaluate(value, time, output, offset, chance);
}

export function keysAt(keys: readonly CurveKey[], time: number): number[] {
    const values = new Array<number>(keys[0]?.values.length ?? 0).fill(0);
    evaluate({constant: [], keys, tables: []}, time, values, 0);
    return values;
}

export function sampleCurve(value: ValueCurve, time: number): readonly number[] {
    return value.keys.length ? keysAt(value.keys, time) : value.constant;
}

export function drawCurve(value: ValueCurve, time: number, chance: number): number[] {
    const values = new Array<number>(value.keys[0]?.values.length ?? value.constant.length).fill(0);
    evaluate(value, time, values, 0, chance);
    return values;
}
