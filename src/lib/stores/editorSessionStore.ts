/**
 * Editor Session Store
 *
 * In-memory, session-only cache of live editor state keyed by absolute file
 * path. Lets text editors (BIN / Inibin Monaco editors, StringTable) preserve
 * unsaved edits + cursor/scroll across remounts (project-tab switch, file
 * switch, view switch, preview <-> full-screen) instead of re-decoding from
 * disk and discarding in-progress work.
 *
 * This is a plain imperative singleton, NOT a Zustand store: editors read it
 * once on mount and write once on unmount, so there is no React subscription
 * and no re-render cost.
 *
 * Invalidation: a session is only valid while its `fileVersion` matches the
 * current file version (bumped by the file watcher on every disk change,
 * including the user's own save) and its `variant` matches (e.g. the BIN
 * converter engine). A mismatch means the cache is stale -> re-decode.
 *
 * Bounds: an LRU cap on both session count and total cached bytes evicts the
 * oldest sessions so large BINs don't accumulate unbounded across many tabs.
 */

import type { editor } from 'monaco-editor';

export interface EditorSession {
    /** File version this session was captured against (see appMetadataStore). */
    fileVersion: number;
    /** Live (possibly dirty) editor text. For non-text editors, a serialized form. */
    content: string;
    /** On-disk baseline at load time -> dirty = content !== originalContent. */
    originalContent: string;
    /** Decode-variant discriminator (e.g. 'jade' | 'ltk'); undefined for editors without variants. */
    variant?: string;
    /** Monaco view state (cursor/selection/scroll/folding) for Monaco editors. */
    viewState?: editor.ICodeEditorViewState | null;
    /** Scroll offset for the non-Monaco StringTable virtual list. */
    scrollOffset?: number;
    /** Monotonic counter for LRU ordering (not wall-clock). */
    savedAt: number;
}

/** Fields a caller provides; `savedAt` is assigned internally. */
export type EditorSessionInput = Omit<EditorSession, 'savedAt'>;

const MAX_SESSIONS = 20;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024; // ~150 MB of cached text

const sessions = new Map<string, EditorSession>();
let saveCounter = 0;

/** Normalize a path for prefix matching (forward slashes, lowercased — Windows). */
function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
}

function sessionBytes(s: EditorSession): number {
    return s.content.length + s.originalContent.length;
}

/** Evict oldest sessions until both the count and byte caps are satisfied. */
function evict(): void {
    let totalBytes = 0;
    for (const s of sessions.values()) totalBytes += sessionBytes(s);

    if (sessions.size <= MAX_SESSIONS && totalBytes <= MAX_TOTAL_BYTES) return;

    // Oldest first by savedAt.
    const ordered = [...sessions.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
    for (const [key, s] of ordered) {
        if (sessions.size <= 1) break; // never evict the only (newest) entry
        if (sessions.size <= MAX_SESSIONS && totalBytes <= MAX_TOTAL_BYTES) break;
        sessions.delete(key);
        totalBytes -= sessionBytes(s);
    }
}

export const editorSessionStore = {
    get(path: string): EditorSession | undefined {
        return sessions.get(path);
    },

    save(path: string, session: EditorSessionInput): void {
        sessions.set(path, { ...session, savedAt: ++saveCounter });
        evict();
    },

    remove(path: string): void {
        sessions.delete(path);
    },

    /** Drop every session whose path is under `prefix` (e.g. a closed project root). */
    pruneByPrefix(prefix: string): void {
        const norm = normalizePath(prefix);
        for (const key of [...sessions.keys()]) {
            if (normalizePath(key).startsWith(norm)) sessions.delete(key);
        }
    },

    clear(): void {
        sessions.clear();
    },

    /** Test/debug helper. */
    _size(): number {
        return sessions.size;
    },
};
