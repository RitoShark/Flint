# Flint Asset Path Cheat Sheet
*Original cheat sheet by **Aropatnik**. Adapted for **Flint**.*

Welcome to the Flint Asset Directory. You can use Flint's **WAD Explorer** search bar to quickly jump to any of these paths.

---

### Map & Mode WADs
* **Summoner's Rift:** `Map11.wad.client`
* **ARAM (Howling Abyss):** `Map12.wad.client`
* **Nexus Blitz:** `Map21.wad.client`
* **TFT:** `Map22.wad.client` / `TFTSetXX.wad.client`
* **Arena:** `Map30.wad.client`
* **Swarm:** `Map33.wad.client`
* **Brawl:** `Map35.wad.client`
* **Companions (Little Legends/Followers):** `Companions.wad.client`

> **Ye Olde Map IDs:** Dominion was `Map8` (ODIN), Twisted Treeline was `Map10` (TT).

---

### Champions
* **3D Models, Skeletons, Animations:** `CHAMPION.wad.client assets/characters/CHAMPION/skins/SKINID/`
    * *Note:* Some champions have specific parts as a completely different character file (e.g., Nasus' ultimate).
* **HUD, Ability Icons, Skin Icons:** `CHAMPION.wad.client assets/characters/CHAMPION/huds/`
* **Ability Icons specifically:** `CHAMPION.wad.client assets/characters/CHAMPION/huds/icons2d/`

**Champion Voice Lines (VO):**
* `CHAMPION.xx_YY.wad.client assets/sounds/wwise2016/vo/en_US/characters/CHAMPION/skins/SKINID/CHAMPION_SKINID_vo_audio.wpk`
* `CHAMPION.xx_YY.wad.client assets/sounds/wwise2016/vo/en_US/characters/CHAMPION/skins/SKINID/CHAMPION_SKINID_vo_events.bnk`
* `CHAMPION.wad.client data/characters/CHAMPION/skins/SKINID.bin`
* `xx_YY` = language code (en_US, es_MX, ru_RU…)

**Champion Sound Effects (SFX):**
* `CHAMPION.wad.client assets/sounds/wwise2016/sfx/characters/CHAMPION/skins/SKINID/CHAMPION_SKINID_sfx_audio.bnk`
* `CHAMPION.wad.client assets/sounds/wwise2016/sfx/characters/CHAMPION/skins/SKINID/CHAMPION_SKINID_sfx_events.bnk`
* `CHAMPION.wad.client data/characters/CHAMPION/skins/SKINID.bin`

---

### Finding Skin IDs
* Use [sirdexal.pages.dev/skin-explorer](https://sirdexal.pages.dev/skin-explorer) to look up which skin number maps to which skin name.
* Or open `CHAMPION.wad.client assets/characters/CHAMPION/huds/` and inspect the champion square icons — they're named by skin ID.

---

### Minions, Monsters & Environment
League splits minions into "Chaos" and "Order" teams. Both teams usually have a red and blue variant due to the "use relative team colors" setting (e.g., skinX and skinX+1 for one team, skinX+2 and skinX+3 for the other).

* **Summoner's Rift Minions (visuals):** `Map11.wad.client assets/characters/sru_MINIONNAME/`
* **ARAM Minions (visuals):** `Map12.wad.client assets/characters/ha_MINIONNAME/`
* **Jungle Pets:** `Map11.wad.client assets/characters/sru_jungle_companions/`
* **Target Dummy:** `Map11.wad.client assets/characters/practicetool_targetdummy/`

**SR Minion Sounds:**
* `Map11.wad.client assets/sounds/wwise2016/sfx/shared/npc_global_minion_MINIONNAME_sfx_audio.bnk`
* `Map11.wad.client assets/sounds/wwise2016/sfx/shared/npc_global_minion_MINIONNAME_sfx_events.bnk`
* `Map11.wad.client data/maps/shipping/map11/map11.bin`

**ARAM Minion Sounds:**
* `Map12.wad.client assets/sounds/wwise2016/sfx/shared/npc_global_minion_MINIONNAME_sfx_audio.bnk`
* `Map12.wad.client assets/sounds/wwise2016/sfx/shared/npc_global_minion_MINIONNAME_sfx_events.bnk`
* `Map12.wad.client data/maps/shipping/map12/map12.bin`

**Bush Colors:** `MapXXLEVELS.wad.client levels/mapXX/info/` (XX=11 for SR, XX=12 for ARAM)

---

### In-Game Text & Localization
All in-game text strings — item names, ability descriptions, UI labels, tooltip text — live in language-specific WADs separate from the main champion/map WADs. The WAD name follows the same `name.XX_YY.wad.client` pattern seen elsewhere.

* **All global game text:** `global.en_US.wad.client`
* **Other locales:** `global.fr_FR.wad.client` / `global.ko_KR.wad.client` / `global.zh_CN.wad.client` etc.
* **Map-specific text (e.g. objectives, pings):** `Map11.en_US.wad.client` / `Map12.en_US.wad.client`
* **Champion-specific text (VO subtitles, bios):** `CHAMPION.en_US.wad.client`

> Text files inside these WADs are `.stringtable` format (binary, not plain text). Flint does not currently edit stringtables directly — use a dedicated tool such as [LoL StringTable Editor](https://github.com/LeagueToolkit/lol-string-table) to decode and re-encode them before replacing the file in your mod.

---

### UI, HUD & Items

**Cursor:** `UI.wad.client assets/ux/cursors/`
> Files are `.tga` — GIMP can natively open and export them.

**Fonts:** `Ui.wad.client assets/ux/fonts/`

**Random HUD Icons (not champ-specific):** Search for `atlas` inside `Ui.wad.client`

**Item Icons:** `Global.wad.client assets/items/icons2d/`
> You also need to edit the 2 atlases in the `autoatlas` folder.

**Item Borders:**
* `Global.wad.client assets/items/itemmodifiers/`
* `Ui.wad.client assets/ux/itemshop/itemshop_texture_atlas.tex`
* `Ui.wad.client assets/ux/itemshop/itemshop_texture_atlas_3.tex`
* `Ui.wad.client assets/ux/lol/clarity_hudatlas.tex`

**Summoner Spell Icons:** `DATA.wad.client data/spells/icons2d/summonerxxxxx.dds`

**Healthbar, CC Icons, Ammo, Revive, Yuumi:** `Ui.wad.client assets/ux/floatinghealthbars/`

**Summoner Profile Icons:** `Global.wad.client assets/ux/summonericons/`

**Loading Screen Backgrounds:** `MapXX.wad.client assets/ux/loadingscreen/` (XX=11 SR, XX=12 ARAM)

**Loading Screen Borders & Spinner:** `UI.wad.client assets/ux/loadindscreen/`

**Rune VFX:** `Global.wad.client assets/perks/`

**Summoner Emotes (visuals):** `Global.wad.client assets/loadouts/summoneremotes/flairs/`

---

### TwistedFate W Cards
The card icons don't follow the usual champion path — they live across multiple WADs:
* `Data.wad.client data/spells/icons2d/cardmaster_red.dds`
* `Data.wad.client data/spells/icons2d/cardmaster_blue.dds`
* `Twistedfate.wad.client assets/spells/icons2d/cardmaster_gold.dds`

> If combining all three into a single mod WAD, disable "Remove Unknown" or the missing-WAD files will be stripped.

---

### Map Objects & Buffs

**Blue Buff:**
* `Global.wad.client assets/maps/particles/sr/buff_blue_rocks.tex`
* `Global.wad.client assets/maps/particles/sr/jungle_buff_blue_glow.tex`

**Red Buff:**
* `Global.wad.client assets/maps/particles/sr/buff_red_branches.tex`
* `Global.wad.client assets/maps/particles/sr/jungle_buff_red_glow.tex`

**Baron Buff:**
* `Map11.wad.client assets/shared/particles/ring_soft_02.skins_belveth_skin19.dds`
* `Map11.wad.client assets/maps/particles/sr/jungle_buff_baron.tex`
* `Map11.wad.client assets/shared/particles/srx_infernal_smoke_trail.strawberryrebuild.tex`

> The `.somethingrandom` suffix in particle names (e.g., `.strawberryrebuild`, `.skins_belveth_skin19`) may change or be removed each patch. Search for the base name (`ring_soft_02`, `srx_infernal_smoke_trail`) instead. You'll need to update your mod if Riot renames them.

**ARAM Mayhem Augment Particles:** `Map12.wad.client maps/modespecificdata/kiwi.bin`

---

### Wards
* `Map11.wad.client assets/characters/sightward/` (support item ward)
* `Map11.wad.client assets/characters/bluetrinket/` (blue trinket ward)
* `Map11.wad.client assets/characters/yellowtrinket/` (yellow trinket ward)
* `Map11.wad.client assets/characters/jammerdevice/` (control ward)
* `Global.wad.client assets/characters/perkszombieward/` (zombie ward perk, RIP)

> Use [lol-db.com/lol-wards](https://lol-db.com/lol-wards/) to find the correct skin ID for ward skins. Some wards share animations and skeletons.

---

### Hats (April Fools & Events)
Seasonal hats are particles attached to champions, not separate models. They're scattered across a few locations:
* `Global.wad.client assets/characters/caitlyn/skins/skin11/particles/`
* `Global.wad.client assets/characters/urgot/skins/base/particles/`
* `Global.wad.client assets/items/3181/particles/`
* `Global.wad.client assets/maps/particles/cherry/`

Search for `hat` inside `Global.wad.client` to find any event hats not listed above. Urgot's hat texture specifically is `urgot_base_z_emoteprops.dds`.

---

### Global Audio & Announcers
> When converting custom audio to `.WEM`, set Wwise conversion to **Vorbis Quality High**: *Project > Project Settings > Source Settings > Default Conversion Settings > Factory Conversion Settings > Vorbis > Vorbis Quality High*

**Announcer:**
* `MapXX.yy_ZZ.wad.client assets/sounds/wwise2016/vo/en_US/shared/announcer_global_female1_vo_audio.wpk`
* `MapXX.yy_ZZ.wad.client assets/sounds/wwise2016/vo/en_US/shared/announcer_global_female1_vo_events.bnk`
* `MapXX.wad.client data/maps/shipping/mapXX/mapXX.bin`
* XX=11 SR, XX=12 ARAM, `yy_ZZ` = language code (en_US, es_MX, ru_RU…)

**Killstreak SFX:**
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/misc_gameplay_killstreak_sfx_audio.bnk`
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/misc_gameplay_killstreak_sfx_events.bnk`
* `Common.wad.client data/maps/shipping/common/common.bin`

**Level Up, Recalls, Summoner Spells, Runes:**
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/misc_gameplay_sfx_audio.bnk`
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/misc_gameplay_sfx_events.bnk`
* `Common.wad.client data/maps/shipping/common/common.bin`

**Pings, Store, Chat, "You have no mana":**
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/hud_global_audio.bnk`
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/hud_global_events.bnk`
* `Common.wad.client data/maps/shipping/common/common.bin`

**Item Sounds:**
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/items_global_audio.bnk`
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/items_global_events.bnk`
* `Common.wad.client data/maps/shipping/common/common.bin`

**Game End Sounds:**
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/env_eog_sfx_audio.bnk`
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/env_eog_sfx_events.bnk`
* `Common.wad.client data/maps/shipping/common/common.bin`

---

### Emote Sounds

**Summoner Emote SFX** (most emotes):
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/misc_emotes_sfx_audio.wpk`
* `Common.wad.client assets/sounds/wwise2016/sfx/shared/misc_emotes_sfx_events.bnk`
* `Common.wad.client data/maps/shipping/common/common.bin`

**Summoner Emote VO** (some emotes use VO instead of SFX):
* `Common.xx_YY.wad.client assets/sounds/wwise2016/vo/en_us/shared/misc_emotes_vo_audio.wpk`
* `Common.wad.client assets/sounds/wwise2016/vo/en_us/shared/misc_emotes_vo_events.bnk`
* `Common.wad.client data/maps/shipping/common/common.bin`
* `xx_YY` = language code (en_US, es_MX, ru_RU…)

To find which sound event to modify for a specific emote:
1. Search for the emote name in `Global.wad.client` under `loadouts/summoneremotes` (it's a `.bin` without extension).
2. Note the hashed `VfxSystem` value (e.g., `0xb2a1fbb1`).
3. Search that hash inside `Global.wad.client` without the `0x` prefix (e.g., `b2a1fbb1`).
4. Open the matching `summoneremotes.HASH.bin` and search for `sound`.

---

### Patch Codenames
You will often see these inside filenames:

| Codename | Event |
|---|---|
| `kiwi` | ARAM Mayhem |
| `sodapop` | 2026 Split 1 Demacia |
| `milkshake` | 2025 Winter Rift |
| `ruby` | Doombots of Doom |
| `bloom` | Spirit Blossom Rift |
| `cherry` | Noxus Arena |
| `boba` | Noxus Rift |
| `slime` | Nexus Blitz |
| `crepe` | Arcane Season 2 |
| `strawberry` | Swarm PvE |

---

### Resources
* [Divine Skins Wiki](https://wiki.divineskins.gg/)
* [Divine Skins Discord](https://discord.gg/divineskins) — post in #help if you're stuck
* [CommunityDragon Archives](https://raw.communitydragon.org/) — older patch assets
* [ManifestDownloader](https://github.com/Morilli/ManifestDownloader) — download specific old patches
* [Skin Explorer](https://sirdexal.pages.dev/skin-explorer) — look up champion skin IDs
* [Ward DB](https://lol-db.com/lol-wards/) — look up ward skin IDs
* [bnk-extract GUI](https://github.com/Morilli/bnk-extract-GUI/releases) — extract audio from .bnk files
* [Kyoko Teaches Modding](http://www.youtube.com/@KyokoTeaches) — video guides
