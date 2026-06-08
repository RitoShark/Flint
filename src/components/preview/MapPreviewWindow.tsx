/**
 * Flint - MapPreviewWindow
 * Top-level root for the separate map-preview window. Mounted by main.tsx when
 * the location hash starts with `#map-preview`. Parses the project path from
 * the hash query and hosts <MapPreview>; also handles window reuse (the Rust
 * side emits "map-preview-load" when the existing window is focused with a new
 * project).
 */
import React, { useEffect, useState } from 'react';
import { listen } from '@tauri-apps/api/event';
import { MapPreview } from './MapPreview';

/** Parse `?project=...` from the location hash (`#map-preview?project=...`). */
function projectFromHash(): string {
    const hash = window.location.hash; // e.g. "#map-preview?project=..."
    const q = hash.indexOf('?');
    if (q < 0) return '';
    const params = new URLSearchParams(hash.slice(q + 1));
    return params.get('project') || '';
}

export const MapPreviewWindow: React.FC = () => {
    const [project, setProject] = useState<string>(() => projectFromHash());

    // The Rust side emits "map-preview-load" when this window is reused.
    useEffect(() => {
        let unlisten: (() => void) | undefined;
        listen<string>('map-preview-load', (ev) => setProject(ev.payload))
            .then(u => { unlisten = u; });
        return () => unlisten?.();
    }, []);

    if (!project) {
        return (
            <div style={{ color: '#ddd', padding: 24, font: '14px system-ui' }}>
                No project specified for map preview.
            </div>
        );
    }
    return <MapPreview key={project} projectPath={project} />;
};
