/**
 * Shared helpers for decoding/encoding audio across BnkPreview and
 * AudioCutterModal. Browser-only (uses Web Audio API).
 */

import * as api from '../../lib/api';
import { applyFade } from '../../lib/audioDsp';

/** Encode an AudioBuffer as a 16-bit PCM WAV file (RIFF container). */
export function audioBufferToWav(buf: AudioBuffer): Uint8Array {
    const numChannels = buf.numberOfChannels;
    const sampleRate = buf.sampleRate;
    const numFrames = buf.length;
    const bytesPerSample = 2;
    const dataSize = numFrames * numChannels * bytesPerSample;
    const out = new ArrayBuffer(44 + dataSize);
    const view = new DataView(out);

    const writeStr = (off: number, s: string) => {
        for (let i = 0; i < s.length; i++) view.setUint8(off + i, s.charCodeAt(i));
    };
    writeStr(0, 'RIFF');
    view.setUint32(4, 36 + dataSize, true);
    writeStr(8, 'WAVE');
    writeStr(12, 'fmt ');
    view.setUint32(16, 16, true);
    view.setUint16(20, 1, true);
    view.setUint16(22, numChannels, true);
    view.setUint32(24, sampleRate, true);
    view.setUint32(28, sampleRate * numChannels * bytesPerSample, true);
    view.setUint16(32, numChannels * bytesPerSample, true);
    view.setUint16(34, 16, true);
    writeStr(36, 'data');
    view.setUint32(40, dataSize, true);

    const channels: Float32Array[] = [];
    for (let c = 0; c < numChannels; c++) channels.push(buf.getChannelData(c));
    let offset = 44;
    for (let i = 0; i < numFrames; i++) {
        for (let c = 0; c < numChannels; c++) {
            let s = channels[c][i];
            if (s > 1) s = 1;
            else if (s < -1) s = -1;
            view.setInt16(offset, s < 0 ? s * 0x8000 : s * 0x7FFF, true);
            offset += 2;
        }
    }
    return new Uint8Array(out);
}

/** Decode WEM bytes to an AudioBuffer. */
export async function decodeWemToBuffer(wemBytes: Uint8Array): Promise<AudioBuffer> {
    const decoded = await api.decodeWem(wemBytes);
    const audioBytes = new Uint8Array(decoded.data);
    const ctx = new AudioContext();
    try {
        return await ctx.decodeAudioData(audioBytes.slice().buffer);
    } finally {
        await ctx.close().catch(() => {});
    }
}

/**
 * Decode a user-supplied audio file — MP3, OGG, FLAC, M4A, WAV — to samples.
 *
 * The webview is Chromium, so its decoder already covers every format someone
 * is likely to drop in. That is what lets the app meet the ritoshark crate at
 * PCM without carrying a stack of decoders of its own.
 */
export async function decodeAudioFile(bytes: Uint8Array): Promise<AudioBuffer> {
    const ctx = new AudioContext();
    try {
        return await ctx.decodeAudioData(bytes.slice().buffer);
    } catch {
        throw new Error(
            'Could not decode this file. Supported: WAV, MP3, OGG, FLAC, M4A and .wem.',
        );
    } finally {
        await ctx.close().catch(() => {});
    }
}

/** Render a buffer at a different sample rate. Returns it unchanged if it already matches. */
export async function resampleBuffer(buf: AudioBuffer, targetRate: number): Promise<AudioBuffer> {
    if (targetRate === buf.sampleRate) return buf;

    const frames = Math.max(1, Math.ceil(buf.duration * targetRate));
    const offline = new OfflineAudioContext(buf.numberOfChannels, frames, targetRate);
    const source = offline.createBufferSource();
    source.buffer = buf;
    source.connect(offline.destination);
    source.start();
    return offline.startRendering();
}

