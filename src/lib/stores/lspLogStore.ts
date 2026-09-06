import { create } from 'zustand';
import type { LspDiagnostic } from '../editor/ritobinLspProtocol';
import type { BracketFix } from '../editor/ritobinLspDiagnostics';

export interface LiveLsp {
    session: string;
    filePath: string;
    state: 'starting' | 'ready' | 'error';
    message: string;
    /** null means the current text has not been checked yet. */
    diagnostics: LspDiagnostic[] | null;
    bracketFix: (BracketFix & { apply: () => boolean }) | null;
    requests: string[];
    requestErrors: Record<string, string>;
    output: { level: 'info' | 'warning' | 'error'; message: string } | null;
    reveal: (line: number, column: number) => void;
}

/** An ephemeral snapshot owned by the mounted editor, never an accumulating log. */
export const useLspLogStore = create<{
    live: LiveLsp | null;
    begin: (session: string, filePath: string, reveal: LiveLsp['reveal']) => void;
    update: (session: string, patch: Partial<Omit<LiveLsp, 'session' | 'filePath' | 'reveal'>>) => void;
    end: (session: string) => void;
}>((set) => ({
    live: null,
    begin: (session, filePath, reveal) => set({ live: {
        session, filePath, reveal, state: 'starting', message: 'Starting LSP…',
        diagnostics: null, bracketFix: null, requests: [], requestErrors: {}, output: null,
    } }),
    update: (session, patch) => set(state => state.live?.session === session
        ? { live: { ...state.live, ...patch } } : state),
    end: session => set(state => state.live?.session === session ? { live: null } : state),
}));
