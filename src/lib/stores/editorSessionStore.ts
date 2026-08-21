import type { editor } from 'monaco-editor';

export interface EditorSession {
    /** File version this session was captured against (see appMetadataStore). */
    fileVersion: number;
    /** Live (possibly dirty) editor text. For non-text editors, a serialized form. */
    content: string;
    /** On-disk baseline at load time -> dirty = content !== originalContent. */
    originalContent: string;
    /** Decode-variant discriminator; undefined for editors without variants. */
    variant?: string;
    viewState?: editor.ICodeEditorViewState | null;
    /** Scroll offset for the non-Monaco StringTable virtual list. */
    scrollOffset?: number;
    /** Monotonic counter for LRU ordering (not wall-clock). */
    savedAt: number;
}

/** Fields a caller provides; `savedAt` is assigned internally. */
export type EditorSessionInput = Omit<EditorSession, 'savedAt'>;

const MAX_SESSIONS = 20;
const MAX_TOTAL_BYTES = 150 * 1024 * 1024;

const sessions = new Map<string, EditorSession>();
let saveCounter = 0;

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

    const ordered = [...sessions.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
    for (const [key, s] of ordered) {
        if (sessions.size <= 1) break;
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

    /**
     * Move the session for `oldPath` — and every session beneath it, when a
     * folder was renamed — onto the new path, so a rename doesn't discard the
     * open editor's unsaved text.
     */
    rename(oldPath: string, newPath: string): void {
        const oldKey = normalizePath(oldPath);
        for (const [key, session] of [...sessions.entries()]) {
            const norm = normalizePath(key);
            if (norm === oldKey) {
                sessions.delete(key);
                sessions.set(newPath, session);
            } else if (norm.startsWith(`${oldKey}/`)) {
                sessions.delete(key);
                sessions.set(newPath + key.slice(oldPath.length), session);
            }
        }
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