/** Copy a buffer with linear fades applied to both ends. */
export function fadeAudioBuffer(
    buf: AudioBuffer,
    fadeInSec: number,
    fadeOutSec: number,
): AudioBuffer {
    if (fadeInSec <= 0 && fadeOutSec <= 0) return buf;

    const ctx = new AudioContext();
    try {
        const out = ctx.createBuffer(buf.numberOfChannels, buf.length, buf.sampleRate);
        const channels: Float32Array[] = [];
        for (let c = 0; c < buf.numberOfChannels; c++) {
            // getChannelData hands back the live array, so fading it in place
            // writes straight into the new buffer.
            const data = out.getChannelData(c);
            data.set(buf.getChannelData(c));
            channels.push(data);
        }
        applyFade(channels, buf.sampleRate, fadeInSec, fadeOutSec);
        return out;
    } finally {
        void ctx.close().catch(() => {});
    }
}

/** Slice an AudioBuffer between two times (seconds) into a fresh buffer. */
export function sliceAudioBuffer(buf: AudioBuffer, startSec: number, endSec: number): AudioBuffer {
    const ctx = new AudioContext();
    const startFrame = Math.max(0, Math.floor(startSec * buf.sampleRate));
    const endFrame = Math.min(buf.length, Math.floor(endSec * buf.sampleRate));
    const length = Math.max(1, endFrame - startFrame);
    const out = ctx.createBuffer(buf.numberOfChannels, length, buf.sampleRate);
    for (let c = 0; c < buf.numberOfChannels; c++) {
        const src = buf.getChannelData(c).subarray(startFrame, endFrame);
        out.copyToChannel(src, c);
    }
    void ctx.close().catch(() => {});
    return out;
}

/** Apply a dB gain to a WEM and return PCM WAV bytes ready for replacement. */
export async function applyGainToWem(wemBytes: Uint8Array, gainDb: number): Promise<Uint8Array> {
    const audioBuf = await decodeWemToBuffer(wemBytes);
    const factor = Math.pow(10, gainDb / 20);
    const ctx = new AudioContext();
    try {
        const out = ctx.createBuffer(audioBuf.numberOfChannels, audioBuf.length, audioBuf.sampleRate);
        for (let c = 0; c < audioBuf.numberOfChannels; c++) {
            const src = audioBuf.getChannelData(c);
            const dst = out.getChannelData(c);
            for (let i = 0; i < src.length; i++) {
                const s = src[i] * factor;
                dst[i] = s > 1 ? 1 : s < -1 ? -1 : s;
            }
        }
        return audioBufferToWav(out);
    } finally {
        await ctx.close().catch(() => {});
    }
}

/** Format seconds as MM:SS.mmm (useful for cutter UI). */
export function formatTime(seconds: number): string {
    if (!isFinite(seconds) || seconds < 0) return '0:00.000';
    const m = Math.floor(seconds / 60);
    const s = seconds - m * 60;
    return `${m}:${s.toFixed(3).padStart(6, '0')}`;
}

/**
 * Compute a min/max summary of an AudioBuffer at the given pixel resolution.
 * Returns two Float32Arrays (min, max) — sampled as a mono mixdown.
 */
export function computeWaveformPeaks(buf: AudioBuffer, pixels: number): { min: Float32Array; max: Float32Array } {
    const min = new Float32Array(pixels);
    const max = new Float32Array(pixels);
    const ch0 = buf.getChannelData(0);
    const ch1 = buf.numberOfChannels > 1 ? buf.getChannelData(1) : null;
    const samplesPerPixel = Math.max(1, buf.length / pixels);
    for (let x = 0; x < pixels; x++) {
        const from = Math.floor(x * samplesPerPixel);
        const to = Math.min(buf.length, Math.floor((x + 1) * samplesPerPixel));
        let mn = 1;
        let mx = -1;
        for (let i = from; i < to; i++) {
            const v = ch1 ? (ch0[i] + ch1[i]) * 0.5 : ch0[i];
            if (v < mn) mn = v;
            if (v > mx) mx = v;
        }
        min[x] = mn;
        max[x] = mx;
    }
    return { min, max };
}
