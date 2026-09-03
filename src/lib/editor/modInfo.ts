export type ModConfigAuthor = string | { name: string; role: string };
export type ModConfigLicense = string | { name: string; url: string };

export interface ModConfig {
    name?: string;
    display_name?: string;
    version?: string;
    description?: string;
    authors?: ModConfigAuthor[];
    license?: ModConfigLicense;
    tags?: string[];
    champions?: string[];
    maps?: string[];
    thumbnail?: string | null;
    [key: string]: unknown;
}

export interface AuthorRow {
    name: string;
    role: string;
}

export interface ModInfoDraft {
    displayName: string;
    version: string;
    description: string;
    authors: AuthorRow[];
    licenseKind: 'none' | 'spdx' | 'custom';
    licenseSpdx: string;
    licenseName: string;
    licenseUrl: string;
    tags: string[];
    champions: string[];
    maps: string[];
    thumbnail: string;
}

/** ltk_mod_project's WellKnownModTag, serialized kebab-case. */
export const WELL_KNOWN_TAGS = [
    'champion-skin',
    'map-skin',
    'ward-skin',
    'ui',
    'hud',
    'font',
    'sfx',
    'announcer',
    'structure',
    'minion',
    'jungle-monster',
    'league-of-legends',
    'tft',
    'misc',
] as const;

/** ltk_mod_project's WellKnownMap, serialized kebab-case. */
export const WELL_KNOWN_MAPS = [
    'summoners-rift',
    'aram',
    'teamfight-tactics',
    'arena',
    'swarm',
] as const;

export const COMMON_LICENSES = ['MIT', 'Apache-2.0', 'GPL-3.0-only', 'AGPL-3.0-only', 'CC-BY-4.0', 'CC0-1.0'];

export function authorName(author: ModConfigAuthor): string {
    if (typeof author === 'string') return author;
    if (author && typeof author === 'object') {
        if ('name' in author) return author.name;
        const legacy = author as Record<string, unknown>;
        if ('Name' in legacy) return legacy.Name as string;
        if ('NameAndRole' in legacy) return (legacy.NameAndRole as { name: string }).name;
    }
    return '';
}

export function authorRole(author: ModConfigAuthor): string {
    if (typeof author === 'string') return '';
    if (author && typeof author === 'object') {
        if ('role' in author) return author.role;
        const legacy = author as Record<string, unknown>;
        if ('NameAndRole' in legacy) return (legacy.NameAndRole as { role: string }).role;
    }
    return '';
}

function stringList(value: unknown): string[] {
    return Array.isArray(value) ? value.filter((v): v is string => typeof v === 'string') : [];
}

export function draftFromConfig(config: ModConfig): ModInfoDraft {
    const license = config.license;
    return {
        displayName: config.display_name || '',
        version: config.version || '',
        description: config.description || '',
        authors: (config.authors || []).map((a) => ({ name: authorName(a), role: authorRole(a) })),
        licenseKind: typeof license === 'string' ? 'spdx' : license && typeof license === 'object' ? 'custom' : 'none',
        licenseSpdx: typeof license === 'string' ? license : '',
        licenseName: license && typeof license === 'object' ? license.name : '',
        licenseUrl: license && typeof license === 'object' ? license.url : '',
        tags: stringList(config.tags),
        champions: stringList(config.champions),
        maps: stringList(config.maps),
        thumbnail: config.thumbnail || '',
    };
}

/* Every key the draft does not model is carried through verbatim — mod.config.json
   is a shared file and another tool's data must survive a save here. A key the
   draft empties is DELETED rather than written empty, matching ltk_mod_project's
   skip_serializing_if. */
export function configFromDraft(config: ModConfig, draft: ModInfoDraft): ModConfig {
    const next: ModConfig = { ...config };

    next.display_name = draft.displayName.trim();
    next.version = draft.version.trim();
    next.description = draft.description.trim();
    next.authors = draft.authors
        .filter((a) => a.name.trim())
        .map((a) => (a.role.trim() ? { name: a.name.trim(), role: a.role.trim() } : a.name.trim()));

    const spdx = draft.licenseSpdx.trim();
    const licenseName = draft.licenseName.trim();
    const licenseUrl = draft.licenseUrl.trim();
    if (draft.licenseKind === 'spdx' && spdx) next.license = spdx;
    else if (draft.licenseKind === 'custom' && licenseName) next.license = { name: licenseName, url: licenseUrl };
    else delete next.license;

    assignList(next, 'tags', draft.tags);
    assignList(next, 'champions', draft.champions);
    assignList(next, 'maps', draft.maps);

    const thumbnail = draft.thumbnail.trim();
    if (thumbnail) next.thumbnail = thumbnail;
    else delete next.thumbnail;

    return next;
}

function assignList(config: ModConfig, key: 'tags' | 'champions' | 'maps', values: string[]) {
    const cleaned = values.map((v) => v.trim()).filter(Boolean);
    if (cleaned.length) config[key] = cleaned;
    else delete config[key];
}

export function draftsMatch(a: ModInfoDraft, b: ModInfoDraft): boolean {
    return JSON.stringify(a) === JSON.stringify(b);
}

export function toggleValue(list: string[], value: string): string[] {
    return list.includes(value) ? list.filter((v) => v !== value) : [...list, value];
}
