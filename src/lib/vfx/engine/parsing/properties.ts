import type { NamedAsset, VfxValue } from '../../bindings';
import { nameHash } from '../../binHash';
import type { CurveKey, ProbabilityTable } from '../model/curve';
import type { ValueCurve } from '../model/model';

const names = new Map<string, string>();
function propertyHash(name: string): string {
    let hash = names.get(name);
    if (hash === undefined) {
        hash = nameHash(name);
        names.set(name, hash);
    }
    return hash;
}

export function numeric(node: VfxValue | null | undefined): number | null {
    return node?.type === 'number' && Number.isFinite(node.value) ? node.value : null;
}

export function components(node: VfxValue | null | undefined): number[] | null {
    if (node?.type === 'number') {
        const value = numeric(node);
        return value === null ? null : [value];
    }
    return node?.type === 'vector' && node.values.every(Number.isFinite) ? [...node.values] : null;
}

export function namedAsset(node: VfxValue | null): NamedAsset | null {
    const path = node?.type === 'string' ? node.value : node?.type === 'asset' ? node.path : '';
    return path ? { path, asset: node?.type === 'asset' ? node.asset : null } : null;
}

export function constant(...constant: number[]): ValueCurve {
    return { constant, keys: [], tables: [] };
}

export class Properties {
    private readonly fields = new Map<string, VfxValue>();

    constructor(readonly node: VfxValue | null) {
        if (node?.type === 'struct') {
            for (const field of node.fields) {
                if (!this.fields.has(field.hash)) this.fields.set(field.hash, field.value);
            }
        }
    }

    get valid(): boolean { return this.node?.type === 'struct'; }
    is(name: string): boolean { return this.node?.type === 'struct' && this.node.classHash === propertyHash(name); }
    get(name: string): VfxValue | null { return this.byHash(propertyHash(name)); }
    byHash(hash: string): VfxValue | null { return this.fields.get(hash) ?? null; }
    child(name: string): Properties { return new Properties(this.get(name)); }
    number(name: string, fallback = 0): number { return numeric(this.get(name)) ?? fallback; }
    optionalNumber(name: string): number | null { return numeric(this.get(name)); }
    text(name: string, fallback = ''): string {
        const node = this.get(name);
        return node?.type === 'string' ? node.value : fallback;
    }
    bool(name: string, fallback = false): boolean {
        const node = this.get(name);
        return node?.type === 'bool' ? node.value : fallback;
    }
    list(name: string): VfxValue[] {
        const node = this.get(name);
        return node?.type === 'container' ? node.items : [];
    }
    objects(name: string): Properties[] {
        return this.list(name).filter(node => node.type === 'struct').map(node => new Properties(node));
    }
    hashes(name: string): string[] {
        return this.list(name).flatMap(node => node.type === 'hash' ? [node.hash] : []);
    }
    strings(name: string): string[] {
        return this.list(name).filter(node => node.type === 'string').map(node => node.value);
    }
    asset(name: string): NamedAsset | null { return namedAsset(this.get(name)); }
    vec2(name: string, fallback: readonly number[] = [0, 0]): [number, number] {
        const values = components(this.get(name));
        return [values?.[0] ?? fallback[0], values?.[1] ?? fallback[1]];
    }
    vec3(name: string, fallback: readonly number[] = [0, 0, 0]): [number, number, number] {
        const values = components(this.get(name));
        return [values?.[0] ?? fallback[0], values?.[1] ?? fallback[1], values?.[2] ?? fallback[2]];
    }
    vec4(name: string, fallback: readonly number[] = [0, 0, 0, 0]): [number, number, number, number] {
        const values = components(this.get(name));
        return [values?.[0] ?? fallback[0], values?.[1] ?? fallback[1], values?.[2] ?? fallback[2], values?.[3] ?? fallback[3]];
    }
    matrix(name: string): number[] | null {
        const node = this.get(name);
        if (node?.type !== 'matrix') return null;
        const values = node.values.flat();
        return values.length === 16 && values.every(Number.isFinite) ? values : null;
    }
    enum<T extends number>(name: string, options: Readonly<Record<string, T>>, fallback: T): T {
        const value = this.optionalNumber(name);
        return value !== null && Number.isInteger(value) && Object.values(options).includes(value as T) ? value as T : fallback;
    }
    curve(name: string, fallback: readonly number[] = [0]): ValueCurve {
        return this.child(name).asCurve(fallback);
    }
    asCurve(fallback: readonly number[] = [0]): ValueCurve {
        if (!this.valid) return constant(...fallback);
        const base = components(this.get('constantValue')) ?? [...fallback];
        const dynamics = this.child('dynamics');
        return {
            constant: base,
            keys: readKeys(dynamics.list('times'), dynamics.list('values')),
            tables: dynamics.list('probabilityTables').flatMap((node, channel): ProbabilityTable[] => {
                const table = new Properties(node);
                if (!table.valid) return [];
                const times = table.get('keyTimes');
                const values = table.get('keyValues');
                if (times?.type !== 'container' || values?.type !== 'container') {
                    return [{channel, single: table.number('singleValue', 1), keys: []}];
                }
                if (times.items.length > 0 && times.items.length !== values.items.length) {
                    return [{channel, single: 0, keys: []}];
                }
                return [{channel, single: table.number('singleValue', 1), keys: readKeys(times.items, values.items, true)}];
            }),
        };
    }
}

function readKeys(times: VfxValue[], values: VfxValue[], scalar = false): CurveKey[] {
    const result: CurveKey[] = [];
    times.forEach((node, index) => {
        const time = numeric(node);
        const value = values[index];
        if (time === null || (scalar && value?.type !== 'number')) return;
        const channels = components(value);
        if (channels) result.push({ time, values: channels });
    });
    return result;
}
