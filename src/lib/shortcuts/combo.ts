/**
 * Combo parsing and normalisation.
 *
 * A `Combo` is a canonical string: modifiers in fixed `ctrl+alt+shift` order
 * followed by one key token. Both the manifest (authored strings) and live
 * keyboard events funnel through here, so a binding can only ever be reachable
 * or unreachable in both — never one and not the other.
 */

export type Combo = string;

/** Structural stand-in for KeyboardEvent, so the parser stays DOM-free. */
export interface KeyEventLike {
    key: string;
    code: string;
    ctrlKey: boolean;
    metaKey: boolean;
    shiftKey: boolean;
    altKey: boolean;
}

/** Canonical modifier order. Authored order is discarded. */
const MODIFIER_ORDER = ['ctrl', 'alt', 'shift'] as const;

const MODIFIER_ALIASES: Record<string, 'ctrl' | 'alt' | 'shift'> = {
    ctrl: 'ctrl', control: 'ctrl', cmd: 'ctrl', command: 'ctrl', meta: 'ctrl',
    alt: 'alt', option: 'alt',
    shift: 'shift',
};

/** Keydowns for a modifier key alone are never a shortcut. */
const BARE_MODIFIER_KEYS = new Set(['control', 'shift', 'alt', 'meta', 'os', 'altgraph']);

/** Display forms for keys whose lowercase token reads badly in a cheat sheet. */
const DISPLAY_NAMES: Record<string, string> = {
    escape: 'Esc',
    arrowup: '↑', arrowdown: '↓', arrowleft: '←', arrowright: '→',
    delete: 'Del', backspace: 'Backspace',
    enter: 'Enter', tab: 'Tab', home: 'Home', end: 'End',
    pageup: 'PgUp', pagedown: 'PgDn', ' ': 'Space',
};

function joinCombo(mods: Set<string>, keyToken: string): Combo {
    const ordered = MODIFIER_ORDER.filter((m) => mods.has(m));
    return [...ordered, keyToken].join('+');
}

/**
 * Digits are stored as their physical `Digit<n>` token rather than the character,
 * because `e.key` for `1` is `!` when Shift is held — which would make every
 * `Ctrl+Shift+<digit>` binding permanently unreachable.
 */
function normalizeAuthoredKey(token: string): string {
    return /^[0-9]$/.test(token) ? `digit${token}` : token;
}

/** Parse an authored combo string (any modifier order, any case). */
export function parseCombo(input: string): Combo {
    const parts = input
        .split('+')
        .map((s) => s.trim().toLowerCase())
        .filter((s) => s.length > 0);

    const mods = new Set<string>();
    const keys: string[] = [];

    for (const part of parts) {
        const mod = MODIFIER_ALIASES[part];
        if (mod) mods.add(mod);
        else keys.push(part);
    }

    if (keys.length !== 1) {
        throw new Error(
            `Invalid shortcut combo "${input}": expected exactly one non-modifier key, got ${keys.length}`,
        );
    }

    return joinCombo(mods, normalizeAuthoredKey(keys[0]));
}

/** Derive the canonical combo for a live keyboard event, or null if it isn't one. */
export function comboFromEvent(e: KeyEventLike): Combo | null {
    if (!e.key) return null;

    const keyLower = e.key.toLowerCase();
    if (BARE_MODIFIER_KEYS.has(keyLower)) return null;

    // Letters and named keys come from e.key so alternate keyboard layouts work
    // (e.code reports US-QWERTY physical position). Digits are the one exception,
    // where e.key is the broken source — see normalizeAuthoredKey.
    const digit = /^Digit([0-9])$/.exec(e.code);
    const keyToken = digit ? `digit${digit[1]}` : keyLower;

    const mods = new Set<string>();
    if (e.ctrlKey || e.metaKey) mods.add('ctrl');
    if (e.altKey) mods.add('alt');
    if (e.shiftKey) mods.add('shift');

    return joinCombo(mods, keyToken);
}

/** Render a combo for display in the cheat sheet and tooltips. */
export function formatCombo(combo: Combo): string {
    const parts = combo.split('+');
    // Trailing empty segment means the key token itself was '+'.
    const keyToken = parts.pop() ?? '';
    const mods = parts;

    const label = (() => {
        const digit = /^digit([0-9])$/.exec(keyToken);
        if (digit) return digit[1];
        if (DISPLAY_NAMES[keyToken]) return DISPLAY_NAMES[keyToken];
        if (/^f([1-9]|1[0-2])$/.test(keyToken)) return keyToken.toUpperCase();
        if (keyToken.length === 1) return keyToken.toUpperCase();
        return keyToken.charAt(0).toUpperCase() + keyToken.slice(1);
    })();

    const modLabels = mods.map((m) => m.charAt(0).toUpperCase() + m.slice(1));
    return [...modLabels, label].join('+');
}
