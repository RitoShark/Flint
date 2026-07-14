// ─── Types ───────────────────────────────────────────────────────────────────

export interface GridResult {
    cols: number;
    rows: number;
    sheetWidth: number;
    sheetHeight: number;
}

export interface BudgetResult {
    fits: boolean;
    frameW: number;
    frameH: number;
    totalFrames: number;
    grid: GridResult | null;
    /** Suggested lower frame counts that would fit, if current doesn't */
    suggestedFrameCounts: number[];
}

export interface VideoMeta {
    width: number;
    height: number;
    duration: number;
    /** Detected or user-specified FPS */
    fps: number;
}

/**
 * How a source frame is mapped into the (possibly differently-shaped) output frame.
 * - `stretch`  — distort the source to fill the whole frame (may change aspect ratio).
 * - `cover`    — scale to cover the frame, cropping the overflow (no distortion).
 * - `contain`  — scale to fit inside the frame, letterboxing the remainder (no distortion, no crop).
 */
export type FitMode = 'stretch' | 'cover' | 'contain';

export interface SpritesheetParams {
    file: File;
    trimStart: number;
    trimEnd: number;
    scaleFactor: number;
    fps: number;
    grid: GridResult;
    frameW: number;
    frameH: number;
    /** How the source video maps into each frame cell. Defaults to `stretch`. */
    fitMode?: FitMode;
    onProgress?: (current: number, total: number) => void;
}

// ─── Constants ───────────────────────────────────────────────────────────────

const MAX_TEXTURE_DIM = 16384;

/** League loadscreens are authored 16:9. Forced-resolution presets, all 16:9. */
export const LOADSCREEN_RESOLUTIONS = [
    { label: '1920 × 1080', width: 1920, height: 1080 },
    { label: '1280 × 720', width: 1280, height: 720 },
] as const;

// ─── Fit-mode geometry ───────────────────────────────────────────────────────

export interface DrawRect {
    dx: number;
    dy: number;
    dw: number;
    dh: number;
}

/**
 * Compute the destination rectangle for drawing a `srcW×srcH` source frame into
 * a `frameW×frameH` cell under the given fit mode. The caller is expected to
 * clear/letterbox the cell first (contain leaves gaps; cover overflows and is
 * clipped by the caller's clip region).
 */
export function computeDrawRect(
    srcW: number,
    srcH: number,
    frameW: number,
    frameH: number,
    fitMode: FitMode,
): DrawRect {
    if (fitMode === 'stretch' || srcW <= 0 || srcH <= 0) {
        return { dx: 0, dy: 0, dw: frameW, dh: frameH };
    }

    const srcAspect = srcW / srcH;
    const frameAspect = frameW / frameH;
    const srcIsWider = srcAspect >= frameAspect;

    // contain (fit inside, letterbox): a wider-than-frame source is limited by width.
    // cover (fill, crop): the opposite axis — a wider source is limited by height.
    const constrainByWidth = fitMode === 'contain' ? srcIsWider : !srcIsWider;

    let dw: number;
    let dh: number;
    if (constrainByWidth) {
        dw = frameW;
        dh = frameW / srcAspect;
    } else {
        dh = frameH;
        dw = frameH * srcAspect;
    }

    return { dx: (frameW - dw) / 2, dy: (frameH - dh) / 2, dw, dh };
}

// ─── Grid Calculation ────────────────────────────────────────────────────────

/**
 * Find the grid dimensions (cols × rows) for a frame count that are as close to
 * square as possible while both dimensions fit within the 16384 pixel limit.
 */
export function calculateGrid(
    totalFrames: number,
    frameW: number,
    frameH: number,
): GridResult | null {
    if (totalFrames <= 0 || frameW <= 0 || frameH <= 0) return null;

    let bestResult: GridResult | null = null;
    let minGap = Infinity;

    for (let x = 1; x * x <= totalFrames; x++) {
        if (totalFrames % x !== 0) continue;

        const y = totalFrames / x;

        // Try both orientations: (x cols, y rows) and (y cols, x rows)
        for (const [cols, rows] of [[x, y], [y, x]] as [number, number][]) {
            const sw = cols * frameW;
            const sh = rows * frameH;

            if (sw > MAX_TEXTURE_DIM || sh > MAX_TEXTURE_DIM) continue;

            const gap = Math.abs(sw - sh);
            if (gap < minGap) {
                minGap = gap;
                bestResult = { cols, rows, sheetWidth: sw, sheetHeight: sh };
            }
        }
    }

    return bestResult;
}

/** Frame counts that would fit within the 16k limit, searching downward. */
function findSuggestedFrameCounts(
    fromFrames: number,
    frameW: number,
    frameH: number,
    maxSuggestions = 5,
): number[] {
    const suggestions: number[] = [];
    for (let f = fromFrames - 1; f >= 2 && suggestions.length < maxSuggestions; f--) {
        if (calculateGrid(f, frameW, frameH) !== null) {
            suggestions.push(f);
        }
    }
    return suggestions;
}

// ─── Budget Calculator ───────────────────────────────────────────────────────

