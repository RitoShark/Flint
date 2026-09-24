import type { SystemModel } from '../model/model';
import { displacement, facingAt, FIRST_RIG, flightTime, landed, originAt, phaseAt, runLength, targetAt, type Joints, type Point, type RigModel } from '../model/rig';
import { addressTheSame, emptySystem, lingerTail, systemSpan } from '../model/systemModel';
import { flightInto, multiplyInto, turnInto, yawInto } from '../utils/basis';
import { Rng } from '../utils/Rng';
import { createCheckpoints } from './checkpoints';
import { createChildren, createLineage, feedOf, snapshotByteLength, type ChildBirth, type ChildrenSnapshot } from './children';
import type { EmissionSurfaces } from './emissionSurface';
import { copyEmitterStates, createEmitterStates, stepEmitters, worldOf, type EmitterState, type SystemStep } from './integrate';
import type { Source } from './particleRead';
import { copyRows, createPool, liveByteLength, rowsByteLength, writeRows, type Pool, type PoolRows } from './pool';
import { variableStepper } from './stepper';

const tick = 1 / 60;
const seekLimit = 3600;
const checkpointInterval = 0.25;
const zero: Point = [0, 0, 0];

export interface Histogram {
    readonly bin: number;
    readonly bins: number;
    readonly reached: number;
    counts(emitter: number): Uint16Array;
}

class ParticleHistogram implements Histogram {
    readonly bin = tick;
    bins = 1;
    reached = -1;
    private lanes: Uint16Array[] = [];
    private live = new Uint32Array(0);
    resize(emitters: number, duration: number): void {
        this.bins = Math.max(1, Math.ceil(Math.min(duration, seekLimit * tick) / tick));
        this.lanes = Array.from({length: emitters}, () => new Uint16Array(this.bins));
        this.live = new Uint32Array(emitters);
        this.reached = -1;
    }
    counts(emitter: number): Uint16Array { return this.lanes[emitter] ?? new Uint16Array(0); }
    reach(phase: number): void { this.reached = Math.min(this.bins - 1, Math.max(0, Math.floor(phase / tick))); }
    tally(pool: Pool, phase: number): void {
        this.live.fill(0);
        for (let index = 0; index < pool.count; index++) {
            const emitter = pool.emitter[index];
            if (emitter >= 0 && emitter < this.live.length) this.live[emitter]++;
        }
        this.reach(phase);
        this.lanes.forEach((lane, emitter) => { lane[this.reached] = Math.min(65535, this.live[emitter]); });
    }
}

interface Snapshot {
    readonly step: number;
    readonly bytes: number;
    readonly time: number;
    readonly phase: number;
    readonly position: Point;
    readonly rows: PoolRows;
    readonly states: readonly EmitterState[];
    readonly random: Rng;
    readonly children: ChildrenSnapshot;
    readonly births: readonly ChildBirth[];
}

export interface Driver extends Source {
    readonly phase: number;
    readonly histogram: Histogram;
    advance(frameTime: number): void;
    seek(time: number): void;
    restart(): void;
    pin(chance: number | null): void;
    setSurfaces(surfaces: EmissionSurfaces): void;
    setMeshJoints(joints: ReadonlyMap<string, Joints>): void;
    swap(system: SystemModel): void;
    steer(rig: RigModel): void;
    sources(path: string): readonly Source[];
    liveChildren(): number;
    births(): readonly ChildBirth[];
}
export interface DriverOptions { readonly capacity?: number; readonly seekable?: boolean }

class ParticlePlayback implements Driver {
    readonly pool: Pool;
    readonly histogram = new ParticleHistogram();
    readonly orientation = new Float32Array(9);
    private readonly clock = variableStepper();
    private readonly history = createCheckpoints<Snapshot>(240, 256 * 1024 * 1024);
    private readonly lineage: ReturnType<typeof createLineage>;
    private readonly children: ReturnType<typeof createChildren>;
    private readonly yaw = new Float32Array(9);
    private readonly vector = new Float32Array(3);
    private model = emptySystem(null);
    private rig: RigModel = FIRST_RIG.rig;
    private span = systemSpan(this.model);
    private tail = lingerTail(this.model, flightTime(this.rig.motion));
    private world = worldOf(this.model);
    private random: Rng;
    private states: EmitterState[] = [];
    private previousPhase = 0;
    private position: Point = originAt(this.rig.motion, 0, this.rig.height);
    private warming: {time: number; age: number} | null = null;

