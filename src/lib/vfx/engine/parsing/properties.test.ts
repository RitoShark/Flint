import { describe, expect, it } from 'vitest';
import type { VfxValue } from '../../bindings';
import { nameHash } from '../../binHash';
import { Properties } from './properties';
import { readVfxSystem } from './readVfxSystem';

function object(fields: Record<string, VfxValue>): Extract<VfxValue, {type: 'struct'}> {
    return {
        type: 'struct', classHash: nameHash('VfxSystemDefinitionData'), class: null, object: null,
        fields: Object.entries(fields).map(([name, value]) => ({name, hash: nameHash(name), value})),
    };
}
const scalar = (value: number): VfxValue => ({type: 'number', value});
const list = (...items: VfxValue[]): VfxValue => ({type: 'container', items});

describe('native VFX property decoding', () => {
    it('indexes the first authored field and does not mutate the input', () => {
        const node = object({rate: scalar(7)});
        node.fields.push({...node.fields[0], value: scalar(99)});
        const before = structuredClone(node);
        expect(new Properties(node).number('RATE')).toBe(7);
        expect(node).toEqual(before);
    });

    it('uses defaults for nonfinite scalars and incomplete vectors', () => {
        const p = new Properties(object({
            rate: scalar(Infinity), velocity: {type: 'vector', values: [1, NaN, 3]},
            offset: {type: 'vector', values: [5]},
        }));
        expect(p.number('rate', 3)).toBe(3);
        expect(p.vec3('velocity', [4, 5, 6])).toEqual([4, 5, 6]);
        expect(p.vec3('offset', [4, 5, 6])).toEqual([5, 5, 6]);
    });

    it('accepts both native matrix rows and flat matrix cells', () => {
        const rows = [[1,0,0,0], [0,1,0,0], [0,0,1,0], [7,8,9,1]];
        for (const values of [rows, rows.flat()]) {
            expect(new Properties(object({transform: {type: 'matrix', values}})).matrix('transform')).toEqual(rows.flat());
        }
        expect(new Properties(object({transform: {type: 'matrix', values: [1, 2]}})).matrix('transform')).toBeNull();
    });

    it('keeps probability channel positions and disables mismatched keyed tables', () => {
        const p = new Properties(object({birthScale0: object({
            constantValue: {type: 'vector', values: [2, 3, 4]},
            dynamics: object({probabilityTables: list(
                {type: 'null'},
                object({singleValue: scalar(2)}),
                object({keyTimes: list(scalar(0), scalar(1)), keyValues: list(scalar(5))}),
            )}),
        })}));
        expect(p.curve('birthScale0').tables).toEqual([
            {channel: 1, single: 2, keys: []}, {channel: 2, single: 0, keys: []},
        ]);
    });

    it('drops invalid curve pairs without sorting authored key order', () => {
        const node = object({dynamics: object({
            times: list(scalar(1), scalar(NaN), scalar(0), scalar(2)),
            values: list(scalar(4), scalar(5), scalar(6)),
        })});
        expect(new Properties(node).asCurve([3]).keys).toEqual([
            {time: 1, values: [4]}, {time: 0, values: [6]},
        ]);
    });

    it('keeps unresolved and cyclic child slots without recursing forever', () => {
        const root = object({});
        const childSet = object({childrenIdentifiers: list(
            object({effect: root}), object({effect: {type: 'link', hash: '0x00000001', name: null}}),
        )});
        root.fields.push(...object({complexEmitterDefinitionData: list(object({childParticleSetDefinition: childSet}))}).fields);
        const result = readVfxSystem({entry: '0x00000002', name: null, classHash: root.classHash, class: null, root, materials: []});
        expect(result.emitters[0].childSet?.children).toEqual([null, null]);
    });
});
