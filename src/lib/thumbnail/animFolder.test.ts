import { describe, it, expect } from 'vitest';
import { buildAnmClips, shortClipLabel, fullClipLabel, type AnmFile } from './animFolder';

const f = (fileName: string): AnmFile => ({ fileName, path: `C:/anims/${fileName}` });

describe('shortClipLabel', () => {
    it('drops the skin suffix League bakes into the filename', () => {
        expect(shortClipLabel('idle01.skins_diana_skin77.anm')).toBe('idle01');
    });

    it('leaves a plain name alone', () => {
        expect(shortClipLabel('Recall.anm')).toBe('Recall');
    });

    it('is case-insensitive about the extension', () => {
        expect(shortClipLabel('Run.SKINS_Diana.ANM')).toBe('Run');
    });
});

describe('fullClipLabel', () => {
    it('keeps everything but the extension', () => {
        expect(fullClipLabel('idle01.skins_diana_skin77.anm')).toBe('idle01.skins_diana_skin77');
    });
});

describe('buildAnmClips', () => {
    it('uses short labels when they are unambiguous', () => {
        const clips = buildAnmClips([f('idle01.skins_diana_skin77.anm'), f('recall.skins_diana_skin77.anm')]);
        expect(clips.map(c => c.name)).toEqual(['idle01', 'recall']);
    });

    it('keeps the absolute path for baking', () => {
        const [clip] = buildAnmClips([f('idle01.skins_diana_skin77.anm')]);
        expect(clip.animation_path).toBe('C:/anims/idle01.skins_diana_skin77.anm');
        expect(clip.track_name).toBeNull();
    });

    it('falls back to full stems for BOTH files when short labels collide', () => {
        const clips = buildAnmClips([
            f('idle01.skins_diana_skin77.anm'),
            f('idle01.skins_diana_skin12.anm'),
        ]);
        expect(clips.map(c => c.name).sort()).toEqual([
            'idle01.skins_diana_skin12',
            'idle01.skins_diana_skin77',
        ]);
    });

    it('does not let a collision spoil unrelated short labels', () => {
        const clips = buildAnmClips([
            f('idle01.skins_a.anm'),
            f('idle01.skins_b.anm'),
            f('recall.skins_a.anm'),
        ]);
        expect(clips.find(c => c.animation_path.endsWith('recall.skins_a.anm'))?.name).toBe('recall');
    });

    it('sorts by display label', () => {
        const clips = buildAnmClips([f('run.skins_x.anm'), f('attack.skins_x.anm'), f('idle.skins_x.anm')]);
        expect(clips.map(c => c.name)).toEqual(['attack', 'idle', 'run']);
    });

    it('returns nothing for an empty folder', () => {
        expect(buildAnmClips([])).toEqual([]);
    });
});
