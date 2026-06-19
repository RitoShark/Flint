export interface PointerDragHandlers {
    onMove?: (x: number, y: number) => void;
    /** Fired on release if a real drag occurred. Client coords are CSS pixels;
     *  screen coords are for out-of-window detection. */
    onDrop?: (info: { clientX: number; clientY: number; screenX: number; screenY: number }) => void;
    /** Always fired when the gesture ends (drag or not). */
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

/** Call from a `pointerdown` handler; the gesture resolves through the callbacks. */
export function beginPointerDrag(
    e: React.PointerEvent | PointerEvent,
    opts: PointerDragOptions,
): void {
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
            const swallow = (clickEv: Event) => {
                clickEv.stopPropagation();
                clickEv.preventDefault();
            };
            document.addEventListener('click', swallow, { capture: true, once: true });
            setTimeout(() => document.removeEventListener('click', swallow, true), 0);
        }
        opts.onEnd?.();
    };

    document.addEventListener('pointermove', move, true);
    document.addEventListener('pointerup', up, true);
}
