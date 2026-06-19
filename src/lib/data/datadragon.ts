const DDRAGON_BASE_URL = "https://ddragon.leagueoflegends.com";

export type CDragonBranch = "latest" | "pbe";

function cdragonBase(branch: CDragonBranch = "latest"): string {
    return `https://raw.communitydragon.org/${branch}/plugins/rcp-be-lol-game-data/global/default/v1`;
}

export interface DDragonChampion {
    id: number;
    name: string;
    alias: string;
}

export interface DDragonChroma {
    id: number;
    name?: string;
    colors: string[];      // hex color strings, e.g. ["#FF0000", "#00FF00"]
    chromaPath?: string;   // CDragon asset path for the chroma image
    /** BIN skin number: chroma.id % 1000 — last 3 digits of the CDragon 6-digit ID (e.g. 103005 → 5 → skin5.bin) */
    skinNum: number;
}

export interface DDragonSkin {
    id: number;
    name: string;
    num: number;
    isBase: boolean;
    /** CDragon-relative path to the centered loading-screen splash (portrait-ish crop). */
    splashPath?: string;
    /** CDragon-relative path to the full uncentered splash (wide). */
    uncenteredSplashPath?: string;
    /** CDragon-relative path to the square tile. */
    tilePath?: string;
    chromas?: DDragonChroma[];
}

let cachedPatch: string | null = null;
const cachedChampionsByBranch = new Map<CDragonBranch, DDragonChampion[]>();

const imageBlobCache = new Map<string, string>();
const imageFetchQueue = new Map<string, Promise<string>>();

export function getCachedImageUrl(url: string): string | null {
    return imageBlobCache.get(url) ?? null;
}

/** Returns the blob URL. Safe to call multiple times (deduped). */
export async function preloadImage(url: string): Promise<string> {
    const cached = imageBlobCache.get(url);
    if (cached) return cached;

    const inflight = imageFetchQueue.get(url);
    if (inflight) return inflight;

    const promise = fetch(url)
        .then(res => {
            if (!res.ok) throw new Error(`HTTP ${res.status}`);
            return res.blob();
        })
        .then(blob => {
            const blobUrl = URL.createObjectURL(blob);
            imageBlobCache.set(url, blobUrl);
            imageFetchQueue.delete(url);
            return blobUrl;
        })
        .catch(() => {
            imageFetchQueue.delete(url);
            return url;
        });

    imageFetchQueue.set(url, promise);
    return promise;
}

export async function preloadChampionIcons(champions: DDragonChampion[], branch: CDragonBranch = "latest"): Promise<void> {
    const batch = champions.map(c => preloadImage(getChampionIconUrl(c.id, branch)));
    await Promise.allSettled(batch);
}

/** Preloads the centered loading-screen splash via CDragon (whitelisted in CSP). */
export async function preloadSkinSplashes(championId: number, skins: DDragonSkin[], branch: CDragonBranch = "latest"): Promise<void> {
    const batch = skins.map(s => {
        const centered = getSkinCenteredSplashUrl(s, branch);
        return preloadImage(centered ?? getSkinSplashCDragonUrl(championId, s.id, branch));
    });
    await Promise.allSettled(batch);
}

async function fetchWithRetry<T>(url: string, retries = 3): Promise<T> {
    try {
        const response = await fetch(url);
        if (!response.ok) {
            throw new Error(`HTTP ${response.status}: ${response.statusText}`);
        }
        return await response.json();
    } catch (error) {
        if (retries > 0) {
            await new Promise((resolve) => setTimeout(resolve, 1000));
            return fetchWithRetry(url, retries - 1);
        }
        throw error;
    }
}

export async function getLatestPatch(): Promise<string> {
    if (cachedPatch) return cachedPatch;

    try {
        const versions = await fetchWithRetry<string[]>(`${DDRAGON_BASE_URL}/api/versions.json`);
        cachedPatch = versions[0];
        return cachedPatch;
    } catch (error) {
        console.error("Failed to fetch patch versions:", error);
        return "14.23.1";
    }
}

export async function fetchChampions(branch: CDragonBranch = "latest"): Promise<DDragonChampion[]> {
    const cached = cachedChampionsByBranch.get(branch);
    if (cached) return cached;

    try {
        const url = `${cdragonBase(branch)}/champion-summary.json`;
        interface ChampionSummary {
            id: number;
            name: string;
            alias: string;
        }
        const champions = await fetchWithRetry<ChampionSummary[]>(url);

        // Filter out special entries (id < 0 or Doom Bots).
        const mapped = champions
            .filter(c => c.id > 0 && c.id < 10000)
            .map(c => ({
                id: c.id,
                name: c.name,
                alias: c.alias
            }))
            .sort((a, b) => a.name.localeCompare(b.name));

        cachedChampionsByBranch.set(branch, mapped);
        return mapped;
    } catch (error) {
        console.error(`Failed to fetch champions (${branch}):`, error);
        throw error;
    }
}

/** Fetch with a timeout (no retries — fail fast). */
async function fetchWithTimeout<T>(url: string, timeoutMs = 8000): Promise<T> {
    const controller = new AbortController();
    const timer = setTimeout(() => controller.abort(), timeoutMs);
    try {
        const response = await fetch(url, { signal: controller.signal });
        if (!response.ok) throw new Error(`HTTP ${response.status}`);
        const text = await response.text();
        return JSON.parse(text) as T;
    } finally {
        clearTimeout(timer);
    }
}

