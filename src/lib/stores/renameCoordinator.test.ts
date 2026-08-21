import { describe, it, expect, beforeEach } from 'vitest';
import { retargetRelativePath } from './renameCoordinator';
import { editorSessionStore } from './editorSessionStore';
import { useFileEditorStore } from './fileEditorStore';

describe('retargetRelativePath', () => {
    it('rewrites the renamed file itself', () => {
        expect(retargetRelativePath('content/base/x.wad.client/data/a.bin', 'content/base/x.wad.client/data/a.bin', 'content/base/x.wad.client/data/b.bin'))
            .toBe('content/base/x.wad.client/data/b.bin');
    });

    it('rewrites files beneath a renamed folder', () => {
        expect(retargetRelativePath('content/base/x.wad.client/data/a.bin', 'content/base/x.wad.client', 'content/base/y.wad.client'))
            .toBe('content/base/y.wad.client/data/a.bin');
    });

    it('leaves unrelated paths alone', () => {
        expect(retargetRelativePath('content/base/x.wad.client/data/a.bin', 'content/base/x.wad.client/data/ab.bin', 'content/base/x.wad.client/data/c.bin'))
            .toBeNull();
    });

    it('matches across separator and case differences', () => {
        expect(retargetRelativePath('content\\base\\X.wad.client\\data\\a.bin', 'content/base/x.wad.client', 'content/base/y.wad.client'))
            .toBe('content/base/y.wad.client\\data\\a.bin');
    });
});

describe('fileEditorStore.retargetFile', () => {
    beforeEach(() => {
        useFileEditorStore.setState({ tabs: [], activeId: null, target: null, dirty: false });
    });

    it('keeps the tab id, position and dirty flag while moving its path', () => {
        const store = useFileEditorStore.getState();
        const firstId = store.openTarget({ filePath: 'C:/p/data/a.bin', kind: 'binText' });
        const secondId = store.openTarget({ filePath: 'C:/p/data/b.bin', kind: 'binText' });
        useFileEditorStore.getState().setDirty(true);

        useFileEditorStore.getState().retargetFile('C:/p/data/b.bin', 'C:/p/data/renamed.bin');

        const { tabs, activeId, target, dirty } = useFileEditorStore.getState();
        expect(tabs.map((t) => t.id)).toEqual([firstId, secondId]);
        expect(tabs[1].target.filePath).toBe('C:/p/data/renamed.bin');
        expect(activeId).toBe(secondId);
        expect(target?.filePath).toBe('C:/p/data/renamed.bin');
        expect(dirty).toBe(true);
    });

    it('moves tabs beneath a renamed folder', () => {
        const store = useFileEditorStore.getState();
        store.openTarget({ filePath: 'C:/p/content/base/x.wad.client/data/a.bin', kind: 'binText' });

        useFileEditorStore.getState().retargetFile('C:/p/content/base/x.wad.client', 'C:/p/content/base/y.wad.client');

        expect(useFileEditorStore.getState().tabs[0].target.filePath)
            .toBe('C:/p/content/base/y.wad.client/data/a.bin');
    });
});

describe('editorSessionStore.rename', () => {
    beforeEach(() => {
        editorSessionStore.clear();
    });

    it('carries unsaved text onto the new path', () => {
        editorSessionStore.save('C:/p/data/a.bin', {
            fileVersion: 2,
            content: 'edited',
            originalContent: 'on disk',
        });

        editorSessionStore.rename('C:/p/data/a.bin', 'C:/p/data/b.bin');

        expect(editorSessionStore.get('C:/p/data/a.bin')).toBeUndefined();
        expect(editorSessionStore.get('C:/p/data/b.bin')?.content).toBe('edited');
    });

    it('moves sessions beneath a renamed folder', () => {
        editorSessionStore.save('C:/p/x.wad.client/data/a.bin', {
            fileVersion: 0,
            content: 'a',
            originalContent: 'a',
        });

        editorSessionStore.rename('C:/p/x.wad.client', 'C:/p/y.wad.client');

        expect(editorSessionStore.get('C:/p/y.wad.client/data/a.bin')?.content).toBe('a');
    });
});
