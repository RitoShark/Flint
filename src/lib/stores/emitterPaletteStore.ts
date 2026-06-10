/**
 * Emitter Palette Store
 * ---------------------
 * Holds blocks of ritobin text the user has copied out of a BIN editor —
 * single `emitter` / `VfxEmitterDefinitionData` blocks, or whole
 * `VfxSystemDefinitionData` blocks. The left-side palette panel
 * (`EmitterPalette.tsx`) subscribes to this store and lets the user drag a
 * copied block into the Monaco editor of any open BIN.
 *
 * This is how cross-bin copy works: copy from bin A (writes here), open bin B,
 * drag from the palette into B.
 *
 * Persisted to localStorage so copied blocks survive bin switches and full
 * sessions. Kept small — just the block text + a little metadata.
 */

import { create } from 'zustand';

// v2 added `sourceProject`, `sourceBinPath`, `assets` (used to copy referenced
// asset files when a block is dropped into a different project). Reading the old
// v1 entries would still work (the new fields are optional), but bumping the key
// keeps the persisted shape unambiguous.
const STORAGE_KEY = 'flint_emitter_palette_v2';

/** A single copied ritobin block sitting in the palette. */
export interface CopiedBlock {
    /** Stable unique id (used as the drag payload). */
    id: string;
    /** Human label shown in the palette — emitterName if present, else className. */
    label: string;
    /** The block's class name (e.g. VfxEmitterDefinitionData). */
    className: string;
    /** The full block text (header `ClassName {` … matching `}`), as copied. */
    text: string;
    /** Epoch millis when it was copied. */
    createdAt: number;
    /**
     * Absolute path of the project the block was copied FROM. Used to copy the
     * referenced asset files when the block is dropped into a different project.
     * Optional for backward-compat / blocks copied outside a known project.
     */
    sourceProject?: string;
    /**
     * Absolute path of the BIN file the block was copied from. Used as the base
     * when resolving the block's relative asset paths to real files on disk.
     */
    sourceBinPath?: string;
    /** Asset path strings referenced by the block (textures/meshes/sounds). */
    assets?: string[];
}

interface EmitterPaletteState {
    blocks: CopiedBlock[];
    /** Add a copied block. Returns the generated id. */
    add: (block: Omit<CopiedBlock, 'id' | 'createdAt'>) => string;
    /** Remove a single block by id. */
    remove: (id: string) => void;
    /** Remove every block. */
    clear: () => void;
    /** Look up a block by id (non-reactive convenience for drop handlers). */
    getById: (id: string) => CopiedBlock | undefined;
}

function readStorage(): CopiedBlock[] {
    try {
        const raw = localStorage.getItem(STORAGE_KEY);
        if (!raw) return [];
        const parsed = JSON.parse(raw);
        if (!Array.isArray(parsed)) return [];
        // Defensive: keep only well-formed entries.
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