interface CDragonChromaData {
    id: number;
    name?: string;
    chromaPath?: string;
    colors?: string[];
    descriptions?: unknown[];
    rarities?: unknown[];
}

interface CDragonSkinData {
    id: number;
    name?: string;
    isBase?: boolean;
    splashPath?: string;
    uncenteredSplashPath?: string;
    tilePath?: string;
    chromas?: CDragonChromaData[];
}

function mapCDragonSkins(skins: CDragonSkinData[]): DDragonSkin[] {
    return skins.map(skin => {
        const skinNum = skin.id % 1000;
        return {
            id: skin.id,
            name: skin.name || `Skin ${skin.id}`,
            num: skinNum,
            isBase: skin.isBase || skinNum === 0,
            splashPath: skin.splashPath,
            uncenteredSplashPath: skin.uncenteredSplashPath,
            tilePath: skin.tilePath,
            chromas: skin.chromas?.map(c => ({
                id: c.id,
                name: c.name,
                chromaPath: c.chromaPath,
                colors: c.colors?.filter(Boolean) ?? [],
                skinNum: c.id % 1000,
            })) ?? [],
        };
    });
}

/**
 * Resolve a CDragon-relative asset path (e.g. `/lol-game-data/assets/ASSETS/...`)
 * to a full HTTPS URL. Mirrors `asset()` from preyneyv/lol-skin-explorer.
 *
 * CDragon serves these paths under `{cdragonBase}/...` lowercased. Some skin
 * splash entries already arrive lowercased and rooted; this is idempotent.
 */
export function resolveCDragonAsset(path: string, branch: CDragonBranch = "latest"): string {
    const root = `https://raw.communitydragon.org/${branch}/plugins/rcp-be-lol-game-data/global/default`;
    return path.replace("/lol-game-data/assets", root).toLowerCase();
}

/**
 * Fetch skins for a specific champion.
 * Tries CommunityDragon first, falls back to DataDragon.
 * Throws on total failure so the caller can show an error.
 */
export async function fetchChampionSkins(championId: number, alias?: string, branch: CDragonBranch = "latest"): Promise<DDragonSkin[]> {
    const errors: string[] = [];

    try {
        const url = `${cdragonBase(branch)}/champions/${championId}.json`;
        const champion = await fetchWithTimeout<{ skins?: CDragonSkinData[] }>(url);
        if (champion.skins && champion.skins.length > 0) {
            return mapCDragonSkins(champion.skins);
        }
    } catch (err) {
        errors.push(`CDragon(${branch}): ${err instanceof Error ? err.message : err}`);
    }

    // Fallback: DataDragon (live patch only — DDragon has no PBE branch)
    if (alias) {
        try {
            const patch = await getLatestPatch();
            const url = `${DDRAGON_BASE_URL}/cdn/${patch}/data/en_US/champion/${alias}.json`;
            const response = await fetchWithTimeout<{
                data?: Record<string, { skins?: Array<{ id: string; num: number; name: string }> }>;
            }>(url);
            const champData = response.data?.[alias];
            if (champData?.skins && champData.skins.length > 0) {
                return champData.skins.map(skin => ({
                    id: parseInt(skin.id, 10),
                    name: skin.name === 'default' ? alias : skin.name,
                    num: skin.num,
                    isBase: skin.num === 0,
                }));
            }
        } catch (err) {
            errors.push(`DDragon: ${err instanceof Error ? err.message : err}`);
        }
    }

    if (errors.length > 0) {
        throw new Error(`Failed to fetch skins: ${errors.join('; ')}`);
    }

    return [{ id: championId * 1000, name: 'Base', num: 0, isBase: true }];
}

export function getChampionIconUrl(championId: number, branch: CDragonBranch = "latest"): string {
    return `${cdragonBase(branch)}/champion-icons/${championId}.png`;
}

/**
 * chromaId is the full CDragon chroma ID (e.g. 103001001), NOT skinNum.
 */
export function getChromaImageUrl(championId: number, chromaId: number, branch: CDragonBranch = "latest"): string {
    return `${cdragonBase(branch)}/champion-chroma-images/${championId}/${chromaId}.png`;
}

/** Skin splash URL from DataDragon (live only — DDragon has no PBE branch). */
export function getSkinSplashUrl(alias: string, skinNum: number): string {
    return `${DDRAGON_BASE_URL}/cdn/img/champion/splash/${alias}_${skinNum}.jpg`;
}

export function getSkinSplashCDragonUrl(championId: number, skinId: number, branch: CDragonBranch = "latest"): string {
    return `${cdragonBase(branch)}/champion-splashes/${championId}/${skinId}.jpg`;
}

/**
 * Centered loading-screen splash URL for a skin. Prefers `splashPath` from the
 * CDragon champion JSON (already the centered LoadScreen art); the
 * `champion-splashes` endpoint serves the *uncentered* wide art instead.
 */
export function getSkinCenteredSplashUrl(skin: DDragonSkin, branch: CDragonBranch = "latest"): string | null {
    if (skin.splashPath) return resolveCDragonAsset(skin.splashPath, branch);
    return null;
}

export function clearCache(): void {
    cachedPatch = null;
    cachedChampionsByBranch.clear();
    for (const blobUrl of imageBlobCache.values()) {
        URL.revokeObjectURL(blobUrl);
    }
    imageBlobCache.clear();
    imageFetchQueue.clear();
}
