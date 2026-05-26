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
