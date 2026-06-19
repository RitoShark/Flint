let installed = false;

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

    document.addEventListener(
        'mousemove',
        (e) => {
            lastEvent = { x: e.clientX, y: e.clientY, target: e.target as HTMLElement | null };
            if (!pending) {
                pending = true;
                requestAnimationFrame(flush);
            }
        },
        { passive: true },
    );

    const invalidate = () => {
        cachedRect = null;
    };
    window.addEventListener('scroll', invalidate, { passive: true, capture: true });
    window.addEventListener('resize', invalidate, { passive: true });
}
