/**
 * Shared types and glyph constants used by BnkPreview's UI and helpers.
 */

export interface BnkPreviewProps {
    filePath: string;
}

export type ViewMode = 'flat' | 'events';

export type BinLinkState =
    | { kind: 'idle' }
    | { kind: 'loading' }
    | { kind: 'linked'; path: string; source: 'auto' | 'manual' }
    | { kind: 'none' };

/**
 * HIRC comes from either the current bank (if it already has HIRC) or a
 * companion events BNK (the common case in League: `*_audio.bnk` pairs with
 * `*_events.bnk` in the same folder).
 */
export type HircSource =
    | { kind: 'self' }
    | { kind: 'external'; path: string; source: 'auto' | 'manual' }
    | { kind: 'missing' };

export interface DecodedCacheEntry {
    url: string;
    format: 'ogg' | 'wav';
    bytes: Uint8Array;
}

export interface EventGroup {
    name: string;
    /** Unique WEM IDs in mapping order (may include repeats from containers). */
    wemIds: number[];
}

// Unicode glyphs match the Audio Cutter modal toolbar ('▶ Play' / '■ Stop')
export const PLAY_GLYPH = '▶';
export const STOP_GLYPH = '■';
export const CARET_ICON = `<svg width="10" height="10" viewBox="0 0 10 10" fill="none" xmlns="http://www.w3.org/2000/svg"><path d="M3 2l4 3-4 3V2z" fill="currentColor"/></svg>`;
