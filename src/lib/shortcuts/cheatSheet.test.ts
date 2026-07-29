import { describe, it, expect } from 'vitest';
import { buildCheatSheet } from './cheatSheet';
import { SHORTCUTS } from './manifest';
import type { Shortcut } from './types';

const fixture: Shortcut[] = [
    { id: 'a.one', keys: 'ctrl+n', label: 'New', group: 'General', scope: 'global' },
    { id: 'b.one', keys: 'ctrl+tab', label: 'Next tab', group: 'Tabs', scope: 'global' },
    { id: 'a.two', keys: 'ctrl+s', label: 'Save', group: 'General', scope: 'global' },
    { id: 'c.one', keys: 'arrowdown', label: 'Move down', group: 'File tree', scope: 'file-tree' },
    { id: 'b.two', keys: 'ctrl+1', label: 'Tab 1', group: 'Tabs', scope: 'global' },
];

describe('buildCheatSheet', () => {
    it('returns nothing for an empty manifest', () => {
        expect(buildCheatSheet([])).toEqual([]);
    });

    it('orders groups by first appearance in the manifest', () => {
        // Manifest order is editorial, so the sheet should read in that order
        // rather than alphabetically.
        expect(buildCheatSheet(fixture).map((g) => g.group))
            .toEqual(['General', 'Tabs', 'File tree']);
    });

    it('keeps manifest order within a group, gathering entries declared apart', () => {
        const general = buildCheatSheet(fixture).find((g) => g.group === 'General');
        expect(general?.rows.map((r) => r.label)).toEqual(['New', 'Save']);
    });

    it('formats combos for display rather than exposing raw tokens', () => {
        const tabs = buildCheatSheet(fixture).find((g) => g.group === 'Tabs');
        expect(tabs?.rows.map((r) => r.keys)).toEqual(['Ctrl+Tab', 'Ctrl+1']);
    });

    it('carries scope through so the UI can say when a shortcut applies', () => {
        const tree = buildCheatSheet(fixture).find((g) => g.group === 'File tree');
        expect(tree?.rows[0].scope).toBe('file-tree');
        expect(tree?.rows[0].keys).toBe('↓');
    });
});

describe('buildCheatSheet — over the real manifest', () => {
    const sheet = buildCheatSheet(SHORTCUTS);

    it('produces at least one group', () => {
        expect(sheet.length).toBeGreaterThan(0);
    });

    it('lists every manifest entry exactly once', () => {
        const rowCount = sheet.reduce((n, g) => n + g.rows.length, 0);
        expect(rowCount).toBe(SHORTCUTS.length);
    });

    it('never renders an empty key string', () => {
        const blank = sheet.flatMap((g) => g.rows).filter((r) => !r.keys.trim());
        expect(blank).toEqual([]);
    });
});
