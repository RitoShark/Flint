import { describe, it, expect } from 'vitest';
import { planTypeFix, tokenId } from './binTypeFix';

const STRING_TO_FILE = { field: 'texture', from: 'string', to: 'file' };

describe('tokenId', () => {
    it('reads a hex token as the id it spells', () => {
        expect(tokenId('0x115b5460')).toBe(0x115b5460);
        expect(tokenId('"0x0000000a"')).toBe(10);
    });

    it('hashes a name the way the format does, ignoring case', () => {
        expect(tokenId('texture')).toBe(tokenId('TEXTURE'));
        expect(tokenId('mAnimationFilePath')).not.toBe(tokenId('texture'));
    });
});

describe('planTypeFix', () => {
    it('replaces only the type token and leaves the value alone', () => {
        const plan = planTypeFix(
            [{ line: 5, content: '                texture: string = "assets/a.tex"' }],
            STRING_TO_FILE,
        );
        expect(plan.stale).toEqual([]);
        expect(plan.edits).toEqual([{ line: 5, startColumn: 26, endColumn: 32, text: 'file' }]);

        const before = '                texture: string = "assets/a.tex"';
        const edit = plan.edits[0];
        const after =
            before.slice(0, edit.startColumn - 1) + edit.text + before.slice(edit.endColumn - 1);
        expect(after).toBe('                texture: file = "assets/a.tex"');
    });

    it('handles every flagged line in one plan', () => {
        const plan = planTypeFix(
            [
                { line: 5, content: '    texture: string = "assets/a.tex"' },
                { line: 8, content: '    texture: string = "assets/b.tex"' },
            ],
            STRING_TO_FILE,
        );
        expect(plan.edits.map(e => e.line)).toEqual([5, 8]);
        expect(plan.stale).toEqual([]);
    });

    it('takes a declaration with no spaces around the type', () => {
        const plan = planTypeFix([{ line: 2, content: 'texture:string="assets/a.tex"' }], STRING_TO_FILE);
        expect(plan.edits).toEqual([{ line: 2, startColumn: 9, endColumn: 15, text: 'file' }]);
    });

    it('matches a hashed field name against a named fix', () => {
        const plan = planTypeFix(
            [{ line: 3, content: '    0x2c0e9a68: string = "assets/a.tex"' }],
            { field: '0x2c0e9a68', from: 'string', to: 'file' },
        );
        expect(plan.edits.map(e => e.line)).toEqual([3]);
    });

    it('leaves a line whose type is already corrected', () => {
        const plan = planTypeFix(
            [{ line: 5, content: '    texture: file = "assets/a.tex"' }],
            STRING_TO_FILE,
        );
        expect(plan).toEqual({ edits: [], stale: [5] });
    });

    it('leaves a line that now declares a different field', () => {
        const plan = planTypeFix(
            [{ line: 5, content: '    glossTexture: string = "assets/a.tex"' }],
            STRING_TO_FILE,
        );
        expect(plan).toEqual({ edits: [], stale: [5] });
    });

    it('leaves a line that is no longer a declaration', () => {
        const plan = planTypeFix(
            [
                { line: 5, content: '    }' },
                { line: 6, content: '' },
                { line: 7, content: '    "assets/a.tex"' },
            ],
            STRING_TO_FILE,
        );
        expect(plan.edits).toEqual([]);
        expect(plan.stale).toEqual([5, 6, 7]);
    });

    it('reports a partly stale set without giving up the lines that still match', () => {
        const plan = planTypeFix(
            [
                { line: 5, content: '    texture: string = "assets/a.tex"' },
                { line: 8, content: '    texture: file = "assets/b.tex"' },
            ],
            STRING_TO_FILE,
        );
        expect(plan.edits.map(e => e.line)).toEqual([5]);
        expect(plan.stale).toEqual([8]);
    });

    it('replaces a container type as one token', () => {
        const plan = planTypeFix(
            [{ line: 4, content: '    mPaths: list[string] = {' }],
            { field: 'mPaths', from: 'list[string]', to: 'list[file]' },
        );
        const before = '    mPaths: list[string] = {';
        const edit = plan.edits[0];
        expect(
            before.slice(0, edit.startColumn - 1) + edit.text + before.slice(edit.endColumn - 1),
        ).toBe('    mPaths: list[file] = {');
    });
});
