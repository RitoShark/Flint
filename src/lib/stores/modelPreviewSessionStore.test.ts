import { describe, it, expect, beforeEach } from 'vitest';
import { modelPreviewSessionStore as store } from './modelPreviewSessionStore';

const base = () => ({
    fileVersion: 1,
    visibleMaterials: ['Body'],
    selectedAnimation: '',
    isPlaying: false,
    currentTime: 0,
});

describe('modelPreviewSessionStore', () => {
    beforeEach(() => store.clear());

    it('saves and gets by path', () => {
        store.save('C:/proj/a.skn', base());
        expect(store.get('C:/proj/a.skn')?.visibleMaterials).toEqual(['Body']);
    });

    it('is case- and slash-insensitive on key', () => {
        store.save('C:/proj/a.skn', base());
        expect(store.get('C:\\proj\\A.skn')).toBeDefined();
    });

    it('removes a session', () => {
        store.save('C:/proj/a.skn', base());
        store.remove('C:/proj/a.skn');
        expect(store.get('C:/proj/a.skn')).toBeUndefined();
    });

    it('prunes by prefix', () => {
        store.save('C:/proj/x/a.skn', base());
        store.save('C:/other/b.skn', base());
        store.pruneByPrefix('C:/proj');
        expect(store.get('C:/proj/x/a.skn')).toBeUndefined();
        expect(store.get('C:/other/b.skn')).toBeDefined();
    });

    it('evicts oldest beyond the cap', () => {
        for (let i = 0; i < 40; i++) store.save(`C:/p/${i}.skn`, base());
        expect(store._size()).toBeLessThanOrEqual(30);
        expect(store.get('C:/p/39.skn')).toBeDefined(); // newest kept
    });
});
