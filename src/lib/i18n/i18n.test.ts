import { describe, it, expect } from 'vitest';
import { translate, SUPPORTED_LANGUAGES } from './index';
import { en } from './locales/en';
import { tr } from './locales/tr';
import { de } from './locales/de';
import { pl } from './locales/pl';
import { pt } from './locales/pt';
import { es } from './locales/es';

describe('i18n translations', () => {
    it('supports all requested languages', () => {
        const codes = SUPPORTED_LANGUAGES.map((l) => l.code);
        expect(codes).toContain('en');
        expect(codes).toContain('tr');
        expect(codes).toContain('de');
        expect(codes).toContain('pl');
        expect(codes).toContain('pt');
        expect(codes).toContain('es');
    });

    it('translates common keys in all languages', () => {
        expect(translate('en', 'common.save')).toBe('Save');
        expect(translate('tr', 'common.save')).toBe('Kaydet');
        expect(translate('de', 'common.save')).toBe('Speichern');
        expect(translate('pl', 'common.save')).toBe('Zapisz');
        expect(translate('pt', 'common.save')).toBe('Salvar');
        expect(translate('es', 'common.save')).toBe('Guardar');
    });

    it('interpolates parameters correctly', () => {
        expect(translate('en', 'statusbar.fps', { fps: 60 })).toBe('FPS: 60');
        expect(translate('tr', 'statusbar.hashes', { count: 50000 })).toBe('50000 Hash Yüklü');
        expect(translate('de', 'statusbar.ram', { ram: 256 })).toBe('RAM: 256 MB');
    });

    it('falls back to English when a key is missing in another language', () => {
        expect(translate('tr', 'only.in.en' as any)).toBe('only.in.en');
    });

    it('has translation keys defined across all locales', () => {
        const testKeys = [
            'common.save',
            'common.cancel',
            'settings.title',
            'settings.tab.binEditor',
            'settings.binEditor.autoSuggestions',
        ];

        for (const key of testKeys) {
            expect(en[key]).toBeDefined();
            expect(tr[key]).toBeDefined();
            expect(de[key]).toBeDefined();
            expect(pl[key]).toBeDefined();
            expect(pt[key]).toBeDefined();
            expect(es[key]).toBeDefined();
        }
    });
});
