import { describe, it, expect } from 'vitest';
import { descendantsOf, setSubtree, setAll, invertAll } from './maskOps';
import type { JointWeight } from './api/animask';

// Root(0) ─ Spine(1) ─ Arm(2)
//                    └ Head(3)
const tree: JointWeight[] = [
    { index: 0, name: 'Root', parentIndex: null, weight: 1 },
    { index: 1, name: 'Spine', parentIndex: 0, weight: 1 },
    { index: 2, name: 'Arm', parentIndex: 1, weight: 1 },
    { index: 3, name: 'Head', parentIndex: 1, weight: 1 },
];

describe('maskOps', () => {
    it('collects a joint and all its descendants', () => {
        expect(descendantsOf(tree, 1).sort()).toEqual([1, 2, 3]);
    });

    it('a leaf is its own only descendant', () => {
        expect(descendantsOf(tree, 2)).toEqual([2]);
    });

    it('setSubtree touches only the subtree', () => {
        const out = setSubtree(tree, 1, 0);
        expect(out.map((j) => j.weight)).toEqual([1, 0, 0, 0]);
    });

    it('setAll sets every weight', () => {
        expect(setAll(tree, 0.5).every((j) => j.weight === 0.5)).toBe(true);
    });

    it('invertAll maps w to 1-w', () => {
        const out = invertAll(setAll(tree, 0.25));
        expect(out.every((j) => j.weight === 0.75)).toBe(true);
    });

    it('does not mutate the input array or its joint objects', () => {
        const original = tree.map((j) => ({ ...j }));
        setSubtree(tree, 1, 0);
        setAll(tree, 0.5);
        invertAll(tree);
        descendantsOf(tree, 1);
        expect(tree).toEqual(original);
    });

    it('returns a new array, not the same reference', () => {
        expect(setAll(tree, 0.5)).not.toBe(tree);
        expect(invertAll(tree)).not.toBe(tree);
        expect(setSubtree(tree, 1, 0)).not.toBe(tree);
    });

    // A mutual cycle where BOTH joints' parentIndex point at each other, with
    // no root (no null parentIndex) to fall out to. A top-down walk from
    // joint 0 (down through whichever joints claim it as parent) bounces
    // 0 -> 1 -> 0 -> 1 -> ... forever unless it remembers what it has already
    // visited — a corrupt BIN must not lock the UI.
    it('a cycle in parentIndex terminates instead of hanging', () => {
        const cyclic: JointWeight[] = [
            { index: 0, name: 'A', parentIndex: 1, weight: 1 },
            { index: 1, name: 'B', parentIndex: 0, weight: 1 },
        ];
        expect(() => descendantsOf(cyclic, 0)).not.toThrow();
        expect(descendantsOf(cyclic, 0).sort()).toEqual([0, 1]);
    });

    // A second, independent cycle (2 <-> 3) that is NOT reachable from the
    // queried joint 0 at all — 0 has no children pointing into that loop.
    // A correct implementation ignores it entirely and returns just [0]. A
    // broken implementation that (incorrectly) inspects every joint's full
    // ancestor chain to decide subtree membership, instead of only walking
    // down from the queried joint, would spin forever on 2 and 3 chasing
    // each other's parentIndex without ever reaching 0 or a null parent.
    it('a cycle disjoint from the queried joint does not hang either', () => {
        const disjointCycle: JointWeight[] = [
            { index: 0, name: 'Root', parentIndex: null, weight: 1 },
            { index: 2, name: 'C', parentIndex: 3, weight: 1 },
            { index: 3, name: 'D', parentIndex: 2, weight: 1 },
        ];
        expect(() => descendantsOf(disjointCycle, 0)).not.toThrow();
        expect(descendantsOf(disjointCycle, 0)).toEqual([0]);
    });
});
