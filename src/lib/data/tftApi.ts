import { CDragonBranch, resolveCDragonAsset } from './datadragon';

export interface CDragonCompanion {
    itemId: number;
    name: string;
    speciesId: number;
    speciesName: string;
    level: number;
    rarity: string;
    loadoutsIcon: string;
}

export interface Tactician {
    id: string;
    name: string;
    alias: string;
    iconUrl: string;
}

export interface TacticianSkin {
    id: number;
    full_id: string;
    name: string;
    rarity: string;
    tilePath: string | null;
    centeredSplashPath: string | null;
    skinLines: never[];
    wadAlias: string;
    wadSkinNum: number;
    wadTheme?: string;
    wadTier?: number;
}

const cachedCompanionsByBranch = new Map<CDragonBranch, CDragonCompanion[]>();
const cachedTacticiansByBranch = new Map<CDragonBranch, Tactician[]>();

async function fetchCompanionsData(branch: CDragonBranch = 'latest', retries = 3): Promise<CDragonCompanion[]> {
    const cached = cachedCompanionsByBranch.get(branch);
    if (cached) return cached;

    const url = `https://raw.communitydragon.org/${branch}/plugins/rcp-be-lol-game-data/global/default/v1/companions.json`;
    for (let i = 0; i < retries; i++) {
        try {
            const res = await fetch(url);
            if (!res.ok) throw new Error(`HTTP ${res.status}: ${res.statusText}`);
            const data = await res.json();
            const list = Array.isArray(data) ? data : [];
            cachedCompanionsByBranch.set(branch, list);
            return list;
        } catch (e) {
            if (i === retries - 1) throw e;
            await new Promise((resolve) => setTimeout(resolve, 1000 * (i + 1)));
        }
    }
    return [];
}

/**
 * Each companion's loadoutsIcon contains a Tooltip_<InternalName>_... segment
 * matching the WAD folder under data/characters/pet<internalName>/. Sibling
 * skins under the SAME CommunityDragon speciesId can live in DIFFERENT WAD
 * folders (e.g. "Ahri" species contains both Chibi Ahri variants — which live
 * in data/characters/petchibiahri/ — and K/DA Ahri Unbound — which lives in
 * data/characters/petstyletwoahri/). So the alias has to be derived per-skin,
 * not per-species, or extraction will hit the wrong folder.
 */
function deriveWadAlias(companion: CDragonCompanion): string {
    const icon = companion?.loadoutsIcon || '';
    // Legacy River Sprite icons use Tooltip_TFT_Avatar_<Variant>.png — the
    // generic [^_]+ regex would grab just "TFT" and produce alias "pettft",
    // missing the actual pettftavatar folder. Match those explicitly first.
    if (/Tooltip_TFT_Avatar_/i.test(icon)) {
        return 'pettftavatar';
    }
    const match = icon.match(/Tooltip_([^_]+)_/i);
    const internalName = match
        ? match[1]
        : String(companion?.speciesName || '').replace(/[^a-zA-Z0-9]/g, '');
    return `pet${internalName}`.toLowerCase();
}

/**
 * Companion loadoutsIcons follow `Tooltip_<Alias>_<Theme>_<Variant>_Tier<N>.png`.
 * The actual mesh + textures live at
 *   assets/characters/pet<alias>/themes/<theme>/tier<N>/pet<alias>_<theme>_tier<N>.skn
 * — NOT under skins/skin<N>/. Returns lowercase folder names matching the WAD
 * layout, or {} when the regex can't match (some legacy companions ship icons
 * with a different pattern; downstream code falls back to broad scanning).
 */
function deriveWadThemeTier(companion: CDragonCompanion): { theme?: string; tier?: number } {
    const icon = companion?.loadoutsIcon || '';
    const match = icon.match(/Tooltip_[^_]+_([^_]+)_.*Tier(\d+)/i);
    if (!match) return {};
    return {
        theme: match[1].toLowerCase(),
        tier: Number(match[2]),
    };
}

export async function getTacticians(branch: CDragonBranch = 'latest'): Promise<Tactician[]> {
    const cached = cachedTacticiansByBranch.get(branch);
    if (cached) return cached;

    try {
        const data = await fetchCompanionsData(branch);
        const speciesMap = new Map<number, Tactician>();

        data.forEach((c) => {
            // River Sprite uses speciesId=0 — don't drop with a truthy check.
            if (c.speciesId == null || !c.speciesName || !c.loadoutsIcon) return;
            if (speciesMap.has(c.speciesId)) return;

            const alias = deriveWadAlias(c);
            const iconUrl = resolveCDragonAsset(c.loadoutsIcon, branch);

            speciesMap.set(c.speciesId, {
                id: String(c.speciesId),
                name: c.speciesName,
                alias,
                iconUrl,
            });
        });

        const list = Array.from(speciesMap.values()).sort((a, b) => a.name.localeCompare(b.name));
        cachedTacticiansByBranch.set(branch, list);
        return list;
    } catch (err) {
        console.error('[tftApi] getTacticians failed:', err);
        return [];
    }
}

export async function getTacticianSkins(
    tacticianId: string,
    branch: CDragonBranch = 'latest',
): Promise<TacticianSkin[]> {
    try {
        const data = await fetchCompanionsData(branch);
        const skins: TacticianSkin[] = [];

        data.forEach((c) => {
            if (String(c.speciesId) === String(tacticianId)) {
                const rawId = Number(c.itemId);
                // The last digits of itemId dictate the skin number in the WAD (e.g. 69004 -> skin04)
                const skinNum = rawId >= 1000 ? rawId % 1000 : rawId;
                const iconPath = c.loadoutsIcon ? resolveCDragonAsset(c.loadoutsIcon, branch) : null;
                const wadAlias = deriveWadAlias(c);
                const { theme: wadTheme, tier: wadTier } = deriveWadThemeTier(c);

                skins.push({
                    id: skinNum,
                    full_id: String(rawId),
                    name: `${c.name} (Tier ${c.level})`,
                    rarity: c.rarity || 'Default',
                    tilePath: iconPath,
                    centeredSplashPath: iconPath,
                    skinLines: [],
                    wadAlias,
                    wadSkinNum: skinNum,
                    wadTheme,
                    wadTier,
                });
            }
        });

        skins.sort((a, b) => a.id - b.id);
        return skins;
    } catch (err) {
        console.error('[tftApi] getTacticianSkins failed:', err);
        return [];
    }
}

export function clearTacticianCache(): void {
    cachedCompanionsByBranch.clear();
    cachedTacticiansByBranch.clear();
}
