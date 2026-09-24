export interface Step {
    readonly dt: number;
    readonly now: number;
}

export interface Stepper {
    readonly now: number;
    advance(frameTime: number): Step[];
    reset(now?: number): void;
}

export const MAX_STEPS = 8;

class SimulationClock implements Stepper {
    private elapsed: number;
    private pending = 0;

    constructor(private readonly rate: number | null, now: number) {
        if (rate !== null && (!Number.isFinite(rate) || rate <= 0)) throw new RangeError('Simulation rate must be positive');
        if (!Number.isFinite(now)) throw new RangeError('Simulation time must be finite');
        this.elapsed = now;
    }

    get now(): number { return this.elapsed; }

    reset(now = 0): void {
        if (!Number.isFinite(now)) throw new RangeError('Simulation time must be finite');
        this.elapsed = now;
        this.pending = 0;
    }

    advance(frameTime: number): Step[] {
        if (!Number.isFinite(frameTime)) return [];
        if (this.rate === null) {
            if (frameTime <= 0 || !Number.isFinite(this.elapsed + frameTime)) return [];
            this.elapsed += frameTime;
            return [{now: this.elapsed, dt: frameTime}];
        }
        const pending = this.pending + Math.max(0, frameTime);
        const ticks = Math.floor(pending * this.rate);
        if (!Number.isFinite(ticks) || !Number.isFinite(this.elapsed + pending)) return [];
        this.pending = pending;
        if (ticks < 1) return [];
        const scale = 2 ** Math.max(0, Math.floor(Math.log2(ticks / (MAX_STEPS + 1))) + 1);
        const count = Math.floor(ticks / scale);
        const dt = scale / this.rate;
        this.pending -= count * dt;
        return Array.from({length: count}, () => {
            this.elapsed += dt;
            return {now: this.elapsed, dt};
        });
    }
}

export function variableStepper(now = 0): Stepper {
    return new SimulationClock(null, now);
}

export function fixedRateStepper(rate: number, now = 0): Stepper {
    return new SimulationClock(rate, now);
}
