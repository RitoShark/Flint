export type Language = 'en' | 'tr' | 'de' | 'pl' | 'pt' | 'es';

export interface LanguageInfo {
    code: Language;
    label: string;
    nativeName: string;
    flag: string;
}

export const SUPPORTED_LANGUAGES: LanguageInfo[] = [
    { code: 'en', label: 'English', nativeName: 'English', flag: '🇬🇧' },
    { code: 'tr', label: 'Turkish', nativeName: 'Türkçe', flag: '🇹🇷' },
    { code: 'de', label: 'German', nativeName: 'Deutsch', flag: '🇩🇪' },
    { code: 'pl', label: 'Polish', nativeName: 'Polski', flag: '🇵🇱' },
    { code: 'pt', label: 'Portuguese', nativeName: 'Português', flag: '🇵🇹' },
    { code: 'es', label: 'Spanish', nativeName: 'Español', flag: '🇪🇸' },
];

export type TranslationDict = Record<string, string>;
