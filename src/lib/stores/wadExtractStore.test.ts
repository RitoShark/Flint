import { describe, it, expect, beforeEach, vi } from 'vitest';

// The store opens a backend WAD edit session for writable non-embedded sessions
// and reads config for the read-only check; neither is under test here.
vi.mock('../api', () => ({
    openWadEditSession: vi.fn(() => new Promise(() => {})),
    closeWadEditSession: vi.fn(() => Promise.resolve()),
    readWadChunkData: vi.fn(() => Promise.resolve(new Uint8Array())),
    readSessionChunk: vi.fn(() => Promise.resolve(new Uint8Array())),
    writeSessionChunk: vi.fn(() => Promise.resolve()),
    renameSessionChunk: vi.fn(() => Promise.resolve('newhash')),
    removeSessionChunk: vi.fn(() => Promise.resolve()),
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

/**
 * Every WAD session reads through a VFS mount, so the browser and preview talk
 * to one interface for WADs, packages and CDN archives alike.
 */
describe('wadExtractStore WAD mounts', () => {
    beforeEach(() => {
        useWadExtractStore.setState({ extractSessions: [], activeExtractId: null });
    });

    const chunks = [
        { hash: 'aa', path: 'data/characters/kayn/skin0.bin', size: 10 },
        { hash: 'bb', path: 'assets/textures/body.tex', size: 20 },
        { hash: 'cc', path: null, size: 30 },
    ];

    it('attaches a hash-keyed mount when chunks arrive', async () => {
        const store = useWadExtractStore.getState();
        store.openSession('user-1', 'C:/wads/kayn.wad.client');
        store.setChunks('user-1', chunks);

        const mount = useWadExtractStore.getState().extractSessions[0].mount;
        expect(mount).toBeDefined();
        // A WAD addresses chunks by hash; keying by path would read the wrong
        // file rather than fail.
        expect(mount!.keyedBy).toBe('hash');

        const root = await mount!.list('');
        expect(root.map(e => e.name).sort()).toEqual(['[Unknown Hashes]', 'assets', 'data'].sort());
    });

    it('lists one level at a time rather than the whole tree', async () => {
        const store = useWadExtractStore.getState();
        store.openSession('user-1', 'C:/wads/kayn.wad.client');
        store.setChunks('user-1', chunks);
        const mount = useWadExtractStore.getState().extractSessions[0].mount!;

        const data = await mount.list('data');
        expect(data).toHaveLength(1);
        expect(data[0]).toMatchObject({ name: 'characters', isDirectory: true });

        const leaf = await mount.list('assets/textures');
        expect(leaf).toHaveLength(1);
        expect(leaf[0]).toMatchObject({ name: 'body.tex', isDirectory: false, key: 'bb' });
    });

    it('re-indexes the existing mount when the chunk set changes', async () => {
        const store = useWadExtractStore.getState();
        store.openSession('user-1', 'C:/wads/kayn.wad.client');
        store.setChunks('user-1', chunks);
        const first = useWadExtractStore.getState().extractSessions[0].mount!;

        // A staged delete re-publishes a smaller chunk list.
        store.setChunks('user-1', chunks.filter(c => c.hash !== 'bb'));
        const second = useWadExtractStore.getState().extractSessions[0].mount!;

        // Same mount object, updated contents — not a fresh mount per edit.
        expect(second).toBe(first);
        const root = await second.list('');
        expect(root.map(e => e.name)).not.toContain('assets');
    });

    it('keeps the same mount object when the edit session opens', async () => {
        const api = await import('../api');
        // The edit session resolves AFTER the chunks land, which is what made
        // this ordering worth pinning down.
        type OpenResult = Awaited<ReturnType<typeof api.openWadEditSession>>;
        let resolveOpen: (v: OpenResult) => void = () => {};
        vi.mocked(api.openWadEditSession).mockReturnValueOnce(
            new Promise<OpenResult>((res) => { resolveOpen = res; }),
        );

        const store = useWadExtractStore.getState();
        store.openSession('user-1', 'C:/wads/kayn.wad.client');
        store.setChunks('user-1', chunks);
        const before = useWadExtractStore.getState().extractSessions[0].mount!;
        expect(before.caps.write).toBe(false);

        resolveOpen({ session_id: 'edit-1', source_path: 'C:/wads/kayn.wad.client', initial_chunk_count: chunks.length });
        await new Promise((r) => setTimeout(r, 0));

        const after = useWadExtractStore.getState().extractSessions[0].mount!;
        // Identity must hold: the browser caches directory listings against it,
        // so a swap here collapses every folder the user had opened.
        expect(after).toBe(before);
        expect(after.caps.write).toBe(true);
    });

    it('walks into a folder and back out through history', () => {
        const store = useWadExtractStore.getState();
        store.openSession('user-1', 'C:/wads/kayn.wad.client');
        store.setChunks('user-1', chunks);
        const s = () => useWadExtractStore.getState().extractSessions[0];

        store.setCurrentDir('user-1', 'data');
        store.setCurrentDir('user-1', 'data/characters');
        expect(s().currentDir).toBe('data/characters');

        store.navigateHistory('user-1', 'back');
        expect(s().currentDir).toBe('data');

        store.navigateHistory('user-1', 'forward');
        expect(s().currentDir).toBe('data/characters');

        store.navigateHistory('user-1', 'up');
        expect(s().currentDir).toBe('data');
        store.navigateHistory('user-1', 'up');
        expect(s().currentDir).toBe('');
    });

    it('treats the unresolved-hash folder as a root-level folder', () => {
        const store = useWadExtractStore.getState();
        store.openSession('user-1', 'C:/wads/kayn.wad.client');
        store.setChunks('user-1', chunks);
        const s = () => useWadExtractStore.getState().extractSessions[0];

        // It has no '/' in its name, so "up" must land back at the root rather
        // than leaving currentDir pointing at a folder that does not exist.
        store.setCurrentDir('user-1', '[Unknown Hashes]');
        store.navigateHistory('user-1', 'up');
        expect(s().currentDir).toBe('');
    });

    it('leaves a modpkg mount alone instead of replacing it with a WAD mount', () => {
        const store = useWadExtractStore.getState();
        store.openSession('archive-modpkg-1', 'C:/mods/kayn.modpkg', undefined, {
            mountBacked: true,
            embedded: true,
        });
        const pkgMount = {
            id: 'modpkg:1', label: 'kayn.modpkg',
            caps: { write: true, rename: true, remove: true, add: true },
            keyedBy: 'path' as const,
            list: async () => [], search: async () => [], read: async () => new Uint8Array(),
        };
        store.setSessionMount('archive-modpkg-1', pkgMount);
        store.setChunks('archive-modpkg-1', [{ hash: 'x/y.bin', path: 'x/y.bin', size: 1 }]);

        const mount = useWadExtractStore.getState().extractSessions[0].mount;
        expect(mount).toBe(pkgMount);
        expect(mount!.keyedBy).toBe('path');
    });
});
