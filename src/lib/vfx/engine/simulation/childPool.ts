import type { SystemModel } from '../model/model';
import { lingerSeconds, peak } from '../model/systemModel';
import { createPool, type Pool } from './pool';
import type { Lineage } from './children';

export function capacityOf(system: SystemModel): number {
    const required = system.emitters.reduce((total, emitter) => {
        if (emitter.disabled) return total;
        const rate = peak(emitter.rate);
        const count = emitter.singleParticle ? Math.max(1, Math.trunc(rate) & 65535)
            : Math.ceil(rate * (peak(emitter.particleLifetime) + lingerSeconds(emitter))) + Math.ceil(rate) + 1;
        return total + count;
    }, 0);
    return 2 ** Math.min(12, Math.max(4, Math.ceil(Math.log2(Math.max(1, required)))));
}

export function takePool(lineage: Lineage, capacity: number): Pool {
    const cached = lineage.spare.get(capacity)?.pop() ?? createPool(capacity);
    cached.count = cached.born = 0;
    return cached;
}

export function givePool(lineage: Lineage, pool: Pool, capacity: number): void {
    if (pool.capacity !== capacity) throw new RangeError('Particle pool capacity mismatch');
    const cached = lineage.spare.get(capacity);
    if (!cached) lineage.spare.set(capacity, [pool]);
    else if (cached.length < 32 && !cached.includes(pool)) cached.push(pool);
}
