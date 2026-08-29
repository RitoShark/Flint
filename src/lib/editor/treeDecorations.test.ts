import { describe, expect, it } from 'vitest';
import { buildTreeDecorations, rollUpFolderTags, strongerTag } from './treeDecorations';

describe('strongerTag', () => {
    it('ranks error above new above modified', () => {
        expect(strongerTag('modified', 'new')).toBe('new');
        expect(strongerTag('new', 'critical')).toBe('critical');
        expect(strongerTag('warning', 'new')).toBe('warning');
        expect(strongerTag(undefined, 'modified')).toBe('modified');
    });
});

describe('rollUpFolderTags', () => {
    it('tags every ancestor up to and including the wad folder', () => {
        const tags = rollUpFolderTags([
            ['content/base/ahri.wad.client/data/characters/ahri/skins/skin0.bin', 'modified'],
        ]);
        expect(tags.get('content/base/ahri.wad.client/data/characters/ahri/skins')).toBe('modified');
        expect(tags.get('content/base/ahri.wad.client/data/characters/ahri')).toBe('modified');
        expect(tags.get('content/base/ahri.wad.client/data/characters')).toBe('modified');
        expect(tags.get('content/base/ahri.wad.client/data')).toBe('modified');
        expect(tags.get('content/base/ahri.wad.client')).toBe('modified');
        expect(tags.has('content/base')).toBe(false);
        expect(tags.has('content')).toBe(false);
    });

    it('keeps the strongest tag when subtrees disagree', () => {
        const tags = rollUpFolderTags([
            ['w.wad.client/data/a/x.bin', 'modified'],
            ['w.wad.client/data/b/y.bin', 'critical'],
            ['w.wad.client/data/a/z.bin', 'new'],
        ]);
        expect(tags.get('w.wad.client/data/a')).toBe('new');
        expect(tags.get('w.wad.client/data/b')).toBe('critical');
        expect(tags.get('w.wad.client/data')).toBe('critical');
        expect(tags.get('w.wad.client')).toBe('critical');
    });

    it('rolls files outside any wad folder to the root folders', () => {
        const tags = rollUpFolderTags([['output/build/mod.fantome', 'new']]);
        expect(tags.get('output/build')).toBe('new');
        expect(tags.get('output')).toBe('new');
    });

    it('a top-level file tags nothing', () => {
        expect(rollUpFolderTags([['flint.json', 'modified']]).size).toBe(0);
    });
});

describe('buildTreeDecorations', () => {
    it('projects absolute keys, merges statuses and issues, and rolls up', () => {
        const deco = buildTreeDecorations(
            'C:/proj',
            [
                ['C:/proj/content/base/Ahri.wad.client/data/Skin0.bin', 'modified'],
                ['C:/other/content/x.bin', 'new'],
            ],
            [['c:/proj/content/base/ahri.wad.client/data/skin0.bin', { severity: 'critical', message: 'boom' }]],
        );

        expect(deco.fileStatus.get('content/base/Ahri.wad.client/data/Skin0.bin')).toBe('modified');
        expect(deco.fileStatus.size).toBe(1);
        expect(deco.fileIssue.get('content/base/ahri.wad.client/data/skin0.bin')?.severity).toBe('critical');
        expect(deco.folderTag.get('content/base/ahri.wad.client/data')).toBe('critical');
        expect(deco.folderTag.get('content/base/ahri.wad.client')).toBe('critical');
        expect(deco.folderTag.has('content/base')).toBe(false);
    });
});
