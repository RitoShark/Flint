/**
 * Sample-level audio operations, kept pure so they can be tested without a
 * browser audio stack. The Web Audio glue lives in
 * components/preview/audioUtils.ts.
 *
 * The ritoshark audio crate deliberately stops at PCM samples — trimming,
 * fading and resampling are the application's side of that boundary.
 */

/** RIFF chunk walk. Returns the body of `tag`, or null if the file has none. */
function riffChunk(bytes: Uint8Array, tag: string): Uint8Array | null {
    if (bytes.length < 12) return null;
    const view = new DataView(bytes.buffer, bytes.byteOffset, bytes.byteLength);
    const str = (at: number) =>
        String.fromCharCode(bytes[at], bytes[at + 1], bytes[at + 2], bytes[at + 3]);

    if (str(0) !== 'RIFF' || str(8) !== 'WAVE') return null;

    let at = 12;
    while (at + 8 <= bytes.length) {
        const size = view.getUint32(at + 4, true);
        const start = at + 8;
        const end = start + size;
        if (end > bytes.length) return null;
        if (str(at) === tag) return bytes.subarray(start, end);
        // RIFF pads odd-length chunks to a two-byte boundary.
        at = end + (end & 1);
    }
    return null;
}

/**
 * True when the bytes are a Wwise `.wem` rather than an ordinary WAV.
 *
 * Both are RIFF/WAVE, so the container is not the tell — the codec id in `fmt `
 * is. Wwise uses 0xFFFF (its Vorbis) and 0xFFFE (its PCM); a normal WAV
 * declares 1 or 3. A real wem is embedded verbatim rather than re-encoded, so
 * getting this wrong would needlessly transcode a file that was already fine.
 */
export function isWwiseWem(bytes: Uint8Array): boolean {
    const fmt = riffChunk(bytes, 'fmt ');
    if (!fmt || fmt.length < 2) return false;
    const codec = fmt[0] | (fmt[1] << 8);
    return codec === 0xffff || codec === 0xfffe;
}

/**
 * Linear fade in and out, applied in place to each channel.
 *
 * Trimming mid-waveform leaves a discontinuity at both cuts, which is audible
 * as a click. Fades are how that is fixed, so they belong next to the trim.
 * Requests longer than the audio are scaled down proportionally rather than
 * overlapping, which would attenuate the middle twice.
 */
export function applyFade(
    channels: Float32Array[],
    sampleRate: number,
    fadeInSec: number,
    fadeOutSec: number,
): void {
    const frames = channels[0]?.length ?? 0;
    if (frames === 0 || sampleRate <= 0) return;

    let inFrames = Math.max(0, Math.round(fadeInSec * sampleRate));
    let outFrames = Math.max(0, Math.round(fadeOutSec * sampleRate));
    if (inFrames === 0 && outFrames === 0) return;

    const total = inFrames + outFrames;
    if (total > frames) {
        const scale = frames / total;
        inFrames = Math.floor(inFrames * scale);
        outFrames = Math.floor(outFrames * scale);
    }

    for (const data of channels) {
        for (let i = 0; i < inFrames; i++) {
            data[i] *= i / inFrames;
        }
        for (let i = 0; i < outFrames; i++) {
            data[frames - 1 - i] *= i / outFrames;
        }
    }
}

/**
 * Bytes a PCM `.wem` of this shape will occupy.
 *
 * Worth showing the user: the encoder writes PCM, which is several times larger
 * than the Vorbis the game ships, so a long stereo import at 48 kHz turns into a
 * surprisingly large bank.
 */
export function estimatePcmWemBytes(frames: number, channels: number): number {
    const header = 0x100;
    return header + frames * channels * 2;
}

export function formatBytes(n: number): string {
    if (n < 1024) return `${n} B`;
    if (n < 1024 * 1024) return `${(n / 1024).toFixed(1)} KB`;
    return `${(n / (1024 * 1024)).toFixed(2)} MB`;
}
