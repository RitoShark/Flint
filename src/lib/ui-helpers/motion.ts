export function motionDuration(milliseconds: number): number {
    if (typeof document === 'undefined') return 0;
    if (document.documentElement.dataset.fps === 'on') return 0;
    if (typeof matchMedia === 'function' && matchMedia('(prefers-reduced-motion: reduce)').matches) return 0;
    return milliseconds;
}
