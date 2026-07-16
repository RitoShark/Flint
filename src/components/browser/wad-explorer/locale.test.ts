import { describe, it, expect } from 'vitest';
import { wadLocale, isNonDefaultLocaleWad } from './helpers';

describe('wadLocale', () => {
    it('extracts the locale segment', () => {
        expect(wadLocale('Aatrox.ko_KR.wad.client')).toBe('ko_KR');
        expect(wadLocale('Map11.en_US.wad.client')).toBe('en_US');
        expect(wadLocale('assets/Ahri.zh_CN.wad.client')).toBe('zh_CN');
    });
    it('returns null for shared (no-locale) WADs', () => {
        expect(wadLocale('Aatrox.wad.client')).toBeNull();
        expect(wadLocale('Ahri.wad')).toBeNull();
    });
    it('ignores non-locale dotted names', () => {
        expect(wadLocale('some.thing.wad.client')).toBeNull();
    });
});

describe('isNonDefaultLocaleWad', () => {
    it('hides non-default locales', () => {
        expect(isNonDefaultLocaleWad('Aatrox.ko_KR.wad.client')).toBe(true);
        expect(isNonDefaultLocaleWad('Aatrox.zh_CN.wad.client')).toBe(true);
    });
    it('keeps the default locale and shared WADs', () => {
        expect(isNonDefaultLocaleWad('Aatrox.en_US.wad.client')).toBe(false);
        expect(isNonDefaultLocaleWad('Aatrox.wad.client')).toBe(false);
    });
    it('honors a custom default locale', () => {
        expect(isNonDefaultLocaleWad('Aatrox.ko_KR.wad.client', 'ko_KR')).toBe(false);
        expect(isNonDefaultLocaleWad('Aatrox.en_US.wad.client', 'ko_KR')).toBe(true);
    });
});
