import { describe, it, expect, vi } from 'vitest';

// The mounts only need these API functions to exist; the tests below never hit
// a real backend, they assert routing and capability honesty.
vi.mock('../api', () => ({
    readWadChunkData: vi.fn(async () => new Uint8Array([1, 2, 3])),
    readSessionChunk: vi.fn(async () => new Uint8Array([4, 5])),
    writeSessionChunk: vi.fn(async () => undefined),
    renameSessionChunk: vi.fn(async () => 'newhash'),
    removeSessionChunk: vi.fn(async () => undefined),
    cdnReadInner: vi.fn(async () => new ArrayBuffer(2)),
}));

const api = await import('../api');
const { mountWad, mountCdnWad } = await import('./wadMount');

const CHUNKS = [
    { hash: 'h1', path: 'data/characters/jhin/skin0.bin', size: 10 },
    { hash: 'h2', path: 'data/characters/jhin/skin1.bin', size: 20 },
    { hash: 'h3', path: 'assets/body.tex', size: 30 },
    { hash: 'h4', path: null },
];

describe('mountWad', () => {
    const mount = mountWad('E:/game/Jhin.wad.client', CHUNKS);

    it('labels itself with the file name, not the whole path', () => {
        expect(mount.label).toBe('Jhin.wad.client');
    });

    it('is read-only, and exposes no mutating methods at all', () => {
        expect(mount.caps).toEqual({ write: false, rename: false, remove: false, add: false });
        // Capability flags and the actual surface must agree — a caller checking
        // `mount.write` should not find a method that would throw.
        expect(mount.write).toBeUndefined();
        expect(mount.rename).toBeUndefined();
        expect(mount.remove).toBeUndefined();
        expect(mount.add).toBeUndefined();
    });

    it('lists one level at a time', async () => {
        expect((await mount.list('')).map((e) => e.name)).toEqual([
            '[Unknown Hashes]', 'assets', 'data',
        ]);
        expect((await mount.list('data/characters/jhin')).map((e) => e.name))
            .toEqual(['skin0.bin', 'skin1.bin']);
    });

    it('reads bytes by chunk hash, not by display path', async () => {
        const [entry] = await mount.list('assets');
        await mount.read(entry);
        expect(api.readWadChunkData).toHaveBeenCalledWith('E:/game/Jhin.wad.client', 'h3');
    });
});

describe('mount search', () => {
    const mount = mountWad('x.wad.client', CHUNKS);

    it('treats a query with no metacharacter as a plain substring', async () => {
        const hits = await mount.search('jhin');
        expect(hits.map((e) => e.key)).toEqual(['h1', 'h2']);
    });

    it('keeps a bare dot literal so an extension search works', async () => {
        // A regex '.' would match every character and return everything.
        const hits = await mount.search('.tex');
        expect(hits.map((e) => e.key)).toEqual(['h3']);
    });

    it('engages regex once a real metacharacter appears', async () => {
        const hits = await mount.search('skin\\d\\.bin$');
        expect(hits.map((e) => e.key)).toEqual(['h1', 'h2']);
    });

    it('falls back to substring on an invalid regex instead of throwing', async () => {
        await expect(mount.search('skin0[')).resolves.toEqual([]);
    });

    it('returns everything for an empty query', async () => {
        expect(await mount.search('   ')).toHaveLength(4);
    });
});

/**
 * A WAD is mounted read-only and gains write access when its edit session
 * finishes opening, which happens shortly AFTER the chunks arrive. The upgrade
 * is in place because the browser caches directory listings against mount
 * identity — a replacement object would collapse the user's open folders.
 */
describe('attachEditSession', () => {
    function editable() {
        const mount = mountWad('C:/wads/jhin.wad.client', CHUNKS);
        mount.attachEditSession('sess-1');
        return mount;
    }

    it('starts read-only before a session is attached', () => {
        const mount = mountWad('C:/wads/jhin.wad.client', CHUNKS);
        expect(mount.caps.write).toBe(false);
        expect(mount.write).toBeUndefined();
    });

    it('permits writes, renames and removes once attached', () => {
        const mount = editable();
        expect(mount.caps.write).toBe(true);
        expect(mount.caps.rename).toBe(true);
        expect(mount.caps.remove).toBe(true);
        expect(mount.write).toBeDefined();
        expect(mount.rename).toBeDefined();
        expect(mount.remove).toBeDefined();
    });

    it('does not claim `add` while no command can hash a new path', () => {
        const mount = editable();
        expect(mount.caps.add).toBe(false);
        expect(mount.add).toBeUndefined();
    });

    it('routes each mutation to its session command', async () => {
        const mount = editable();
        const [entry] = await mount.list('assets');
        const bytes = new Uint8Array([9]);

        await mount.write!(entry, bytes);
        expect(api.writeSessionChunk).toHaveBeenCalledWith('sess-1', 'h3', bytes);

        await mount.rename!(entry, 'assets/renamed.tex');
        expect(api.renameSessionChunk).toHaveBeenCalledWith('sess-1', 'h3', 'assets/renamed.tex');

        await mount.remove!(entry);
        expect(api.removeSessionChunk).toHaveBeenCalledWith('sess-1', 'h3');
    });

    it('reads through the session so staged edits are visible', async () => {
        const mount = editable();
        const [entry] = await mount.list('assets');
        await mount.read(entry);
        expect(api.readSessionChunk).toHaveBeenCalledWith('sess-1', 'h3');
    });

    it('resolves rename to void rather than leaking the new hash', async () => {
        const mount = editable();
        const [entry] = await mount.list('assets');
        await expect(mount.rename!(entry, 'assets/x.tex')).resolves.toBeUndefined();
    });

    it('does not make other read-only mounts writable', () => {
        editable();
        const other = mountWad('C:/wads/other.wad.client', CHUNKS);
        // A shared frozen caps constant mutated in place would leak here.
        expect(other.caps.write).toBe(false);
    });
});

describe('mountCdnWad', () => {
    const mount = mountCdnWad('cdn-1', 7, 'Remote Jhin', CHUNKS);

    it('is read-only', () => {
        expect(mount.caps).toEqual({ write: false, rename: false, remove: false, add: false });
    });

    it('reads through the session and file index', async () => {
        const [entry] = await mount.list('assets');
        const bytes = await mount.read(entry);
        expect(api.cdnReadInner).toHaveBeenCalledWith('cdn-1', 7, 'h3');
        expect(bytes).toBeInstanceOf(Uint8Array);
    });
});

describe('unresolved hashes', () => {
    it('stay reachable under the synthetic folder', async () => {
        const mount = mountWad('x.wad.client', CHUNKS);
        const entries = await mount.list('[Unknown Hashes]');
        expect(entries.map((e) => e.key)).toEqual(['h4']);
    });
});