export function calculateBudget(params: {
    videoWidth: number;
    videoHeight: number;
    scaleFactor: number;
    fps: number;
    trimStart: number;
    trimEnd: number;
    /** When set, the frame is forced to these dimensions (before scale) instead
     *  of following the source video's aspect ratio. Used for forced 16:9. */
    forcedWidth?: number;
    forcedHeight?: number;
}): BudgetResult {
    const { videoWidth, videoHeight, scaleFactor, fps, trimStart, trimEnd, forcedWidth, forcedHeight } = params;

    const baseW = forcedWidth ?? videoWidth;
    const baseH = forcedHeight ?? videoHeight;
    // The TEX is BC1 (4×4 blocks) and the encoder requires 4-aligned dimensions;
    // snapping each frame down to a multiple of 4 keeps the whole sheet aligned
    // (e.g. 1080p at 75% would otherwise yield an 810px-tall frame → corrupt TEX).
    const frameW = Math.max(4, Math.floor((baseW * scaleFactor) / 4) * 4);
    const frameH = Math.max(4, Math.floor((baseH * scaleFactor) / 4) * 4);
    const duration = trimEnd - trimStart;
    const totalFrames = Math.max(1, Math.floor(duration * fps));

    const grid = calculateGrid(totalFrames, frameW, frameH);
    const fits = grid !== null;

    const suggestedFrameCounts = fits
        ? []
        : findSuggestedFrameCounts(totalFrames, frameW, frameH);

    return { fits, frameW, frameH, totalFrames, grid, suggestedFrameCounts };
}

// ─── Video Metadata ──────────────────────────────────────────────────────────

export function getVideoMetadata(file: File): Promise<VideoMeta> {
    return new Promise((resolve, reject) => {
        console.info(`[getVideoMetadata] Extracting metadata for file: name="${file.name}", size=${file.size} bytes, type="${file.type}"`);
        const video = document.createElement('video');
        video.preload = 'metadata';
        video.muted = true;

        const url = URL.createObjectURL(file);
        console.info(`[getVideoMetadata] Created object URL: "${url}"`);

        video.onloadedmetadata = () => {
            const meta: VideoMeta = {
                width: video.videoWidth,
                height: video.videoHeight,
                duration: video.duration,
                fps: 30, // default — browsers don't expose native fps reliably
            };
            console.info(`[getVideoMetadata] Metadata loaded successfully: width=${meta.width}, height=${meta.height}, duration=${meta.duration}`);
            URL.revokeObjectURL(url);
            video.remove();
            resolve(meta);
        };

        video.onerror = (e) => {
            const errCode = video.error ? video.error.code : 'unknown';
            const errMsg = video.error ? video.error.message : 'no message';
            console.error(`[getVideoMetadata] video.onerror event triggered. Error code: ${errCode}, message: "${errMsg}"`, e);
            URL.revokeObjectURL(url);
            video.remove();
            reject(new Error(`Failed to load video file (Error code: ${errCode}, message: ${errMsg}). Ensure it is a valid video format (MP4, WebM).`));
        };

        video.src = url;
    });
}

function seekTo(video: HTMLVideoElement, time: number): Promise<void> {
    return new Promise((resolve) => {
        let timeoutId: any;
        const onSeeked = () => {
            clearTimeout(timeoutId);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
            resolve();
        };
        const onError = (e: any) => {
            clearTimeout(timeoutId);
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
            console.error(`[seekTo] Seek error at time ${time}s`, e);
            resolve();
        };

        timeoutId = setTimeout(() => {
            video.removeEventListener('seeked', onSeeked);
            video.removeEventListener('error', onError);
            console.warn(`[seekTo] Seek timed out at time ${time}s`);
            resolve();
        }, 1500);

        video.addEventListener('seeked', onSeeked);
        video.addEventListener('error', onError);
        video.currentTime = time;
    });
}

export async function generateSpritesheet(params: SpritesheetParams): Promise<HTMLCanvasElement> {
    const { file, trimStart, fps, grid, frameW, frameH, onProgress } = params;
    const fitMode: FitMode = params.fitMode ?? 'stretch';

    const totalFrames = grid.cols * grid.rows;

    const video = document.createElement('video');
    video.preload = 'auto';
    video.muted = true;

    // Append offscreen to prevent WebView2 from suspending the video decoder.
    video.style.position = 'fixed';
    video.style.top = '-9999px';
    video.style.left = '-9999px';
    video.style.width = '100px';
    video.style.height = '100px';
    video.style.visibility = 'hidden';
    video.style.pointerEvents = 'none';
    document.body.appendChild(video);

    const url = URL.createObjectURL(file);

    try {
        await new Promise<void>((resolve, reject) => {
            video.oncanplaythrough = () => resolve();
            video.onerror = () => reject(new Error('Failed to load video for frame extraction'));
            video.src = url;
        });

        const sheetCanvas = document.createElement('canvas');
        sheetCanvas.width = grid.sheetWidth;
        sheetCanvas.height = grid.sheetHeight;
        const sheetCtx = sheetCanvas.getContext('2d')!;

        for (let i = 0; i < totalFrames; i++) {
            const time = trimStart + i / fps;

            // Clamp to video duration to avoid seek errors.
            const clampedTime = Math.min(time, video.duration - 0.001);
            await seekTo(video, clampedTime);

            const col = i % grid.cols;
            const row = Math.floor(i / grid.cols);
            const x = col * frameW;
            const y = row * frameH;

            const rect = computeDrawRect(video.videoWidth, video.videoHeight, frameW, frameH, fitMode);
            // Clip to the cell so `cover` overflow never bleeds into neighbours.
            sheetCtx.save();
            sheetCtx.beginPath();
            sheetCtx.rect(x, y, frameW, frameH);
            sheetCtx.clip();
            sheetCtx.drawImage(video, x + rect.dx, y + rect.dy, rect.dw, rect.dh);
            sheetCtx.restore();

            onProgress?.(i + 1, totalFrames);
        }

        return sheetCanvas;
    } finally {
        URL.revokeObjectURL(url);
        video.remove();
    }
}
