import { describe, it, expect } from 'vitest';
import { SHORTCUTS } from './manifest';
import { parseCombo } from './combo';

/**
 * These are the guard rails. Defects 3 and 4 of the old engine (order-dependent
 * combos, unreachable Ctrl+Shift+digit) were silent no-ops discoverable only by
 * launching the app and pressing the key. Here they are CI failures.
 */
describe('manifest invariants', () => {
    it('has no duplicate action ids', () => {
        const seen = new Map<string, number>();
        for (const s of SHORTCUTS) seen.set(s.id, (seen.get(s.id) ?? 0) + 1);
        const dupes = [...seen.entries()].filter(([, n]) => n > 1).map(([id]) => id);
        expect(dupes).toEqual([]);
    });

    it('declares only parseable combos', () => {
        const broken: string[] = [];
        for (const s of SHORTCUTS) {
            try {
                parseCombo(s.keys);
            } catch {
                broken.push(`${s.id}: "${s.keys}"`);
            }
        }
        expect(broken).toEqual([]);
    });

    it('has no two shortcuts bound to the same combo within one scope', () => {
        // Same combo in DIFFERENT scopes is the whole point and must stay legal.
        const bySlot = new Map<string, string[]>();
        for (const s of SHORTCUTS) {
            const slot = `${s.scope}::${parseCombo(s.keys)}`;
            bySlot.set(slot, [...(bySlot.get(slot) ?? []), s.id]);
        }
        const collisions = [...bySlot.entries()]
            .filter(([, ids]) => ids.length > 1)
            .map(([slot, ids]) => `${slot} → ${ids.join(', ')}`);
        expect(collisions).toEqual([]);
    });

    it('gives every shortcut a non-empty label and group for the cheat sheet', () => {
        const bad = SHORTCUTS
            .filter((s) => !s.label.trim() || !s.group.trim())
            .map((s) => s.id);
        expect(bad).toEqual([]);
    });

    it('authors combos in canonical order so the manifest reads as it resolves', () => {
        // Not required for correctness (parseCombo sorts), but keeps the source
        // honest — an author reading 'shift+ctrl+f' would misjudge the binding.
        const nonCanonical = SHORTCUTS
            .filter((s) => s.keys !== parseCombo(s.keys).replace(/digit(\d)/, '$1'))
            .map((s) => `${s.id}: "${s.keys}"`);
        expect(nonCanonical).toEqual([]);
    });
});

describe('manifest — preserves the pre-existing App.tsx bindings', () => {
    // Phase 1 must not change behaviour. These six were registered directly in
    // App.tsx:137-172 before the migration.
    const expected: Array<[string, string]> = [
        ['ctrl+n', 'New project'],
        ['ctrl+s', 'Save'],
        ['ctrl+,', 'Settings'],
        ['ctrl+e', 'Export'],
        ['ctrl+w', 'Close'],
        ['escape', 'Close modal'],
    ];

    for (const [keys] of expected) {
        it(`still binds ${keys}`, () => {
            const combo = parseCombo(keys);
            const match = SHORTCUTS.find((s) => parseCombo(s.keys) === combo);
            expect(match, `no shortcut bound to ${keys}`).toBeDefined();
        });
    }

    it('keeps Ctrl+S working while typing, for the Monaco bin editor', () => {
        const save = SHORTCUTS.find((s) => parseCombo(s.keys) === parseCombo('ctrl+s'));
        expect(save?.allowInTextEntry).toBe(true);
    });

    it('keeps Escape working while typing and while a modal is open', () => {
        // Escape is legitimately bound in more than one scope, so select the
        // modal-scoped one by intent rather than by declaration order.
        const esc = SHORTCUTS.find(
            (s) => parseCombo(s.keys) === parseCombo('escape') && s.scope === 'modal',
        );
        expect(esc, 'no modal-scoped Escape binding').toBeDefined();
        expect(esc?.allowInTextEntry).toBe(true);
    });
});
