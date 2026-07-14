/**
 * Flint — What's New Changelog Data
 *
 * Static changelog entries for each release. The WhatsNewModal reads
 * the first entry whose `version` matches the running app version
 * (from tauri.conf.json). Add a new `VersionChangelog` object at the
 * top of the array before each release.
 *
 * Images: entries can include an optional `image` path pointing to a
 * static asset in `/public` (e.g. "/whats-new/my-feature.png"). The
 * modal renders it as a full-width preview card above the description.
 */

export type ChangelogTag = 'feature' | 'improvement' | 'fix' | 'breaking';

export interface ChangelogEntry {
    /** Icon name from the Icon component (e.g. 'wrench', 'info', 'check') */
    icon: string;
    /** Category tag displayed as a colored pill */
    tag: ChangelogTag;
    /** Short one-line title */
    title: string;
    /** Optional longer description (1-2 sentences) */
    description?: string;
    /** Optional image path (relative to /public, e.g. "/whats-new/feature.png") */
    image?: string;
}

export interface VersionChangelog {
    /** Semver version — must match `tauri.conf.json` → `version` exactly */
    version: string;
    /** Human-readable release date (e.g. "May 2026") */
    date: string;
    /** Optional hero headline for the release */
    headline?: string;
    /** Optional subtitle under the headline */
    subtitle?: string;
    /** The individual changes */
    entries: ChangelogEntry[];
}

/**
 * Ordered newest-first. Only the first entry matching the current
 * app version is shown in the What's New modal.
 */
