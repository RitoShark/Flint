import { describe, it, expect, beforeEach, vi } from 'vitest';

// The store opens a backend WAD edit session for writable non-embedded sessions
// and reads config for the read-only check; neither is under test here.
vi.mock('../api', () => ({
    openWadEditSession: vi.fn(() => new Promise(() => {})),
    closeWadEditSession: vi.fn(() => Promise.resolve()),
}));

import { useWadExtractStore } from './wadExtractStore';

/**
 * Embedded sessions are the ones the archive editor opens for its own panes.
 * They are not tabs, and the bug these cover is that they used to seize the
 * global active id — which blanked whatever the user actually had open and put
 * a phantom tab in the strip.
 */
describe('wadExtractStore embedded sessions', () => {
    beforeEach(() => {
        useWadExtractStore.setState({ extractSessions: [], activeExtractId: null });
    });

    it('does not let an embedded session take the active id from a user session', () => {
        const store = useWadExtractStore.getState();
        store.openSession('user-1', 'C:/wads/evelynn.wad.client');
        expect(useWadExtractStore.getState().activeExtractId).toBe('user-1');

        store.openSession('archive-modpkg-1', 'C:/mods/kayn.modpkg', undefined, {
            mountBacked: true,
            embedded: true,
        });

        // The user's WAD tab stays active; the embedded session is addressed by
        // id, not by being "current".
        expect(useWadExtractStore.getState().activeExtractId).toBe('user-1');
        expect(useWadExtractStore.getState().extractSessions).toHaveLength(2);
    });

    it('marks embedded sessions so surfaces can exclude them from the tab strip', () => {
        const store = useWadExtractStore.getState();
        store.openSession('user-1', 'C:/wads/evelynn.wad.client');
        store.openSession('archive-modpkg-1', 'C:/mods/kayn.modpkg', undefined, {
            mountBacked: true,
            embedded: true,
        });

        const sessions = useWadExtractStore.getState().extractSessions;
        expect(sessions.find(s => s.id === 'user-1')?.embedded).toBeFalsy();
        expect(sessions.find(s => s.id === 'archive-modpkg-1')?.embedded).toBe(true);
    });

    it('leaves the active id null rather than falling back to an embedded session', () => {
        const store = useWadExtractStore.getState();
        store.openSession('user-1', 'C:/wads/evelynn.wad.client');
        store.openSession('archive-modpkg-1', 'C:/mods/kayn.modpkg', undefined, {
            mountBacked: true,
            embedded: true,
        });

        // Closing the only user-facing session must not promote the archive
        // editor's internal session into the tab strip.
        const { newActiveId } = useWadExtractStore.getState().closeSession('user-1');
        expect(newActiveId).toBeNull();
        expect(useWadExtractStore.getState().activeExtractId).toBeNull();
    });

    it('still activates a newly opened user session', () => {
        const store = useWadExtractStore.getState();
        store.openSession('user-1', 'C:/wads/a.wad.client');
        store.openSession('user-2', 'C:/wads/b.wad.client');
        expect(useWadExtractStore.getState().activeExtractId).toBe('user-2');
    });
});
