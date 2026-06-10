/**
 * Pointer-based drag (mousedown → move → up), used INSTEAD of HTML5 `draggable`.
 *
 * Why: the app runs in a Tauri 2 WebView2 window with native OS drag-drop
 * enabled (`dragDropEnabled` defaults true) so the file tree / modals can read
 * real OS file paths from Explorer drags via `onDragDropEvent`. WebView2's
 * native drag-drop handler BLOCKS HTML5 drag-and-drop inside the webview (you
 * get a "no-drop" cursor and no `drop` events). So in-app dragging must be done
 * manually with pointer events, which are unaffected.
 *
 * `beginPointerDrag` is called from a draggable element's `pointerdown`. It only
 * starts a real drag once the pointer moves past `threshold` px (so a normal
 * click still works), renders a floating ghost label that follows the cursor,
 * and reports client + screen coordinates to `onMove`/`onDrop`. After a real
 * drag it swallows the trailing `click` so the source element's click handler
 * (e.g. "select file" / "switch tab") doesn't also fire.
 */

export interface PointerDragHandlers {
    /** Fired on every move once the drag has started. */
    onMove?: (x: number, y: number) => void;
    /** Fired on release if a real drag occurred. Coords are CSS-pixel client
     *  coords; screen coords are for out-of-window detection (tab tear-off). */
    onDrop?: (info: { clientX: number; clientY: number; screenX: number; screenY: number }) => void;
    /** Always fired when the gesture ends (drag or not), for cleanup. */
    onEnd?: () => void;
}

export interface PointerDragOptions extends PointerDragHandlers {
    /** Text shown in the floating ghost that follows the cursor. */
    label: string;
    /** Pixels of movement before the gesture counts as a drag. Default 5. */
    threshold?: number;
}

let activeGhost: HTMLElement | null = null;

function makeGhost(label: string): HTMLElement {
    const el = document.createElement('div');
    el.className = 'pointer-drag-ghost';
    el.textContent = label;
    document.body.appendChild(el);
    return el;
}

function removeGhost() {
    if (activeGhost) {
        activeGhost.remove();
        activeGhost = null;
    }
}

/**
 * Start tracking a pointer drag. Call from a `pointerdown` handler. Returns
 * immediately; the gesture resolves through the provided callbacks.
 */
export function beginPointerDrag(
    e: React.PointerEvent | PointerEvent,
    opts: PointerDragOptions,
): void {
    // Only react to the primary (left) button.
    if (e.button !== 0) return;

    const startX = e.clientX;
    const startY = e.clientY;
    const threshold = opts.threshold ?? 5;
    let dragging = false;

    const move = (ev: PointerEvent) => {
        if (!dragging) {
            const dx = ev.clientX - startX;
            const dy = ev.clientY - startY;
            if (dx * dx + dy * dy < threshold * threshold) return;
            dragging = true;
            activeGhost = makeGhost(opts.label);
        }
        if (activeGhost) {
            activeGhost.style.left = `${ev.clientX + 12}px`;
            activeGhost.style.top = `${ev.clientY + 12}px`;
        }
        opts.onMove?.(ev.clientX, ev.clientY);
    };

    const up = (ev: PointerEvent) => {
        document.removeEventListener('pointermove', move, true);
        document.removeEventListener('pointerup', up, true);
        removeGhost();

        if (dragging) {
            opts.onDrop?.({
                clientX: ev.clientX,
                clientY: ev.clientY,
                screenX: ev.screenX,
                screenY: ev.screenY,
            });
            // Swallow the click that follows a drag so the source's onClick
            // (select file / switch tab) doesn't also fire.
            const swallow = (clickEv: Event) => {
                clickEv.stopPropagation();
                clickEv.preventDefault();
            };
            document.addEventListener('click', swallow, { capture: true, once: true });
            // Safety: if no click arrives, drop the one-shot listener next tick.
            setTimeout(() => document.removeEventListener('click', swallow, true), 0);
        }
        opts.onEnd?.();
    };

    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
}
