import { useState } from 'react';
import { useWadExplorerStore } from '../../../lib/stores';
import { getWadChunks } from '../../../lib/api/wad';
import { WadGrepModal, type WadGrepRequest } from './WadGrepModal';

export function useWadGrep(onNavigate: (wadPath: string, filePath: string) => void) {
    const [request, setRequest] = useState<WadGrepRequest | null>(null);
    const [reveal, setReveal] = useState<{ wadPath: string; hash: string; line: number } | null>(null);
    const wads = useWadExplorerStore(s => s.wads);
    const selected = useWadExplorerStore(s => s.selected);
    return {
        open: setRequest,
        line: selected?.wadPath === reveal?.wadPath && selected?.hash === reveal?.hash ? reveal?.line : undefined,
        modal: request && <WadGrepModal request={request} wads={wads} onClose={() => setRequest(null)} onOpen={async (file, line) => {
            const store = useWadExplorerStore.getState();
            const wad = store.wads.find(w => w.path === file.wad_path);
            if (!wad) throw new Error('WAD is no longer in the explorer');
            if (wad.status !== 'loaded') store.setWadStatus(wad.path, 'loaded', await getWadChunks(wad.path));
            store.setSelected(file.wad_path, file.hash);
            setReveal({ wadPath: file.wad_path, hash: file.hash, line });
            onNavigate(file.wad_path, file.path);
        }} />,
    };
}
