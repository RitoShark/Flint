import { create } from 'zustand';

/**
 * Whether the workspace-search sidebar is showing, and which BIN seeded it.
 *
 * The trigger (a button in the BIN editor's toolbar) and the surface (the left
 * panel in a project, a standalone sidebar in the file editor) are in different
 * subtrees, so the state lives here rather than being threaded through props.
 */
interface SearchPanelState {
    open: boolean;
    /** The BIN that was open when search was asked for; seeds linked-bin resolution. */
    seedBin: string | null;
    toggle: (seedBin: string | null) => void;
    setOpen: (open: boolean) => void;
}

export const useSearchPanelStore = create<SearchPanelState>()((set, get) => ({
    open: false,
    seedBin: null,
    toggle: (seedBin) => set({ open: !get().open, seedBin }),
    setOpen: (open) => set({ open }),
}));
