import { fnv1a32 } from '../../binHash';
import type { ChildSetModel, InheritanceModel, SystemModel } from '../model/model';
import type { Anchor, Joints, Point } from '../model/rig';
import { addressTheSame, systemSpan } from '../model/systemModel';
import { Rng } from '../utils/Rng';
import { drawCurve, sampleCurve } from '../utils/sampleCurve';
import { bearingInto, copySeen, seenAt, standAt, type Bearing, type Seen } from './childBearing';
import { capacityOf, givePool, takePool } from './childPool';
import type { EmissionSurfaces } from './emissionSurface';
import { copyEmitterStates, createEmitterStates, stepEmitters, worldOf, type EmitterState, type World } from './integrate';
import { frameOf, type DrawFrame, type Source } from './particleRead';
import { copyRows, liveByteLength, rowsByteLength, writeRows, type Pool, type PoolRows } from './pool';

export const MAX_CHILD_DEPTH = 4;
export interface ChildBirth { readonly path: string; readonly emitter: number; readonly slot: number; readonly bornAt: number; readonly depth: number }
export interface Lineage {
    readonly seed: number;
    readonly feeds: Map<string, Source[]>;
    readonly spare: Map<number, Pool[]>;
    readonly births: ChildBirth[];
    meshJoints: ReadonlyMap<string, Joints>;
    surfaces: EmissionSurfaces;
    joints: Joints | null;
    pinned: number | null;
    held: number;
    live: number;
}
export interface Children {
    readonly count: number;
    step(parent: Source, system: SystemModel, dt: number, now: number): void;
    repoint(next: SystemModel): void;
    clear(): void;
    snapshot(): ChildrenSnapshot;
    restore(snapshot: ChildrenSnapshot): void;
    byteLength(): number;
}
export interface Child extends Source {
    system: SystemModel;
    readonly path: string;
    readonly emitter: number;
    readonly slot: number;
    readonly capacity: number;
    states: EmitterState[];
    readonly rng: Rng;
    readonly bornAt: number;
    serial: number | null;
    readonly stopAt: number | null;
    stopped: boolean;
    time: number;
    elapsed: number;
    readonly origin: [number, number, number];
    readonly from: [number, number, number];
    target: Point;
    readonly yaw: Float32Array;
    world: World;
    inheritance: InheritanceModel | null;
    readonly anchor: Anchor | null;
    readonly children: Children;
}
interface ChildCopy extends Omit<Child, 'pool' | 'states' | 'children'> {
    readonly rows: PoolRows;
    readonly states: readonly EmitterState[];
    readonly children: ChildrenSnapshot;
}
export interface ChildrenSnapshot {
    readonly children: readonly ChildCopy[];
    readonly seen: readonly (readonly [number, Seen])[];
    readonly cursor: number;
}
interface Birth {
    set: ChildSetModel;
    emitter: number;
    serial: number;
    age: number;
    carried: boolean;
    bearing: Bearing;
}

export function childPath(prefix: string, emitter: number, slot: number): string { return `${prefix}${emitter}.${slot}`; }
export function childPrefix(path: string): string { return `${path}/`; }
export function createLineage(seed: number): Lineage {
    return {seed, feeds: new Map(), spare: new Map(), births: [], meshJoints: new Map(), surfaces: new Map(), joints: null, pinned: null, held: 0, live: 0};
}
export function feedOf(lineage: Lineage, path: string): Source[] {
    if (!lineage.feeds.has(path)) lineage.feeds.set(path, []);
    return lineage.feeds.get(path)!;
}
export function childIndex(set: ChildSetModel, time: number, draw: () => number): number | null {
    if (!set.children.length || set.bones.length) return null;
    if (set.children.length === 1) return 0;
    const values = set.probability.tables.length ? drawCurve(set.probability, time, draw()) : sampleCurve(set.probability, time);
    return Math.trunc(Math.max(0, values[0] ?? 0)) % set.children.length;
}

function seedFor(seed: number, path: string, serial: number): Rng {
    return new Rng(seed ^ fnv1a32(path) ^ Math.imul(serial + 1, 0x9e3779b1));
}

function clonePlacement(child: Child | ChildCopy) {
    return {origin: [...child.origin] as [number, number, number], from: [...child.from] as [number, number, number],
        yaw: child.yaw.slice(), orientation: child.orientation.slice(), rng: child.rng.clone(), states: copyEmitterStates(child.states)};
}

class ChildSystems implements Children {
    private readonly live = new Set<Child>();
    private readonly seen = new Map<number, Seen>();
    private readonly bearing: Bearing = {place: new Float32Array(3), yaw: new Float32Array(9)};
    private cursor = 0;
    constructor(private readonly lineage: Lineage, private readonly prefix: string, private readonly depth: number) {}
    get count(): number { return this.live.size; }

