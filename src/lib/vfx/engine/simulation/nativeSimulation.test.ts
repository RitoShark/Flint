import { describe, expect, it } from 'vitest';
import type { VfxValue } from '../../bindings';
import { nameHash } from '../../binHash';
import type { EmitterModel, SystemModel } from '../model/model';
import { readVfxSystem } from '../parsing/readVfxSystem';
import { constant } from '../parsing/properties';
import { identityInto } from '../utils/basis';
import { Rng } from '../utils/Rng';
import { copyEmitterStates, createEmitterStates, stepEmitters, type SystemStep } from './integrate';
import { copyRows, createPool, writeRows } from './pool';
import { appearance } from './particleRead';
import { createDriver } from './driver';
import type { EmissionSurfaces } from './emissionSurface';

function system(overrides: Partial<EmitterModel> = {}): SystemModel {
    const emitter: VfxValue = {type: 'struct', class: null, classHash: nameHash('VfxEmitterDefinitionData'), object: null, fields: []};
    const root: VfxValue = {type: 'struct', class: null, classHash: nameHash('VfxSystemDefinitionData'), object: null,
        fields: [{hash: nameHash('complexEmitterDefinitionData'), name: null, value: {type: 'container', items: [emitter]}}]};
    const model = readVfxSystem({entry: 'test', name: null, class: null, classHash: root.classHash, root, materials: []});
    return {...model, emitters: [{...model.emitters[0], rate: constant(4), particleLifetime: constant(10), birthVelocity: constant(1, 2, 3), ...overrides}]};
}

const basis = identityInto(new Float32Array(9));
const step = (now: number, dt = 0.1): SystemStep => ({now, dt, origin: [0, 0, 0], moved: [0, 0, 0], yaw: basis, world: basis, stopped: false});

describe('native particle simulation', () => {
    it('invalidates checkpoints when emission surfaces arrive after playback', () => {
        const model = system({singleParticle: true, rate: constant(1), birthVelocity: constant(0, 0, 0)});
        const driver = createDriver(10, {capacity: 4});
        driver.swap(model);
        driver.seek(1);
        const surfaces: EmissionSurfaces = new Map([[model.emitters[0], {
            sample(_time, _rng, out) { out.position.set([42, 0, 0]); out.normal.set([0, 1, 0]); return true; },
        }]]);
        driver.setSurfaces(surfaces);
        expect(driver.pool.position[0]).toBe(42);
        driver.seek(0.5);
        expect(driver.pool.position[0]).toBe(42);
        driver.seek(1);
        expect(driver.pool.position[0]).toBe(42);
    });

    it('ignores invalid seek times without discarding the displayed state', () => {
        const driver = createDriver(10, {capacity: 4});
        driver.swap(system());
        driver.seek(0.5);
        const rows = copyRows(driver.pool);
        const time = driver.time;
        driver.seek(NaN);
        driver.seek(Infinity);
        expect(driver.time).toBe(time);
        expect(copyRows(driver.pool)).toEqual(rows);
    });

    it('rebuilds transient motion after restoring a checkpoint', () => {
        const model = system({acceleration: constant(2, -3, 5), drag: constant(0.1, 0.2, 0.3)});
        const pool = createPool(40);
        let states = createEmitterStates(model.emitters);
        let random = new Rng(347);
        for (let frame = 1; frame <= 10; frame++) stepEmitters(pool, model, step(frame / 10), random, states);
        const rows = copyRows(pool);
        const savedStates = copyEmitterStates(states);
        const savedRandom = random.clone();
        for (let frame = 11; frame <= 20; frame++) stepEmitters(pool, model, step(frame / 10), random, states);
        const expected = copyRows(pool);
        writeRows(pool, rows);
        states = copyEmitterStates(savedStates);
        random = savedRandom.clone();
        for (let frame = 11; frame <= 20; frame++) stepEmitters(pool, model, step(frame / 10), random, states);
        expect(copyRows(pool)).toEqual(expected);
    });

    it('keeps motion independent when systems alternate updates', () => {
        const a = system({acceleration: constant(1, 0, 0)});
        const b = system({acceleration: constant(-200, 17, 99)});
        const pools = [createPool(20), createPool(20), createPool(20)];
        const states = [createEmitterStates(a.emitters), createEmitterStates(a.emitters), createEmitterStates(b.emitters)];
        const random = [new Rng(1), new Rng(1), new Rng(2)];
        for (let frame = 1; frame <= 20; frame++) stepEmitters(pools[0], a, step(frame / 10), random[0], states[0]);
        for (let frame = 1; frame <= 20; frame++) {
            stepEmitters(pools[1], a, step(frame / 10), random[1], states[1]);
            stepEmitters(pools[2], b, step(frame / 10), random[2], states[2]);
        }
        expect(copyRows(pools[1])).toEqual(copyRows(pools[0]));
    });

    it('bounds malformed birth curves to their particle columns', () => {
        const model = system({singleParticle: true, rate: constant(1), birthScale0: constant(2, 3, 4, 999), birthColor: constant(1, 1, 1, 1, 999)});
        const pool = createPool(2);
        pool.birthScale[3] = 17;
        pool.birthColor[4] = 23;
        stepEmitters(pool, model, step(0, 0), new Rng(1), createEmitterStates(model.emitters));
        expect([...pool.birthScale.slice(0, 4)]).toEqual([2, 3, 4, 17]);
        expect(pool.birthColor[4]).toBe(23);
    });

    it('resets missing draw channels when appearance scratch is reused', () => {
        const model = system({singleParticle: true, rate: constant(1), scale0: constant(2), birthScale0: constant(3, 4, 5), color: constant(0.2), birthColor: constant(1, 0.5, 0.25, 0.75)});
        const pool = createPool(1);
        stepEmitters(pool, model, step(0, 0), new Rng(1), createEmitterStates(model.emitters));
        const output = {scale: Float32Array.of(99, 99, 99), color: Float32Array.of(99, 99, 99, 99)};
        appearance(pool, 0, model.emitters[0], 1, output);
        expect([...output.scale]).toEqual([6, 4, 5]);
        expect([...output.color.slice(1)]).toEqual([0.5, 0.25, 0.75]);
    });
});