    constructor(private readonly seed: number, private readonly options: DriverOptions) {
        this.pool = createPool(options.capacity ?? 32768);
        this.random = new Rng(seed);
        this.lineage = createLineage(seed);
        this.lineage.joints = this.rig.joints ?? null;
        this.children = createChildren(this.lineage, '', 0);
        this.resizeHistogram();
    }
    get time(): number { return this.warming?.time ?? this.clock.now; }
    get phase(): number { return phaseAt(this.rig, this.clock.now, this.span, this.tail); }
    get elapsed(): number { return this.warming?.age ?? this.phase + this.model.buildUpTime; }
    get origin(): Point { return this.transform(this.position, true); }
    get target(): Point { return this.transform(targetAt(this.rig.motion, this.phase, this.rig.height), true); }
    sources(path: string): readonly Source[] { return feedOf(this.lineage, path); }
    liveChildren(): number { return this.lineage.live; }
    births(): readonly ChildBirth[] { return this.lineage.births; }

    private transform(value: Point, translate = false): Point {
        this.vector.set(value);
        turnInto(this.world.basis, this.vector, 0);
        const offset = translate ? this.world.offset : zero;
        return [this.vector[0] + offset[0], this.vector[1] + offset[1], this.vector[2] + offset[2]];
    }
    private orient(phase: number): void {
        const motion = this.rig.motion;
        if (motion.kind === 'bone') motion.anchor.basisInto(phase, this.yaw);
        else if (motion.kind === 'path') flightInto(facingAt(motion, phase), this.yaw);
        else yawInto(facingAt(motion, phase), this.yaw);
        multiplyInto(this.world.basis, this.yaw, this.orientation);
    }
    private resizeHistogram(): void {
        this.histogram.resize(this.model.emitters.length, runLength(this.rig.motion, this.span, this.tail));
    }
    private simulate(dt: number, now: number, origin: Point, moved: Point, stopped: boolean): void {
        const step: SystemStep = {dt, now, origin, moved, stopped, yaw: this.yaw, world: this.world.basis,
            pinned: this.lineage.pinned, surfaces: this.lineage.surfaces};
        stepEmitters(this.pool, this.model, step, this.random, this.states);
    }
    private warmup(end: number, phase: number): void {
        const count = Math.round(this.model.buildUpTime / tick);
        if (count <= 0) return;
        this.orient(phase);
        const origin = this.origin;
        try {
            for (let frame = 1; frame <= count; frame++) {
                const now = end - (count - frame) * tick;
                this.warming = {time: now, age: frame * tick};
                this.simulate(tick, now, origin, zero, false);
                this.children.step(this, this.model, tick, now);
            }
        } finally { this.warming = null; }
    }
    private clearRun(): void {
        this.pool.count = 0;
        this.children.clear();
        this.lineage.births.length = 0;
        this.states = createEmitterStates(this.model.emitters);
    }
    private reset(): void {
        this.clearRun();
        this.pool.born = 0;
        this.random = new Rng(this.seed);
        this.clock.reset();
        this.previousPhase = 0;
        this.position = originAt(this.rig.motion, 0, this.rig.height);
        this.warmup(0, 0);
        this.orient(0);
        this.resizeHistogram();
    }
    private snapshot(): Snapshot {
        const rows = copyRows(this.pool);
        const children = this.children.snapshot();
        return {time: this.clock.now, step: Math.round(this.clock.now / tick), phase: this.previousPhase, position: this.position,
            rows, children, states: copyEmitterStates(this.states), random: this.random.clone(), births: this.lineage.births.slice(),
            bytes: rowsByteLength(rows) + snapshotByteLength(children)};
    }
    private restore(snapshot: Snapshot): void {
        writeRows(this.pool, snapshot.rows);
        this.clock.reset(snapshot.time);
        this.random = snapshot.random.clone();
        this.states = copyEmitterStates(snapshot.states);
        this.previousPhase = snapshot.phase;
        this.position = snapshot.position;
        this.children.restore(snapshot.children);
        this.lineage.births.length = 0;
        this.lineage.births.push(...snapshot.births);
        this.orient(snapshot.phase);
    }
    private keep(): void {
        if (this.options.seekable === false) return;
        const mark = Math.floor(this.clock.now / checkpointInterval);
        if (this.history.wants(mark)) this.history.keep(mark, liveByteLength(this.pool) + this.children.byteLength(), () => this.snapshot());
    }
    advance = (frameTime: number): void => {
        for (const step of this.clock.advance(frameTime)) {
            const phase = this.phase;
            if (phase < this.previousPhase) {
                this.clearRun();
                this.position = originAt(this.rig.motion, 0, this.rig.height);
                this.histogram.reached = -1;
                this.warmup(step.now - step.dt, 0);
            }
            this.previousPhase = phase;
            const next = originAt(this.rig.motion, phase, this.rig.height);
            const moved = this.transform(displacement(this.position, next));
            this.orient(phase);
            this.simulate(step.dt, step.now, this.transform(next, true), moved,
                (this.rig.stopAt != null && phase >= this.rig.stopAt) || landed(this.rig.motion, phase));
            this.position = next;
            this.children.step(this, this.model, step.dt, step.now);
            this.histogram.tally(this.pool, phase);
            this.keep();
        }
    };
    seek = (time: number): void => {
        if (!Number.isFinite(time)) return;
        const target = Math.round(Math.min(60, Math.max(0, time)) / tick);
        const snapshot = this.history.latest(Math.floor(target * tick / checkpointInterval), target);
        if (snapshot) this.restore(snapshot);
        else this.reset();
        for (let frame = snapshot?.step ?? 0; frame < target; frame++) this.advance(tick);
        this.histogram.reach(this.phase);
    };
    restart = (): void => { this.history.clear(); this.reset(); };
    pin(chance: number | null): void { this.lineage.pinned = chance; this.history.clear(); }
    private replayAssets(): void {
        const frames = Math.min(seekLimit, Math.floor(this.clock.now / tick));
        this.history.clear();
        this.reset();
        for (let frame = 0; frame < frames; frame++) this.advance(tick);
    }
    setSurfaces(surfaces: EmissionSurfaces): void {
        if (surfaces === this.lineage.surfaces) return;
        this.lineage.surfaces = surfaces;
        this.replayAssets();
    }
    setMeshJoints(joints: ReadonlyMap<string, Joints>): void {
        if (joints === this.lineage.meshJoints) return;
        this.lineage.meshJoints = joints;
        this.replayAssets();
    }
    swap(model: SystemModel): void {
        const compatible = addressTheSame(this.model.emitters, model.emitters);
        this.model = model;
        this.world = worldOf(model);
        this.span = systemSpan(model);
        this.tail = lingerTail(model, flightTime(this.rig.motion));
        this.previousPhase = this.phase;
        this.orient(this.phase);
        this.history.clear();
        this.resizeHistogram();
        if (compatible) this.children.repoint(model);
        else {
            this.clearRun();
            this.warmup(this.clock.now, this.previousPhase);
        }
    }
    steer(rig: RigModel): void {
        const changedKind = rig.motion.kind !== this.rig.motion.kind;
        this.rig = rig;
        this.tail = lingerTail(this.model, flightTime(rig.motion));
        this.lineage.joints = rig.joints ?? null;
        this.history.clear();
        if (changedKind) this.reset();
        else {
            this.previousPhase = this.phase;
            this.position = originAt(rig.motion, this.phase, rig.height);
            this.orient(this.phase);
            this.resizeHistogram();
        }
    }
}

export function createDriver(seed: number, options: DriverOptions = {}): Driver {
    return new ParticlePlayback(seed, options);
}
