export interface ModelPreviewSession {
    /** File version this session was captured against (see appMetadataStore). */
    fileVersion: number;
    /** Material/mesh names toggled visible. */
    visibleMaterials: string[];
    /** animation_path of the selected clip ('' = none). */
    selectedAnimation: string;
    isPlaying: boolean;
    /** Playhead in seconds. */
    currentTime: number;
    /** ArcRotateCamera framing. */
    camera?: { alpha: number; beta: number; radius: number; target: [number, number, number] };
    /** Monotonic counter for LRU ordering (not wall-clock). */
    savedAt: number;
}

export type ModelPreviewSessionInput = Omit<ModelPreviewSession, 'savedAt'>;

const MAX_SESSIONS = 30;

const sessions = new Map<string, ModelPreviewSession>();
let saveCounter = 0;

function normalizePath(p: string): string {
    return p.replace(/\\/g, '/').toLowerCase();
}

function evict(): void {
    if (sessions.size <= MAX_SESSIONS) return;
    const ordered = [...sessions.entries()].sort((a, b) => a[1].savedAt - b[1].savedAt);
    for (const [key] of ordered) {
        if (sessions.size <= MAX_SESSIONS) break;
        sessions.delete(key);
    }
}

export const modelPreviewSessionStore = {
    get(path: string): ModelPreviewSession | undefined {
        return sessions.get(normalizePath(path));
    },

    save(path: string, session: ModelPreviewSessionInput): void {
        sessions.set(normalizePath(path), { ...session, savedAt: ++saveCounter });
        evict();
    },

    remove(path: string): void {
        sessions.delete(normalizePath(path));
    },

    /** Drop every session whose path is under `prefix` (e.g. a closed project root). */
    pruneByPrefix(prefix: string): void {
        const norm = normalizePath(prefix);
        for (const key of [...sessions.keys()]) {
            if (key.startsWith(norm)) sessions.delete(key);
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
