import { describe, it, expect } from 'vitest';
import { configFromDraft, draftFromConfig, type ModConfig } from './modInfo';

const BASE: ModConfig = {
    name: 'my-mod',
    display_name: 'My Mod',
    version: '1.0.0',
    description: 'A mod',
    authors: ['Alice', { name: 'Bob', role: 'VFX' }],
};

describe('draftFromConfig', () => {
    it('reads both author shapes', () => {
        const draft = draftFromConfig(BASE);
        expect(draft.authors).toEqual([
            { name: 'Alice', role: '' },
            { name: 'Bob', role: 'VFX' },
        ]);
    });

    it('reads the legacy tagged author shapes', () => {
        const draft = draftFromConfig({
            authors: [{ Name: 'Carol' }, { NameAndRole: { name: 'Dan', role: 'Art' } }] as never,
        });
        expect(draft.authors.map((a) => a.name)).toEqual(['Carol', 'Dan']);
        expect(draft.authors[1].role).toBe('Art');
    });

    it('tells an SPDX license from a custom one', () => {
        expect(draftFromConfig({ license: 'MIT' }).licenseKind).toBe('spdx');
        expect(draftFromConfig({ license: { name: 'Mine', url: 'https://x' } }).licenseKind).toBe('custom');
        expect(draftFromConfig({}).licenseKind).toBe('none');
    });
});

describe('configFromDraft', () => {
    it('keeps keys the editor does not model', () => {
        const config: ModConfig = { ...BASE, transformers: [{ name: 'tex' }], hashtables: [{ Path: 'x' }] };
        const saved = configFromDraft(config, draftFromConfig(config));
        expect(saved.transformers).toEqual([{ name: 'tex' }]);
        expect(saved.hashtables).toEqual([{ Path: 'x' }]);
        expect(saved.name).toBe('my-mod');
    });

    it('writes a bare string for an author with no role', () => {
        const saved = configFromDraft(BASE, draftFromConfig(BASE));
        expect(saved.authors).toEqual(['Alice', { name: 'Bob', role: 'VFX' }]);
    });

    it('drops an author whose name is blank', () => {
        const draft = draftFromConfig(BASE);
        draft.authors.push({ name: '   ', role: 'Ghost' });
        expect(configFromDraft(BASE, draft).authors).toHaveLength(2);
    });

    it('deletes an emptied optional key instead of writing it empty', () => {
        const config: ModConfig = { ...BASE, license: 'MIT', tags: ['ui'], thumbnail: 'thumb.webp' };
        const draft = draftFromConfig(config);
        draft.licenseKind = 'none';
        draft.tags = [];
        draft.thumbnail = '';
        const saved = configFromDraft(config, draft);
        expect('license' in saved).toBe(false);
        expect('tags' in saved).toBe(false);
        expect('thumbnail' in saved).toBe(false);
    });

    it('round-trips unchanged', () => {
        const config: ModConfig = {
            ...BASE,
            license: { name: 'Mine', url: 'https://example.test' },
            tags: ['champion-skin', 'sfx'],
            champions: ['Ahri'],
            maps: ['summoners-rift'],
            thumbnail: 'thumbnail.webp',
        };
        expect(configFromDraft(config, draftFromConfig(config))).toEqual(config);
    });
});
