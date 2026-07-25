import { describe, it, expect } from 'vitest';
import { resolve } from './resolve';
import { parseCombo } from './combo';
import type { Shortcut } from './types';

/** Small fixture manifest. Scope stacks are ordered bottom → top. */
const FIXTURE: Shortcut[] = [
    { id: 'app.new', keys: 'ctrl+n', label: 'New project', group: 'App', scope: 'global' },
    { id: 'app.save', keys: 'ctrl+s', label: 'Save', group: 'App', scope: 'global', allowInTextEntry: true },
    { id: 'modal.close', keys: 'escape', label: 'Close', group: 'App', scope: 'modal', allowInTextEntry: true },
    { id: 'close.generic', keys: 'ctrl+w', label: 'Close current', group: 'App', scope: 'global' },
    { id: 'close.wad', keys: 'ctrl+w', label: 'Close WAD Explorer', group: 'WAD', scope: 'wad-explorer' },
    { id: 'tree.down', keys: 'arrowdown', label: 'Move down', group: 'Tree', scope: 'file-tree' },
    { id: 'help.cheatsheet', keys: 'f1', label: 'Shortcuts', group: 'App', scope: 'global', survivesModal: true },
];

const ctx = (over: Partial<{ scopeStack: string[]; inTextEntry: boolean }> = {}) => ({
    scopeStack: ['global'],
    inTextEntry: false,
    ...over,
}) as Parameters<typeof resolve>[2];

describe('resolve', () => {
    it('resolves a global shortcut when only global is active', () => {
        expect(resolve(parseCombo('ctrl+n'), FIXTURE, ctx())).toBe('app.new');
    });

    it('returns null for an unbound combo', () => {
        expect(resolve(parseCombo('ctrl+j'), FIXTURE, ctx())).toBeNull();
    });

    it('returns null when the shortcut scope is not on the stack', () => {
        expect(resolve(parseCombo('arrowdown'), FIXTURE, ctx())).toBeNull();
    });

    it('resolves a focus-scoped shortcut when its scope is pushed', () => {
        expect(resolve(parseCombo('arrowdown'), FIXTURE, ctx({
            scopeStack: ['global', 'preview', 'file-tree'],
        }))).toBe('tree.down');
    });
});

describe('resolve — scope precedence', () => {
    it('prefers the topmost scope when two scopes bind the same combo', () => {
        expect(resolve(parseCombo('ctrl+w'), FIXTURE, ctx({
            scopeStack: ['global', 'wad-explorer'],
        }))).toBe('close.wad');
    });

    it('falls back to global when the specific scope is absent', () => {
        expect(resolve(parseCombo('ctrl+w'), FIXTURE, ctx({
            scopeStack: ['global', 'preview', 'file-tree'],
        }))).toBe('close.generic');
    });
});

describe('resolve — modal masking', () => {
    it('masks a plain global shortcut while a modal is open', () => {
        // Today Ctrl+N with the New Project modal open tries to open a second one.
        expect(resolve(parseCombo('ctrl+n'), FIXTURE, ctx({
            scopeStack: ['global', 'preview', 'modal'],
        }))).toBeNull();
    });

    it('resolves modal-scoped shortcuts while a modal is open', () => {
        expect(resolve(parseCombo('escape'), FIXTURE, ctx({
            scopeStack: ['global', 'preview', 'modal'],
        }))).toBe('modal.close');
    });

    it('lets a survivesModal shortcut through while a modal is open', () => {
        expect(resolve(parseCombo('f1'), FIXTURE, ctx({
            scopeStack: ['global', 'modal'],
        }))).toBe('help.cheatsheet');
    });
});

describe('resolve — text-entry guard', () => {
    it('blocks shortcuts while typing by default', () => {
        expect(resolve(parseCombo('ctrl+n'), FIXTURE, ctx({ inTextEntry: true }))).toBeNull();
    });

    it('allows allowInTextEntry shortcuts while typing', () => {
        // Ctrl+S must work from inside the Monaco bin editor.
        expect(resolve(parseCombo('ctrl+s'), FIXTURE, ctx({ inTextEntry: true }))).toBe('app.save');
    });

    it('allows Escape from a focused field inside a modal', () => {
        // The most guarded position in the app: text entry + modal at once.
        expect(resolve(parseCombo('escape'), FIXTURE, ctx({
            scopeStack: ['global', 'modal'],
            inTextEntry: true,
        }))).toBe('modal.close');
    });

    it('blocks arrow navigation while typing in a rename field', () => {
        expect(resolve(parseCombo('arrowdown'), FIXTURE, ctx({
            scopeStack: ['global', 'preview', 'file-tree'],
            inTextEntry: true,
        }))).toBeNull();
    });
});
