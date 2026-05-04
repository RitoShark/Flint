/**
 * Cursor-following glow for `.btn`. Single delegated mousemove listener on
 * document — sets `--mx` / `--my` on the hovered button so the radial-glow
 * `::after` overlay tracks the cursor.
 *
 * Two perf-critical guards vs. the naive version:
 *   1. Throttled to one update per frame via rAF — without this, the listener
 *      fires every mousemove (~120Hz on high-refresh mice) and we'd be doing
 *      a layout-flushing getBoundingClientRect call each time.
 *   2. Cache the bounding rect for the hovered element. The rect only changes
 *      on layout shifts, not on mousemove, so reading it once per element is
 *      enough until the cursor leaves it.
 */
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
        // Cache the rect — only re-measure when the hovered element changes.
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

    // Invalidate the cached rect on scroll/resize so the glow stays aligned.
    const invalidate = () => {
        cachedRect = null;
    };
    window.addEventListener('scroll', invalidate, { passive: true, capture: true });
    window.addEventListener('resize', invalidate, { passive: true });
}
