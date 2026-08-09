const RAW_GAME_DATA = 'https://raw.communitydragon.org/latest/game/data/characters';

const LOOKUP_TIMEOUT_MS = 10_000;

const cache = new Map<string, number[] | null>();

/**
 * Every `skin<N>.bin` CommunityDragon lists for a character, ascending.
 *
 * Read from the raw game-data directory listing rather than
 * `champion-summary` / `champions/{id}`, which carry only officially released
 * skins and miss chroma, PBE and unreleased slots. Returns `null` when the
 * lookup fails so each caller can pick its own fallback.
 */
export async function fetchSkinSlots(character: string): Promise<number[] | null> {
    const key = character.toLowerCase();
    const cached = cache.get(key);
    if (cached !== undefined) return cached;

    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), LOOKUP_TIMEOUT_MS);
    try {
        const response = await fetch(`${RAW_GAME_DATA}/${key}/skins/`, {
            signal: controller.signal,
        });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const slots = parseSkinSlots(await response.text());
        const result = slots.length > 0 ? slots : null;
        cache.set(key, result);
        return result;
    } catch {
        cache.set(key, null);
        return null;
    } finally {
        clearTimeout(timer);
    }
}

export function parseSkinSlots(listing: string): number[] {
    const found = new Set<number>();
    for (const match of listing.matchAll(/\bskin(\d+)\.bin\b/gi)) {
        found.add(parseInt(match[1], 10));
    }
    return [...found].sort((a, b) => a - b);
}

/** The dense `0..max + margin` range NoSkinLite clones into. */
export function skinLiteRange(slots: number[] | null, fallbackMax: number, margin: number): number[] {
    const max = (slots && slots.length > 0 ? slots[slots.length - 1] : fallbackMax) + margin;
    return Array.from({ length: max + 1 }, (_, i) => i);
}
