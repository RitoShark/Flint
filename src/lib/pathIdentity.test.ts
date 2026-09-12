import { describe, it, expect } from 'vitest';
import { normalizeOsPath, isSamePath, toPosix, toWindowsPath } from './pathIdentity';

describe('isSamePath', () => {
    it('matches a frontend forward-slash path against a Rust-built Windows path', () => {
        // The exact pair that made clicking a .anm reload the model: the .skn picked in the
        // tree vs. the one resolve_anm_skin hands back.
        expect(isSamePath(
            'E:/proj/content/base/data/characters/yasuo/skins/yasuo.skn',
            'E:\\proj\\content\\base\\data\\characters\\yasuo\\skins\\yasuo.skn',
        )).toBe(true);
    });

    it('resolves .. segments left by the sibling-folder asset resolver', () => {
        expect(isSamePath(
            'E:/proj/data/characters/yasuo/skins/yasuo.skn',
            'E:/proj/data/characters/yasuo/animations/../skins/yasuo.skn',
        )).toBe(true);
    });

    it('ignores case, as Windows does', () => {
        expect(isSamePath('E:/Proj/Skins/Yasuo.skn', 'e:/proj/skins/yasuo.skn')).toBe(true);
    });

    it('still separates genuinely different files', () => {
        expect(isSamePath(
            'E:/proj/data/characters/yasuo/skins/yasuo.skn',
            'E:/proj/data/characters/yone/skins/yone.skn',
        )).toBe(false);
    });

    it('does not treat a path as a match for its own parent', () => {
        expect(isSamePath('E:/proj/skins', 'E:/proj/skins/yasuo.skn')).toBe(false);
    });

    it('collapses redundant and trailing separators', () => {
        expect(normalizeOsPath('E:/proj//skins/./yasuo.skn')).toBe('e:/proj/skins/yasuo.skn');
        expect(normalizeOsPath('E:\\proj\\skins\\')).toBe('e:/proj/skins');
    });
});

describe('toPosix', () => {
    it('converts Windows separators', () => {
        expect(toPosix('E:\\proj\\content\\base\\yasuo.skn')).toBe('E:/proj/content/base/yasuo.skn');
    });

    it('leaves an already-posix path untouched', () => {
        expect(toPosix('E:/proj/yasuo.skn')).toBe('E:/proj/yasuo.skn');
    });

    it('is idempotent', () => {
        const once = toPosix('E:\\proj\\yasuo.skn');
        expect(toPosix(once)).toBe(once);
    });

    it('preserves case, unlike normalizeOsPath', () => {
        expect(toPosix('E:\\Proj\\Yasuo.skn')).toBe('E:/Proj/Yasuo.skn');
        expect(normalizeOsPath('E:\\Proj\\Yasuo.skn')).toBe('e:/proj/yasuo.skn');
    });

    it('preserves .. and trailing separators, unlike normalizeOsPath', () => {
        expect(toPosix('animations\\..\\skins\\')).toBe('animations/../skins/');
        expect(normalizeOsPath('animations\\..\\skins\\')).toBe('skins');
    });

    it('handles empty and relative paths', () => {
        expect(toPosix('')).toBe('');
        expect(toPosix('content\\base\\x.bin')).toBe('content/base/x.bin');
    });
});

describe('toWindowsPath', () => {
    it('gives explorer /select, the separators it requires', () => {
        expect(toWindowsPath('E:/proj/content/base/yasuo.skn')).toBe('E:\\proj\\content\\base\\yasuo.skn');
    });

    it('round-trips with toPosix', () => {
        const posix = 'E:/proj/yasuo.skn';
        expect(toPosix(toWindowsPath(posix))).toBe(posix);
    });
});
