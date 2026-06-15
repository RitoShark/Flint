import { create } from 'zustand';

const STORAGE_KEY = 'flint_emitter_palette_v2';

export interface CopiedBlock {
    /** Stable unique id (used as the drag payload). */
    id: string;
    /** Label shown in the palette — emitterName if present, else className. */
    label: string;
    className: string;
    /** The full block text (header `ClassName {` … matching `}`), as copied. */
    text: string;
    /** Epoch millis when it was copied. */
    createdAt: number;
    /** Absolute path of the project the block was copied FROM. */
    sourceProject?: string;
    /** Absolute path of the BIN file the block was copied from. */
    sourceBinPath?: string;
    /** Asset path strings referenced by the block (textures/meshes/sounds). */
    assets?: string[];
}

interface EmitterPaletteState {
    blocks: CopiedBlock[];
    /** Add a copied block. Returns the generated id. */
    add: (block: Omit<CopiedBlock, 'id' | 'createdAt'>) => string;
    remove: (id: string) => void;
    clear: () => void;
    getById: (id: string) => CopiedBlock | undefined;
}

function readStorage(): CopiedBlock[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        return parsed.filter(
            (b): b is CopiedBlock =>
                b && typeof b.id === 'string' && typeof b.text === 'string' && typeof b.label === 'string',
        );
    } catch {
        return [];
    }
}

function writeStorage(blocks: CopiedBlock[]) {
    try {
        localStorage.setItem(STORAGE_KEY, JSON.stringify(blocks));
    } catch {
        /* quota exceeded — non-fatal */
    }
}

let idCounter = 0;
function nextId(): string {
    idCounter += 1;
    return `blk_${Date.now().toString(36)}_${idCounter.toString(36)}`;
}

export const useEmitterPaletteStore = create<EmitterPaletteState>()((set, get) => ({
    blocks: readStorage(),

    add: (block) => {
        const id = nextId();
        const entry: CopiedBlock = { ...block, id, createdAt: Date.now() };
        set((state) => {
            const blocks = [entry, ...state.blocks];
            writeStorage(blocks);
            return { blocks };
        });
        return id;
    },

    remove: (id) => {
        set((state) => {
            const blocks = state.blocks.filter((b) => b.id !== id);
            writeStorage(blocks);
            return { blocks };
        });
    },

    clear: () => {
        writeStorage([]);
        set({ blocks: [] });
    },

    getById: (id) => get().blocks.find((b) => b.id === id),
}));
