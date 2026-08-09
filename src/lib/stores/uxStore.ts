import { create } from 'zustand';
import { setButtonGlow } from '../ui-helpers/buttonGlow';

const STORAGE_KEY = 'flint_ux_prefs_v1';

export interface UxPrefs {
    glassmorphism: boolean;
    fpsMode: boolean;
    /** Cursor-following radial glow on buttons. On by default (opt-out); force-disabled while fpsMode is on. */
    buttonGlow: boolean;
    /** Hex string e.g. "#EF4444" — overrides --accent-primary. null = use theme default. */
    accentPrimary: string | null;
    /** Optional secondary accent. null = computed from primary. */
    accentSecondary: string | null;
    /** Background blur strength for glassmorphism (px). */
    glassBlur: number;
    /** Background opacity for glass surfaces (0..1). */
    glassOpacity: number;
    /** Remembered viewer per lowercased extension for files with no dedicated
     *  preview (UnknownPreview), e.g. { "dat": "hex" }. */
    unknownPreviewByExt: Record<string, 'hex' | 'text'>;
    /** Show Monaco's minimap in the BIN editor. Force-disabled above
     *  `binEditorMinimapMaxLines` regardless of this preference. */
    binEditorMinimap: boolean;
    /** Line count above which the minimap is force-disabled for performance. */
    binEditorMinimapMaxLines: number;
    binEditorWordWrap: boolean;
    binEditorFontSize: number;
    /** Run the Unhash pass automatically when a BIN opens. */
    binEditorAutoUnhash: boolean;
    /** Tools-panel sections that start expanded, keyed by section title. */
    binEditorExpandedSections: Record<string, boolean>;
    /** Id of the ritobin syntax colour preset. */
    binEditorSyntaxTheme: string;
}

const DEFAULTS: UxPrefs = {
    glassmorphism: true,
    fpsMode: false,
    buttonGlow: true,
    accentPrimary: null,
    accentSecondary: null,
    glassBlur: 14,
    glassOpacity: 0.65,
    unknownPreviewByExt: {},
    binEditorMinimap: true,
    binEditorMinimapMaxLines: 150_000,
    binEditorWordWrap: false,
    binEditorFontSize: 13,
    binEditorAutoUnhash: false,
    binEditorExpandedSections: {},
    binEditorSyntaxTheme: 'default',
};

/** Superseded default reds → the current one. A stored accent overrides the theme
 *  file, so without this an existing install keeps whichever default it first saved
 *  and never picks up a change. Only these exact values are migrated — a color the
 *  user actually chose is left alone, even if it happens to be red. */
const SUPERSEDED_DEFAULT_ACCENTS: Record<string, string> = {
    '#ef4444': '#EF5244', // original pure red (hue 0)
    '#ef5b44': '#EF5244', // brief hue-8 default, read as too orange
};

function readStorage(): Partial<UxPrefs> {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return {};
        const prefs = JSON.parse(raw) as Partial<UxPrefs>;
        if (typeof prefs.accentPrimary === 'string') {
            const migrated = SUPERSEDED_DEFAULT_ACCENTS[prefs.accentPrimary.toLowerCase()];
            if (migrated) prefs.accentPrimary = migrated;
        }
        return prefs;
    } catch {
        return {};
    }
}

function writeStorage(prefs: UxPrefs) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(prefs));
    } catch { /* non-fatal */ }
}

interface UxState extends UxPrefs {
    setGlassmorphism: (on: boolean) => void;
    setFpsMode: (on: boolean) => void;
    setButtonGlow: (on: boolean) => void;
    setAccentPrimary: (hex: string | null) => void;
    setAccentSecondary: (hex: string | null) => void;
    setGlassBlur: (px: number) => void;
    setGlassOpacity: (v: number) => void;
    /** Remember (or forget with null) the viewer for an unknown extension. */
    setUnknownPreviewForExt: (ext: string, mode: 'hex' | 'text' | null) => void;
    setBinEditorMinimap: (on: boolean) => void;
    setBinEditorPrefs: (patch: Partial<UxPrefs>) => void;
    reset: () => void;
}

const initial: UxPrefs = { ...DEFAULTS, ...readStorage() };

export const useUxStore = create<UxState>()((set, get) => {
    /* Picks the keys off DEFAULTS rather than destructuring them by hand — a
       new preference that the hand-written list forgot was silently never
       persisted. */
    const persist = () => {
        const state = get();
        const prefs = { ...DEFAULTS };
        for (const key of Object.keys(DEFAULTS) as (keyof UxPrefs)[]) {
            (prefs as Record<string, unknown>)[key] = state[key];
        }
        writeStorage(prefs);
        applyUxPrefs(prefs);
    };
    return {
        ...initial,
        setGlassmorphism: (on) => { set({ glassmorphism: on }); persist(); },
        setFpsMode: (on) => { set({ fpsMode: on }); persist(); },
        setButtonGlow: (on) => { set({ buttonGlow: on }); persist(); },
        setAccentPrimary: (hex) => { set({ accentPrimary: hex }); persist(); },
        setAccentSecondary: (hex) => { set({ accentSecondary: hex }); persist(); },
        setGlassBlur: (px) => { set({ glassBlur: px }); persist(); },
        setGlassOpacity: (v) => { set({ glassOpacity: v }); persist(); },
        setUnknownPreviewForExt: (ext, mode) => {
            const key = ext.toLowerCase();
            const next = { ...get().unknownPreviewByExt };
            if (mode === null) delete next[key];
            else next[key] = mode;
            set({ unknownPreviewByExt: next });
            persist();
        },
        setBinEditorMinimap: (on) => { set({ binEditorMinimap: on }); persist(); },
        setBinEditorPrefs: (patch) => { set(patch as Partial<UxState>); persist(); },
        reset: () => { set({ ...DEFAULTS }); persist(); },
    };
});

export function applyUxPrefs(prefs: UxPrefs) {
    const root = document.documentElement;
    root.dataset.glass = prefs.glassmorphism ? 'on' : 'off';
    root.dataset.fps = prefs.fpsMode ? 'on' : 'off';
    // FPS mode (older hardware / handhelds) always wins and force-disables the glow.
    const glowActive = prefs.buttonGlow && !prefs.fpsMode;
    root.dataset.buttonGlow = glowActive ? 'on' : 'off';
    setButtonGlow(glowActive);
    root.style.setProperty('--ux-glass-blur', `${prefs.glassBlur}px`);
    root.style.setProperty('--ux-glass-opacity', String(prefs.glassOpacity));

    if (prefs.accentPrimary) {
        root.style.setProperty('--accent-primary', prefs.accentPrimary);
        root.style.setProperty('--accent-hover', shadeHex(prefs.accentPrimary, -12));
    }
    if (prefs.accentSecondary) {
        root.style.setProperty('--accent-secondary', prefs.accentSecondary);
    }
}

export function bootUxPrefs() {
    applyUxPrefs(useUxStore.getState());
}

/** Lighten/darken a hex by a percent (-100..100). */
function shadeHex(hex: string, percent: number): string {
    const m = /^#?([0-9a-f]{6})$/i.exec(hex.trim());
    if (!m) return hex;
    const n = parseInt(m[1], 16);
    let r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
    const t = percent < 0 ? 0 : 255;
    const p = Math.abs(percent) / 100;
    r = Math.round(r + (t - r) * p);
    g = Math.round(g + (t - g) * p);
    b = Math.round(b + (t - b) * p);
    return `#${((r << 16) | (g << 8) | b).toString(16).padStart(6, '0')}`;
}
