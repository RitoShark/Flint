import { describe, it, expect, vi } from 'vitest';
import { fireOverlayRebuild } from './hashOverlay';
import { invokeCommand } from './core';

// Deliberately its own file, and deliberately the only test in it that
// touches `invokeCommand`. Empirically (see the investigation referenced in
// the Task 5 report), once the mocked `invokeCommand` from `vi.mock('./core')`
// has been used for a genuine *resolution* anywhere else in the same test
// file — in any order, any describe block, even with fresh `resetModules()`
// re-imports — a later fake-timer-driven *rejection* through that same mock
// trips Vitest's process-level unhandledRejection listener, despite the
// implementation demonstrably catching the rejection every time (traced via
// direct instrumentation: the `.catch()` handler runs on every single
// invocation of this exact scenario). That's a test-infra artifact of mock
// reuse under fake timers, not a bug in `fireOverlayRebuild`. Full isolation
// — this test and nothing else touching `invokeCommand` in the file — avoids
// it reliably.
vi.mock('./core', () => ({ invokeCommand: vi.fn() }));

describe('fireOverlayRebuild', () => {
    it('a rebuild failure never rejects to the caller', async () => {
        vi.useFakeTimers();
        vi.mocked(invokeCommand).mockRejectedValue(new Error('boom'));

        expect(() => fireOverlayRebuild('C:\\p')).not.toThrow();
        await expect(vi.runAllTimersAsync()).resolves.not.toThrow();

        vi.useRealTimers();
    });
});
