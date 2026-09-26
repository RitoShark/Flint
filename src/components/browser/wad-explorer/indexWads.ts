import { loadAllWadChunks } from '../../../lib/api/wad';
import { useWadExplorerStore } from '../../../lib/stores/wadExplorerStore';

export function startWadIndexing(): () => void {
    const paths = useWadExplorerStore.getState().wads.filter(w => w.status === 'idle').map(w => w.path);
    let cancelled = false;
    let inFlight: string[] = [];

    void (async () => {
        for (let i = 0; i < paths.length && !cancelled; i += 64) {
            const store = useWadExplorerStore.getState();
            const idle = new Set(store.wads.filter(w => w.status === 'idle').map(w => w.path));
            const batch = paths.slice(i, i + 64).filter(p => idle.has(p));
            if (batch.length === 0) continue;
            inFlight = batch;
            store.batchSetWadStatuses(batch.map(wadPath => ({ wadPath, status: 'loading' })));
            try {
                const results = await loadAllWadChunks(batch);
                if (cancelled) return;
                store.batchSetWadStatuses(results.map(b => ({
                    wadPath: b.path,
                    status: b.error ? 'error' : 'loaded',
                    chunks: b.chunks,
                    error: b.error ?? undefined,
                })));
                const failed = results.find(b => b.error);
                if (failed) throw new Error(`${failed.path}: ${failed.error}`);
            } catch (error) {
                if (cancelled) return;
                const message = error instanceof Error ? error.message : String(error);
                const loading = new Set(useWadExplorerStore.getState().wads.filter(w => w.status === 'loading').map(w => w.path));
                store.batchSetWadStatuses(batch.filter(p => loading.has(p)).map(wadPath => ({
                    wadPath, status: 'error', error: message,
                })));
                useWadExplorerStore.setState({ scanStatus: 'error', scanError: `WAD indexing stopped: ${message}` });
                return;
            } finally {
                inFlight = [];
            }
        }
    })();

    return () => {
        cancelled = true;
        const store = useWadExplorerStore.getState();
        const loading = new Set(store.wads.filter(w => w.status === 'loading').map(w => w.path));
        store.batchSetWadStatuses(inFlight.filter(p => loading.has(p)).map(wadPath => ({ wadPath, status: 'idle' })));
    };
}
