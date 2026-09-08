export interface Accent {
    /** Dominant saturated colour, as `r, g, b` for use inside color-mix/rgb(). */
    c1: string;
    /** Second colour, falls back to a darkened c1 when the image is monochrome. */
    c2: string;
}

const SAMPLE_SIZE = 24;
const cache = new Map<string, Accent | null>();
const inflight = new Map<string, Promise<Accent | null>>();

function rgbToHsl(r: number, g: number, b: number): [number, number, number] {
    const rn = r / 255, gn = g / 255, bn = b / 255;
    const max = Math.max(rn, gn, bn), min = Math.min(rn, gn, bn);
    const l = (max + min) / 2;
    if (max === min) return [0, 0, l];
    const d = max - min;
    const s = l > 0.5 ? d / (2 - max - min) : d / (max + min);
    let h: number;
    if (max === rn) h = ((gn - bn) / d + (gn < bn ? 6 : 0)) / 6;
    else if (max === gn) h = ((bn - rn) / d + 2) / 6;
    else h = ((rn - gn) / d + 4) / 6;
    return [h, s, l];
}

/**
 * Buckets pixels by hue and returns the two heaviest buckets, weighted by
 * saturation so a mostly-grey portrait still yields its one coloured accent.
 * Near-black, near-white and washed-out pixels are dropped first — without that
 * every champion resolves to the same dark grey.
 */
function extract(image: HTMLImageElement): Accent | null {
    const canvas = document.createElement('canvas');
    canvas.width = SAMPLE_SIZE;
    canvas.height = SAMPLE_SIZE;
    const ctx = canvas.getContext('2d', { willReadFrequently: true });
    if (!ctx) return null;

    try {
        ctx.drawImage(image, 0, 0, SAMPLE_SIZE, SAMPLE_SIZE);
        const { data } = ctx.getImageData(0, 0, SAMPLE_SIZE, SAMPLE_SIZE);

        const BUCKETS = 18;
        const weight = new Float64Array(BUCKETS);
        const sums = Array.from({ length: BUCKETS }, () => [0, 0, 0, 0]);

        for (let i = 0; i < data.length; i += 4) {
            if (data[i + 3] < 128) continue;
            const r = data[i], g = data[i + 1], b = data[i + 2];
            const [h, s, l] = rgbToHsl(r, g, b);
            if (l < 0.12 || l > 0.92 || s < 0.18) continue;
            const bucket = Math.min(BUCKETS - 1, Math.floor(h * BUCKETS));
            const w = s * (1 - Math.abs(l - 0.5));
            weight[bucket] += w;
            sums[bucket][0] += r * w;
            sums[bucket][1] += g * w;
            sums[bucket][2] += b * w;
            sums[bucket][3] += w;
        }

        const ranked = Array.from(weight.keys())
            .filter((i) => weight[i] > 0)
            .sort((a, b) => weight[b] - weight[a]);
        if (ranked.length === 0) return null;

        const toRgb = (i: number) => {
            const [r, g, b, w] = sums[i];
            return `${Math.round(r / w)}, ${Math.round(g / w)}, ${Math.round(b / w)}`;
        };

        const c1 = toRgb(ranked[0]);
        return { c1, c2: ranked.length > 1 ? toRgb(ranked[1]) : c1 };
    } catch {
        // A cross-origin frame taints the canvas; callers fall back to neutral.
        return null;
    }
}

export function getCachedAccent(url: string): Accent | null | undefined {
    return cache.get(url);
}

export function loadAccent(url: string): Promise<Accent | null> {
    const hit = cache.get(url);
    if (hit !== undefined) return Promise.resolve(hit);
    const pending = inflight.get(url);
    if (pending) return pending;

    const promise = new Promise<Accent | null>((resolve) => {
        const img = new Image();
        img.crossOrigin = 'anonymous';
        img.onload = () => resolve(extract(img));
        img.onerror = () => resolve(null);
        img.src = url;
    }).then((accent) => {
        cache.set(url, accent);
        inflight.delete(url);
        return accent;
    });

    inflight.set(url, promise);
    return promise;
}