export const CHANGELOG: VersionChangelog[] = [
    {
        version: '2.4.0',
        date: 'July 2026',
        headline: 'Flint 2.4.0',
        subtitle: 'The Thumbnail Creator, animated model previews, plus a batch of bug fixes and QoL changes.',
        entries: [
            {
                icon: 'picture',
                tag: 'feature',
                title: 'Thumbnail Creator',
                description: 'Design splash-style thumbnails for your mod right inside Flint. Right-click a skin model to open a full editor with a live 3D backdrop (a real Summoner\'s Rift chunk with swappable ground textures), your champion posed in 3D, and text that auto-fills from the project. Move models freely in 3D space, layer them with a separator disc between hero and body, and style everything with drop shadows, colored text glow, a hue-tinted corner bracket frame, and a corner glow. Two built-in styles — Riot and Divine — ship pre-tuned, and the mod name / champion name fill in automatically. Export a crisp 1920×1080 poster in one click.',
            },
            {
                icon: 'code',
                tag: 'feature',
                title: 'Animation-Accurate Model Preview',
                description: 'The SKN preview now hides and shows submeshes the way the game does. On open it applies the skin\'s default submesh setup (initialSubmeshToHide), so meshes look right instead of showing every form at once — and while an animation plays, its visibility events swap submeshes at the correct frame (hair, weapons, transforms, and so on). Scrubbing and looping stay correct, and the Materials list reflects the live state. Textures also resolve through linked bins now, so shared material definitions no longer render untextured.',
            },
            {
                icon: 'wrench',
                tag: 'improvement',
                title: 'Thumbnail QoL',
                description: 'Everything is a movable, reorderable layer — the disc sits exactly between your two models, each model renders on its own canvas for per-model shadows, and the whole composition themes off a single hue slider. Text auto-sizes to its box (and re-fits once the poster font finishes loading), and status messages use the standard Flint toast popup.',
            },
        ],
    },
    {
        version: '2.2.0',
        date: 'June 2026',
        headline: 'Flint 2.2.0',
        subtitle: 'Map editing, new format editors, a faster workflow, and tighter launcher sync.',
        entries: [
            {
                icon: 'picture',
                tag: 'feature',
                title: 'Animated Loadscreen Banner',
                description: 'Turn a static loadscreen into an animated VFX banner in one click — Flint injects the shader material and opens a mask editor right over the loading screen. The whole banner animates by default; you paint over the champion (or anything that should stay clean) to mask it out, and Restore brings the effect back. Photoshop-style controls: Alt-drag to resize the brush, right-drag for hardness, plus sliders for shine, scroll, glow, and tint.',
            },
            {
                icon: 'code',
                tag: 'feature',
                title: 'TFT BIN Schema Creator',
                description: 'Generate a copy-pasteable ritobin reference of every Teamfight Tactics class, field, and sample value — scanned straight from the Companions and TFT map WADs. Find it in Settings → Dev.',
            },
            {
                icon: 'wrench',
                tag: 'improvement',
                title: 'Faster WAD Editor: Save Shortcut, Delete & Parallel Saving',
                description: 'Saving an edited WAD now compresses every chunk in parallel across all your CPU cores — a big speedup on full champion WADs. Press Ctrl/Cmd+S to save a file inside a WAD, and use the new Delete button to remove files from a WAD.',
            },
            {
                icon: 'picture',
                tag: 'feature',
                title: 'Map Preview & Texture Painting',
                description: 'Preview map geometry in 3D and paint textures directly onto meshes with a Blender-style projection brush — blend modes, falloff, seam-aware bleed, and per-stroke undo/redo, saved straight back to the asset.',
            },
            {
                icon: 'code',
                tag: 'feature',
                title: 'New Format Editors',
                description: 'Edit .inibin / .cfgbin and .stringtable files in-app, plus read-only viewers for .luabin64, .troybin, and .manifest — all wired through the standard preview path with byte-exact round-trips.',
            },
            {
                icon: 'folder',
                tag: 'feature',
                title: 'Multi-Select & Cross-Project Drag-and-Drop',
                description: 'Ctrl/Shift-select files in the tree, then drag a whole selection between projects with a Move/Copy dialog and Replace / Keep-both conflict handling. Spring-loaded tabs and folders let you drill into the destination mid-drag.',
            },
            {
                icon: 'wrench',
                tag: 'feature',
                title: 'Hard Rename Project',
                description: 'Rename a project for real — rewrites the asset prefix inside every BIN, renames on-disk asset folders, updates the config files, and renames the project directory, then reopens it cleanly.',
            },
            {
                icon: 'link',
                tag: 'feature',
                title: 'Celestial Launcher Sync',
                description: 'Sync straight to the Celestial launcher’s Creator Hub — Flint hands your project folder over via a deep link, no packaging required. Celestial is now the default launcher target, with LTK Manager still one click away.',
            },
            {
                icon: 'picture',
                tag: 'feature',
                title: 'BIN Emitter Copy & Drag Palette',
                description: 'Right-click to copy VfxEmitter / VfxSystem blocks, then drag them from a persistent palette into any BIN editor — bracket-aware re-indent, collision rename, and cross-project VFX asset copying included.',
            },
            {
                icon: 'success',
                tag: 'improvement',
                title: 'Unsaved Edits Survive Remounts',
                description: 'Switching tabs, files, or views no longer drops your unsaved edits, cursor, or scroll position — text editors restore their session from an in-memory cache.',
            },
            {
                icon: 'wrench',
                tag: 'fix',
                title: 'BIN & WAD Saving Fixes',
                description: 'Fixed a parser bug that made saving any BIN with a transform matrix fail with “invalid number”, and fixed stale texture previews after saving a WAD in place. Save errors now jump straight to the offending line.',
            },
            {
                icon: 'info',
                tag: 'improvement',
                title: 'Faster, Unbounded Log Panel',
                description: 'The log panel is now virtualized with no retention cap — it stays fast no matter how much output you throw at it, with range selection and copy.',
            },
            {
                icon: 'wrench',
                tag: 'breaking',
                title: 'Single BIN Engine (RitoShark)',
                description: 'The legacy Jade BIN writer has been removed — RitoShark is now the only BIN engine. This fixes project-creation, save, and rename errors. Projects created with the old broken Jade refather should be recreated.',
            },
        ],
    },
    {
        version: '2.0.2',
        date: 'May 2026',
        headline: 'Flint 2.0.2',
        subtitle: 'Major feature additions and QoL improvements.',
        entries: [
            {
                icon: 'link',
                tag: 'feature',
                title: 'Auto File Registry',
                description: 'Double-click to open supported files directly! Automatically associates Flint with .wad, .bin, .tex, .modpkg, and .fantome files via Windows registry.',
            },
            {
                icon: 'folder',
                tag: 'feature',
                title: 'TFT Support',
                description: 'Teamfight Tactics support is finally here. You can now build and manage TFT mods natively within Flint.',
            },
            {
                icon: 'picture',
                tag: 'feature',
                title: 'Map Support',
                description: 'Flint now officially supports map mods. Start creating custom maps with full tooling integration.',
            },
        ],
    },
];
