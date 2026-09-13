import React from 'react';

type Warmer = () => Promise<unknown>;

const warmers: Warmer[] = [];
let cursor = 0;
let started = false;
let draining = false;

function idle(): Promise<void> {
    return new Promise(resolve => {
        if (typeof requestIdleCallback === 'function') {
            requestIdleCallback(() => resolve(), { timeout: 300 });
        } else {
            setTimeout(resolve, 0);
        }
    });
}

async function drain(): Promise<void> {
    if (draining) return;
    draining = true;
    while (cursor < warmers.length) {
        const warm = warmers[cursor++];
        await idle();
        await warm().catch(() => undefined);
    }
    draining = false;
}

export function lazyWarm<T extends React.ComponentType<any>>(load: () => Promise<{ default: T }>) {
    let loading: Promise<{ default: T }> | null = null;
    const once = () => (loading ??= load());
    warmers.push(once);
    if (started) void drain();
    return React.lazy(once);
}

export function warmLazyComponents(): void {
    started = true;
    void drain();
}
