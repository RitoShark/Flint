import { describe, it, expect } from 'vitest';
import { filterManifests } from './cdnManifestStore';
import type { ManifestEntryDto } from '../api/cdn';

const E = (kind: 'game' | 'client' | 'other', patch: string): ManifestEntryDto => ({
    artifact_type: kind, kind, version: `${patch}+blah`, patch, url: `http://x/${patch}-${kind}.manifest`,
});

describe('filterManifests', () => {
    const list = [E('game', '16.12.1'), E('client', '16.12.1'), E('other', '16.12.1')];
    it('Game shows only game-client', () => {
        expect(filterManifests(list, 'game').map(e => e.kind)).toEqual(['game']);
    });
    it('Client shows only client-content', () => {
        expect(filterManifests(list, 'client').map(e => e.kind)).toEqual(['client']);
    });
    it('All shows everything', () => {
        expect(filterManifests(list, 'all')).toHaveLength(3);
    });
});
