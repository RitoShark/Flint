import { describe, it, expect } from 'vitest';
import { colorizeRitobinLine } from './ritobinColorize';

type Token = { offset: number; type: string };

function fakeMonaco(tokens: Token[]) {
    return { editor: { tokenize: () => [tokens] } } as never;
}

const LINE = 'particleName: string = "Q_Mis"';

describe('colorizeRitobinLine', () => {
    it('slices the line at the token offsets, losing nothing', () => {
        const spans = colorizeRitobinLine(
            fakeMonaco([
                { offset: 0, type: 'variable.ritobin' },
                { offset: 12, type: 'delimiter.ritobin' },
                { offset: 14, type: 'type.ritobin' },
                { offset: 20, type: 'delimiter.ritobin' },
                { offset: 23, type: 'string.ritobin' },
            ]),
            LINE,
            'default',
        );
        expect(spans.map((s) => s.text).join('')).toBe(LINE);
        expect(spans[0].text).toBe('particleName');
        expect(spans[4].text).toBe('"Q_Mis"');
    });

    it('paints each token from the preset', () => {
        const [variable, , type, , str] = colorizeRitobinLine(
            fakeMonaco([
                { offset: 0, type: 'variable.ritobin' },
                { offset: 12, type: 'delimiter.ritobin' },
                { offset: 14, type: 'type.ritobin' },
                { offset: 20, type: 'delimiter.ritobin' },
                { offset: 23, type: 'string.ritobin' },
            ]),
            LINE,
            'default',
        );
        expect(variable.color).toBe('#dcdcaa');
        expect(type.color).toBe('#569cd6');
        expect(str.color).toBe('#ce9178');
    });

    it('prefers the longest matching scope', () => {
        const [span] = colorizeRitobinLine(
            fakeMonaco([{ offset: 0, type: 'type.identifier.ritobin' }]),
            'VfxSystemDefinitionData',
            'default',
        );
        expect(span.color).toBe('#4ec9b0');
    });

    it('falls back to the preset default for an unknown scope', () => {
        const [span] = colorizeRitobinLine(
            fakeMonaco([{ offset: 0, type: 'whatever.ritobin' }]),
            'abc',
            'default',
        );
        expect(span.color).toBe('#c0c0c0');
    });

    it('follows the chosen preset, not the default one', () => {
        const [span] = colorizeRitobinLine(
            fakeMonaco([{ offset: 0, type: 'string.ritobin' }]),
            '"x"',
            'ember',
        );
        expect(span.color).toBe('#d99a6c');
    });

    it('returns nothing for an empty preview', () => {
        expect(colorizeRitobinLine(fakeMonaco([]), '', 'default')).toEqual([]);
    });

    it('renders the whole line when the grammar is not registered', () => {
        const spans = colorizeRitobinLine(fakeMonaco([]), LINE, 'default');
        expect(spans).toHaveLength(1);
        expect(spans[0].text).toBe(LINE);
    });
});
