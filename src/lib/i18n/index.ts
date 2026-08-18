import { useUxStore } from '../stores/uxStore';
import type { Language, TranslationDict } from './types';
import { SUPPORTED_LANGUAGES } from './types';
import { en } from './locales/en';
import { tr } from './locales/tr';
import { de } from './locales/de';
import { pl } from './locales/pl';
import { pt } from './locales/pt';
import { es } from './locales/es';

export * from './types';

const DICTIONARIES: Record<Language, TranslationDict> = {
    en,
    tr,
    de,
    pl,
    pt,
    es,
};

/**
 * Translate a key into the target language with variable interpolation.
 * Falls back to English, then to the key itself if no translation is found.
 */
export function translate(
    lang: Language,
    key: string,
    params?: Record<string, string | number>,
): string {
    const dict = DICTIONARIES[lang] || DICTIONARIES.en;
    let template = dict[key] ?? DICTIONARIES.en[key] ?? key;

    if (params) {
        for (const [paramKey, paramValue] of Object.entries(params)) {
            template = template.replaceAll(`{${paramKey}}`, String(paramValue));
        }
    }

    return template;
}

/** Standalone translate function that uses current store language */
export function t(key: string, params?: Record<string, string | number>): string {
    const currentLang = useUxStore.getState().language || 'en';
    return translate(currentLang, key, params);
}

/** React hook for accessing translation functions with reactive re-rendering */
export function useTranslation() {
    const currentLang = useUxStore((s) => s.language) || 'en';
    const setLanguage = useUxStore((s) => s.setLanguage);

    const tHook = (key: string, params?: Record<string, string | number>) => {
        return translate(currentLang, key, params);
    };

    return {
        t: tHook,
        language: currentLang,
        setLanguage,
        supportedLanguages: SUPPORTED_LANGUAGES,
    };
}
