import { describe, it, expect } from 'vitest';
import { applyFade, isWwiseWem } from './audioDsp';

function riff(codec: number, fmtSize = 16): Uint8Array {
    const body = 8;
    const out = new Uint8Array(12 + 8 + fmtSize + 8 + body);
    const view = new DataView(out.buffer);
    const put = (at: number, s: string) => {
        for (let i = 0; i < s.length; i++) out[at + i] = s.charCodeAt(i);
    };
    put(0, 'RIFF');
    view.setUint32(4, out.length - 8, true);
    put(8, 'WAVE');
    put(12, 'fmt ');
    view.setUint32(16, fmtSize, true);
    view.setUint16(20, codec, true);
    put(20 + fmtSize, 'data');
    view.setUint32(24 + fmtSize, body, true);
    return out;
}

describe('isWwiseWem', () => {
    it('accepts the two codecs Wwise declares', () => {
        expect(isWwiseWem(riff(0xffff))).toBe(true); // Wwise Vorbis
        expect(isWwiseWem(riff(0xfffe))).toBe(true); // Wwise PCM
    });

    it('rejects an ordinary WAV, which is also RIFF/WAVE', () => {
        expect(isWwiseWem(riff(1))).toBe(false); // PCM
        expect(isWwiseWem(riff(3))).toBe(false); // float
    });

    it('rejects anything that is not RIFF/WAVE at all', () => {
        expect(isWwiseWem(new Uint8Array([0x49, 0x44, 0x33, 0x04]))).toBe(false); // ID3/mp3
        expect(isWwiseWem(new Uint8Array([]))).toBe(false);
        expect(isWwiseWem(new Uint8Array([0x4f, 0x67, 0x67, 0x53]))).toBe(false); // OggS
    });

    it('does not walk past the end of a truncated file', () => {
        const truncated = riff(0xffff).subarray(0, 20);
        expect(isWwiseWem(truncated)).toBe(false);
    });
});

describe('applyFade', () => {
    const ones = (n: number) => Float32Array.from({ length: n }, () => 1);

    it('ramps in from silence and out to silence', () => {
        const ch = ones(100);
        applyFade([ch], 100, 0.1, 0.1); // 10 frames each

        expect(ch[0]).toBe(0);
        expect(ch[99]).toBe(0);
        expect(ch[5]).toBeCloseTo(0.5, 5);
        expect(ch[50]).toBe(1); // middle untouched
    });

    it('leaves the signal alone when both fades are zero', () => {
        const ch = ones(50);
        applyFade([ch], 100, 0, 0);
        expect(Array.from(ch).every((v) => v === 1)).toBe(true);
    });

    it('scales fades that would otherwise overlap', () => {
        const ch = ones(10);
        // 1s in + 1s out at 10 Hz is 20 frames of fade over 10 frames of audio.
        applyFade([ch], 10, 1, 1);

        expect(ch[0]).toBe(0);
        expect(ch[9]).toBe(0);
        // Nothing may be attenuated by both ramps, so nothing goes negative or
        // gets squared down to near-zero in the middle.
        expect(Math.max(...Array.from(ch))).toBeGreaterThan(0.5);
    });

    it('applies the same envelope to every channel', () => {
        const left = ones(20);
        const right = ones(20);
        applyFade([left, right], 20, 0.25, 0.25);
        expect(Array.from(left)).toEqual(Array.from(right));
    });

    it('handles an empty buffer without throwing', () => {
        expect(() => applyFade([new Float32Array(0)], 44100, 1, 1)).not.toThrow();
        expect(() => applyFade([], 44100, 1, 1)).not.toThrow();
    });
});

