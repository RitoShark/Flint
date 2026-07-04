let installed = false;
let teardown: (() => void) | null = null;

export function installButtonGlow() {
    if (installed || typeof document === 'undefined') return;
    installed = true;

    let pending = false;
    let lastEvent: { x: number; y: number; target: HTMLElement | null } | null = null;
    let cachedTarget: HTMLElement | null = null;
    let cachedRect: DOMRect | null = null;

    const flush = () => {
        pending = false;
        const ev = lastEvent;
        if (!ev) return;
        const target = ev.target?.closest<HTMLElement>('.btn, .np-champ-card') ?? null;
        if (!target) {
            cachedTarget = null;
            cachedRect = null;
            return;
        }
        if (target !== cachedTarget) {
            cachedTarget = target;
            cachedRect = target.getBoundingClientRect();
        }
        if (!cachedRect) return;
        target.style.setProperty('--mx', `${ev.x - cachedRect.left}px`);
        target.style.setProperty('--my', `${ev.y - cachedRect.top}px`);
    };

    const onMouseMove = (e: MouseEvent) => {
        lastEvent = { x: e.clientX, y: e.clientY, target: e.target as HTMLElement | null };
        if (!pending) {
            pending = true;
            requestAnimationFrame(flush);
        }
    };

    const invalidate = () => {
        cachedRect = null;
    };

    document.addEventListener('mousemove', onMouseMove, { passive: true });
    window.addEventListener('scroll', invalidate, { passive: true, capture: true });
    window.addEventListener('resize', invalidate, { passive: true });

    teardown = () => {
        document.removeEventListener('mousemove', onMouseMove);
        window.removeEventListener('scroll', invalidate, { capture: true } as EventListenerOptions);
        window.removeEventListener('resize', invalidate);
    };
}

export function uninstallButtonGlow() {
    if (!installed) return;
    installed = false;
    teardown?.();
    teardown = null;
}

/** Attach or detach the cursor-tracking listener to match the user preference. */
export function setButtonGlow(enabled: boolean) {
    if (enabled) {
        installButtonGlow();
    } else {
        uninstallButtonGlow();
    }
}
