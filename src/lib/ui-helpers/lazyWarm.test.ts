import { describe, it, expect, beforeEach, vi } from 'vitest';

async function freshModule() {
    vi.resetModules();
    return await import('./lazyWarm');
}

function flush() {
    return new Promise<void>(resolve => setTimeout(resolve, 0));
}

async function settle(times = 8) {
    for (let i = 0; i < times; i++) await flush();
}

function stubComponent(name: string) {
    return { default: () => null, name };
}

describe('lazyWarm', () => {
    beforeEach(() => {
        vi.resetModules();
    });

    it('loads nothing until warming starts', async () => {
        const { lazyWarm } = await freshModule();
        const load = vi.fn(async () => stubComponent('a'));
        lazyWarm(load);
        await settle();
        expect(load).not.toHaveBeenCalled();
    });

    it('loads every registered component once warming starts', async () => {
        const { lazyWarm, warmLazyComponents } = await freshModule();
        const first = vi.fn(async () => stubComponent('first'));
        const second = vi.fn(async () => stubComponent('second'));
        lazyWarm(first);
        lazyWarm(second);
        warmLazyComponents();
        await settle();
        expect(first).toHaveBeenCalledTimes(1);
        expect(second).toHaveBeenCalledTimes(1);
    });

    it('loads components registered after warming started', async () => {
        const { lazyWarm, warmLazyComponents } = await freshModule();
        warmLazyComponents();
        await settle();
        const late = vi.fn(async () => stubComponent('late'));
        lazyWarm(late);
        await settle();
        expect(late).toHaveBeenCalledTimes(1);
    });

    it('keeps loading after one component fails', async () => {
        const { lazyWarm, warmLazyComponents } = await freshModule();
        const broken = vi.fn(async () => { throw new Error('chunk gone'); });
        const after = vi.fn(async () => stubComponent('after'));
        lazyWarm(broken as never);
        lazyWarm(after);
        warmLazyComponents();
        await settle();
        expect(broken).toHaveBeenCalledTimes(1);
        expect(after).toHaveBeenCalledTimes(1);
    });

    it('imports a module once when warming and rendering race', async () => {
        const { lazyWarm, warmLazyComponents } = await freshModule();
        const load = vi.fn(async () => stubComponent('shared'));
        const Component = lazyWarm(load) as unknown as { _payload: { _result: () => Promise<unknown> } };
        warmLazyComponents();
        await settle();
        await Component._payload._result();
        expect(load).toHaveBeenCalledTimes(1);
    });
});