    private attach(child: Child): void {
        this.live.add(child);
        feedOf(this.lineage, child.path).push(child);
        this.lineage.live++;
        this.lineage.held += child.capacity;
    }
    private release(child: Child): void {
        if (!this.live.delete(child)) return;
        const feed = feedOf(this.lineage, child.path);
        const index = feed.indexOf(child);
        if (index >= 0) feed.splice(index, 1);
        child.children.clear();
        givePool(this.lineage, child.pool, child.capacity);
        this.lineage.live--;
        this.lineage.held -= child.capacity;
    }
    private spawn(birth: Birth, parent: Source, now: number): void {
        const {set, emitter, serial} = birth;
        if (!set.bones.length) {
            const random = seedFor(this.lineage.seed, `${this.prefix}${emitter}`, serial);
            const slot = childIndex(set, birth.age, () => random.unitFloat());
            if (slot !== null) this.spawnOne(birth, parent, now, slot, random, null);
            return;
        }
        if (set.bones.length < set.children.length) return;
        const key = this.prefix ? `${this.prefix.slice(0, -1)}:${emitter}` : String(emitter);
        const meshJoints = this.lineage.meshJoints.get(key);
        const joints = meshJoints ?? this.lineage.joints;
        if (!joints) return;
        for (let slot = 0; slot < set.children.length; slot++) {
            const joint = joints(set.bones[slot]);
            if (!joint) continue;
            const bornAt = now - birth.age;
            const anchor: Anchor = meshJoints ? {
                originAt: time => joint.originAt(time - bornAt),
                basisInto: (time, output) => joint.basisInto(time - bornAt, output),
            } : joint;
            this.spawnOne(birth, parent, now, slot, seedFor(this.lineage.seed, childPath(this.prefix, emitter, slot), serial), anchor);
        }
    }
    private spawnOne(birth: Birth, parent: Source, now: number, slot: number, random: Rng, anchor: Anchor | null): void {
        const model = birth.set.children[slot];
        if (!model) return;
        const capacity = capacityOf(model);
        if (this.lineage.live >= 512 || this.lineage.held + capacity > 131072) return;
        const path = childPath(this.prefix, birth.emitter, slot);
        const child: Child = {system: model, path, emitter: birth.emitter, slot, capacity, pool: takePool(this.lineage, capacity),
            states: createEmitterStates(model.emitters), rng: random, bornAt: now, serial: birth.carried ? birth.serial : null,
            stopAt: birth.carried ? null : now + systemSpan(model), stopped: false, time: now, elapsed: 0,
            origin: [0, 0, 0], from: [0, 0, 0], target: parent.target, yaw: new Float32Array(9), orientation: new Float32Array(9),
            world: worldOf(model), inheritance: birth.set.inheritance, anchor,
            children: new ChildSystems(this.lineage, childPrefix(path), this.depth + 1)};
        standAt(child, birth.bearing, now);
        for (let axis = 0; axis < 3; axis++) child.from[axis] = child.origin[axis];
        this.attach(child);
        if (this.lineage.births.length < 4096) this.lineage.births.push({path, emitter: birth.emitter, slot, bornAt: now, depth: this.depth + 1});
    }
    private advance(child: Child, dt: number, now: number): void {
        child.time = now;
        child.elapsed = now - child.bornAt;
        if (child.stopAt !== null && now >= child.stopAt) child.stopped = true;
        stepEmitters(child.pool, child.system, {dt, now, origin: child.origin,
            moved: [child.origin[0] - child.from[0], child.origin[1] - child.from[1], child.origin[2] - child.from[2]],
            yaw: child.yaw, world: child.world.basis, stopped: child.stopped, pinned: this.lineage.pinned, surfaces: this.lineage.surfaces}, child.rng, child.states);
        child.children.step(child, child.system, dt, now);
        for (let axis = 0; axis < 3; axis++) child.from[axis] = child.origin[axis];
    }
    private finished(child: Child): boolean {
        if (child.pool.count || child.children.count) return false;
        return child.stopped || child.system.emitters.every((emitter, index) => emitter.disabled ||
            (emitter.singleParticle && child.states[index].emitted) || (emitter.lifetime !== null && child.states[index].age > emitter.lifetime));
    }
    step(parent: Source, model: SystemModel, dt: number, now: number): void {
        const pool = parent.pool;
        const sets = model.emitters.map(emitter => emitter.disabled || this.depth >= MAX_CHILD_DEPTH ? null : emitter.childSet);
        if (!this.live.size && !this.seen.size && sets.every(set => set === null)) { this.cursor = pool.born; return; }
        const tracked = new Set(this.seen.keys());
        for (const child of this.live) if (child.serial !== null) tracked.add(child.serial);
        const indices = new Map<number, number>();
        if (tracked.size) {
            for (let index = 0; index < pool.count; index++) if (tracked.has(pool.serial[index])) indices.set(pool.serial[index], index);
        }
        const frames = new Map<number, DrawFrame>();
        const frame = (index: number) => {
            if (!frames.has(index)) frames.set(index, frameOf(parent, model.emitters[index]));
            return frames.get(index)!;
        };
        for (const child of this.live) {
            child.target = parent.target;
            if (child.serial === null) continue;
            const index = indices.get(child.serial);
            if (index === undefined) { child.serial = null; child.stopped = true; continue; }
            const emitter = pool.emitter[index];
            bearingInto(parent, model.emitters[emitter], frame(emitter), index, child.inheritance, this.bearing);
            standAt(child, this.bearing, now);
        }
        for (const child of this.live) this.advance(child, dt, now);
        for (const child of [...this.live].reverse()) if (this.finished(child)) this.release(child);
        for (const [serial, last] of this.seen) {
            if (indices.has(serial)) continue;
            this.seen.delete(serial);
            const set = sets[last.emitter];
            if (set?.onDeath) this.spawn({set, emitter: last.emitter, serial, age: last.lifetime, carried: false, bearing: last}, parent, now);
        }
        for (let index = 0; index < pool.count; index++) {
            const emitter = pool.emitter[index];
            const set = sets[emitter];
            if (!set) continue;
            const serial = pool.serial[index];
            if (set.onDeath) {
                let last = this.seen.get(serial);
                if (!last) { last = seenAt(emitter); this.seen.set(serial, last); }
                last.lifetime = pool.lifetime[index];
                bearingInto(parent, model.emitters[emitter], frame(emitter), index, set.inheritance, last);
            } else if (serial >= this.cursor) {
                bearingInto(parent, model.emitters[emitter], frame(emitter), index, set.inheritance, this.bearing);
                this.spawn({set, emitter, serial, age: 0, carried: true, bearing: this.bearing}, parent, now);
            }
        }
        this.cursor = pool.born;
    }
    repoint(model: SystemModel): void {
        for (const child of [...this.live].reverse()) {
            const set = model.emitters[child.emitter]?.childSet;
            const next = set?.children[child.slot];
            if (!next || !set || !addressTheSame(child.system.emitters, next.emitters)) { this.release(child); continue; }
            child.system = next;
            child.world = worldOf(next);
            child.inheritance = set.inheritance;
            child.children.repoint(next);
        }
    }
    clear(): void {
        for (const child of [...this.live].reverse()) this.release(child);
        this.seen.clear();
        this.cursor = 0;
    }
    snapshot(): ChildrenSnapshot {
        return {cursor: this.cursor, seen: [...this.seen].map(([serial, state]) => [serial, copySeen(state)]),
            children: [...this.live].map(child => {
                const {pool, children, ...state} = child;
                return {...state, ...clonePlacement(child), rows: copyRows(pool), children: children.snapshot()};
            })};
    }
    restore(snapshot: ChildrenSnapshot): void {
        this.clear();
        for (const copy of snapshot.children) {
            const {rows, children: nested, ...state} = copy;
            const pool = takePool(this.lineage, copy.capacity);
            writeRows(pool, rows);
            const children = new ChildSystems(this.lineage, childPrefix(copy.path), this.depth + 1);
            children.restore(nested);
            this.attach({...state, ...clonePlacement(copy), pool, children});
        }
        for (const [serial, state] of snapshot.seen) this.seen.set(serial, copySeen(state));
        this.cursor = snapshot.cursor;
    }
    byteLength(): number {
        let bytes = 0;
        for (const child of this.live) bytes += liveByteLength(child.pool) + child.yaw.byteLength + child.orientation.byteLength + child.children.byteLength();
        for (const last of this.seen.values()) bytes += last.place.byteLength + last.yaw.byteLength;
        return bytes;
    }
}

export function createChildren(lineage: Lineage, prefix: string, depth: number): Children { return new ChildSystems(lineage, prefix, depth); }
export function snapshotByteLength(snapshot: ChildrenSnapshot): number {
    let bytes = 0;
    for (const child of snapshot.children) bytes += rowsByteLength(child.rows) + child.yaw.byteLength + child.orientation.byteLength + snapshotByteLength(child.children);
    for (const [, last] of snapshot.seen) bytes += last.place.byteLength + last.yaw.byteLength;
    return bytes;
}
