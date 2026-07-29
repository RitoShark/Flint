/**
 * OS drag-and-drop of folders onto a region of the window.
 *
 * Tauri delivers native drops as webview events rather than DOM `dragover`/
 * `drop`, so HTML drop handlers never fire for files coming from Explorer.
 * The payload carries a window-space position, which means a component that
 * only wants drops over its own area has to hit-test that position itself.
 *
 * The dual logical/physical check below is deliberate: which coordinate space
 * the payload uses varies with the platform and the display's scale factor, so
 * accepting a hit in either space is what makes this work on scaled Windows
 * displays. (Established by the drop zone in NewProjectModal.)
 */

import { useEffect, useRef, useState } from 'react';
import type { RefObject } from 'react';
import { getCurrentWebview } from '@tauri-apps/api/webview';

interface DragPosition {
    x: number;
    y: number;
}

function isInside(el: HTMLElement | null, pos: DragPosition | undefined): boolean {
    if (!el || !pos) return false;
    const r = el.getBoundingClientRect();
    if (r.width === 0 && r.height === 0) return false;

    const insideLogical = pos.x >= r.left && pos.x <= r.right && pos.y >= r.top && pos.y <= r.bottom;

    const ratio = window.devicePixelRatio || 1;
    const px = pos.x / ratio;
    const py = pos.y / ratio;
    const insidePhysical = px >= r.left && px <= r.right && py >= r.top && py <= r.bottom;

    return insideLogical || insidePhysical;
}

export interface FolderDropOptions {
    /** Element the drop must land on. Omit to accept drops anywhere in the window. */
    zoneRef?: RefObject<HTMLElement | null>;
    /** Listener is only attached while true — lets a hidden modal stay inert. */
    enabled?: boolean;
}

/**
 * Calls `onDrop` with the first dropped path that lands inside the zone.
 *
 * Returns whether a drag is currently hovering the zone, for highlight styling.
 * `onDrop` is held in a ref so a re-created callback doesn't tear down and
 * re-register the webview listener on every render.
 */
export function useFolderDrop(
    onDrop: (path: string) => void,
    { zoneRef, enabled = true }: FolderDropOptions = {},
): boolean {
    const [dragOver, setDragOver] = useState(false);
    const onDropRef = useRef(onDrop);
    onDropRef.current = onDrop;

    useEffect(() => {
        if (!enabled) {
            setDragOver(false);
            return;
        }

        let cancelled = false;
        let unlisten: (() => void) | undefined;

        const accepts = (pos: DragPosition | undefined) =>
            zoneRef ? isInside(zoneRef.current, pos) : true;

        getCurrentWebview()
            .onDragDropEvent((event) => {
                if (cancelled) return;
                const payload = event.payload as {
                    type: string;
                    position?: DragPosition;
                    paths?: string[];
                };

                if (payload.type === 'over') {
                    setDragOver(accepts(payload.position));
                    return;
                }

                if (payload.type === 'drop') {
                    setDragOver(false);
                    if (!accepts(payload.position)) return;
                    const first = payload.paths?.[0];
                    if (!first) return;
                    onDropRef.current(first);
                    return;
                }

                // 'leave' / 'cancel'
                setDragOver(false);
            })
            .then((fn) => {
                if (cancelled) fn();
                else unlisten = fn;
            })
            .catch((err) => console.error('[useFolderDrop] listener setup failed:', err));

        return () => {
            cancelled = true;
            if (unlisten) unlisten();
        };
    }, [enabled, zoneRef]);

    return dragOver;
}
