import { describe, it, expect } from 'vitest';
import { parseCombo, comboFromEvent, formatCombo } from './combo';

/** Minimal structural stand-in for KeyboardEvent — vitest runs in `node`, so the
 *  DOM type is unavailable and the resolver must not depend on it. */
function ev(over: Partial<{
    key: string; code: string;
    ctrlKey: boolean; metaKey: boolean; shiftKey: boolean; altKey: boolean;
}>) {
    return {
        key: '', code: '',
        ctrlKey: false, metaKey: false, shiftKey: false, altKey: false,
        ...over,
    };
}

describe('parseCombo', () => {
    it('is independent of authored modifier order', () => {
        expect(parseCombo('shift+ctrl+f')).toBe(parseCombo('ctrl+shift+f'));
    });

    it('canonicalises all three modifiers regardless of order', () => {
        expect(parseCombo('shift+alt+ctrl+f')).toBe(parseCombo('ctrl+alt+shift+f'));
    });

    it('is case-insensitive', () => {
        expect(parseCombo('Ctrl+Shift+F')).toBe(parseCombo('ctrl+shift+f'));
    });

    it('maps a bare digit to its physical digit token', () => {
        expect(parseCombo('ctrl+1')).toBe('ctrl+digit1');
    });

    it('keeps punctuation as a literal key', () => {
        expect(parseCombo('ctrl+,')).toBe('ctrl+,');
    });

    it('distinguishes function key f1 from the letter f', () => {
        expect(parseCombo('f1')).not.toBe(parseCombo('f'));
    });

    it('rejects a combo with no key', () => {
        expect(() => parseCombo('ctrl+shift')).toThrow();
    });

    it('rejects an unknown modifier-only input', () => {
        expect(() => parseCombo('')).toThrow();
    });
});

describe('comboFromEvent', () => {
    it('reads Ctrl+Shift+1 as a digit, not as "!"', () => {
        // This is defect 4: e.key is '!' when Shift is held, so keying off e.key
        // makes Ctrl+Shift+<digit> permanently unreachable.
        const combo = comboFromEvent(ev({
            key: '!', code: 'Digit1', ctrlKey: true, shiftKey: true,
        }));
        expect(combo).toBe(parseCombo('ctrl+shift+1'));
    });

    it('reads letters from e.key so alternate layouts work', () => {
        // Dvorak: the key labelled F reports code 'KeyU'. e.key is the truth here.
        const combo = comboFromEvent(ev({ key: 'f', code: 'KeyU' }));
        expect(combo).toBe(parseCombo('f'));
    });

    it('treats metaKey as ctrl', () => {
        expect(comboFromEvent(ev({ key: 's', code: 'KeyS', metaKey: true })))
            .toBe(parseCombo('ctrl+s'));
    });

    it('preserves the existing Ctrl+, binding', () => {
        expect(comboFromEvent(ev({ key: ',', code: 'Comma', ctrlKey: true })))
            .toBe(parseCombo('ctrl+,'));
    });

    it('reads named keys from e.key', () => {
        expect(comboFromEvent(ev({ key: 'Escape', code: 'Escape' })))
            .toBe(parseCombo('escape'));
        expect(comboFromEvent(ev({ key: 'ArrowDown', code: 'ArrowDown' })))
            .toBe(parseCombo('arrowdown'));
    });

    it('reads Shift+ArrowDown as a distinct combo from ArrowDown', () => {
        const plain = comboFromEvent(ev({ key: 'ArrowDown', code: 'ArrowDown' }));
        const shifted = comboFromEvent(ev({ key: 'ArrowDown', code: 'ArrowDown', shiftKey: true }));
        expect(shifted).not.toBe(plain);
        expect(shifted).toBe(parseCombo('shift+arrowdown'));
    });

    it('ignores bare modifier keydowns', () => {
        expect(comboFromEvent(ev({ key: 'Control', code: 'ControlLeft', ctrlKey: true })))
            .toBeNull();
        expect(comboFromEvent(ev({ key: 'Shift', code: 'ShiftLeft', shiftKey: true })))
            .toBeNull();
    });

    it('returns null for an event with no key', () => {
        expect(comboFromEvent(ev({}))).toBeNull();
    });
});

describe('formatCombo', () => {
    it('renders modifiers and a digit for display', () => {
        expect(formatCombo(parseCombo('ctrl+shift+1'))).toBe('Ctrl+Shift+1');
    });

    it('renders named keys in title case', () => {
        expect(formatCombo(parseCombo('escape'))).toBe('Esc');
        expect(formatCombo(parseCombo('arrowdown'))).toBe('↓');
    });

    it('renders a letter uppercased', () => {
        expect(formatCombo(parseCombo('ctrl+s'))).toBe('Ctrl+S');
    });

    it('renders punctuation literally', () => {
        expect(formatCombo(parseCombo('ctrl+,'))).toBe('Ctrl+,');
    });
});
