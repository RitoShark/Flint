export class Rng {
    private readonly words: Uint32Array;
    constructor(seed: number) { this.words = Uint32Array.of((seed >>> 0) || 0x9e3779b9); }
    private advance(): number {
        this.words[0] ^= this.words[0] << 13;
        this.words[0] ^= this.words[0] >>> 17;
        this.words[0] ^= this.words[0] << 5;
        return this.words[0];
    }
    unitFloat(): number { return (this.advance() >>> 8) / 16777216; }
    range(min: number, max: number): number { return min + this.unitFloat() * (max - min); }
    clone(): Rng { return new Rng(this.words[0]); }
}
