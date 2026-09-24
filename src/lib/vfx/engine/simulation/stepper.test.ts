import { describe, expect, it } from 'vitest';
import { fixedRateStepper, MAX_STEPS, variableStepper } from './stepper';

describe('particle simulation clock', () => {
    it('keeps backlog scheduling bounded across every coarsening boundary', () => {
        for (let ticks = 1; ticks <= 2048; ticks++) {
            const clock = fixedRateStepper(1);
            const steps = clock.advance(ticks);
            expect(steps.length).toBeLessThanOrEqual(MAX_STEPS);
            expect(steps.length).toBeGreaterThan(0);
            const spent = steps.reduce((seconds, step) => seconds + step.dt, 0);
            expect(spent).toBeLessThanOrEqual(ticks);
            const remainder = clock.advance(0).reduce((seconds, step) => seconds + step.dt, 0);
            expect(spent + remainder).toBeLessThanOrEqual(ticks);
            expect(clock.now).toBe(spent + remainder);
        }
    });

    it('ignores invalid frame deltas without poisoning future frames', () => {
        for (const clock of [variableStepper(), fixedRateStepper(10)]) {
            for (const delta of [NaN, Infinity, -Infinity]) expect(clock.advance(delta)).toEqual([]);
            expect(clock.advance(0.1)).toEqual([{dt: 0.1, now: 0.1}]);
        }
    });

    it('validates rates and reset times', () => {
        for (const rate of [0, -1, NaN, Infinity]) expect(() => fixedRateStepper(rate)).toThrow(RangeError);
        const clock = fixedRateStepper(10);
        clock.advance(0.15);
        expect(() => clock.reset(NaN)).toThrow(RangeError);
        clock.reset(2);
        expect(clock.advance(0.05)).toEqual([]);
        expect(clock.now).toBe(2);
    });
});
