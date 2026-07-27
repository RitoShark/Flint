import React, { useEffect, useMemo, useState } from 'react';
import * as api from '../../lib/api';
import type { JointWeight, MaskDocument, MaskView } from '../../lib/api/animask';

interface MaskEditorProps {
    binPath: string;
    sklPath: string;
}

function formatMaskKey(key: number): string {
    return `0x${(key >>> 0).toString(16).padStart(8, '0')}`;
}

/** True when this mask's weights could not be paired to joint names —
 *  the backend withholds names for every row in a mask, all-or-nothing,
 *  whenever that mask's weight count disagrees with the skeleton's. */
function isMismatched(mask: MaskView): boolean {
    return mask.joints.some((j) => j.name === null);
}

/**
 * Depth of `joint` in the hierarchy, walked via `parentIndex`.
 *
 * Uses a visited set so a cyclic `parentIndex` in a corrupt file terminates
 * instead of hanging the UI — a cycle is detected the moment we'd revisit a
 * node, and we just stop climbing (rendering that joint unindented) rather
 * than looping forever.
 */
function jointDepth(index: number, byIndex: Map<number, JointWeight>): number {
    const visited = new Set<number>();
    let current: number | null = index;
    let depth = 0;
    while (current !== null) {
        if (visited.has(current)) break;
        visited.add(current);
        const parent: number | null = byIndex.get(current)?.parentIndex ?? null;
        if (parent === null || !byIndex.has(parent)) break;
        current = parent;
        depth++;
    }
    return depth;
}

export const MaskEditor: React.FC<MaskEditorProps> = ({ binPath, sklPath }) => {
    const [doc, setDoc] = useState<MaskDocument | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedKey, setSelectedKey] = useState<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setDoc(null);
        setSelectedKey(null);

        api.readAnimationMasks(binPath, sklPath)
            .then((d) => {
                if (cancelled) return;
                setDoc(d);
                setSelectedKey(d.masks[0]?.key ?? null);
            })
            .catch((err) => {
                if (!cancelled) setError((err as Error).message || 'Failed to load animation masks');
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });

        return () => { cancelled = true; };
    }, [binPath, sklPath]);

    const selectedMask: MaskView | null = useMemo(() => {
        if (!doc || selectedKey === null) return null;
        return doc.masks.find((m) => m.key === selectedKey) ?? null;
    }, [doc, selectedKey]);

    const mismatched = selectedMask ? isMismatched(selectedMask) : false;

    const depthByIndex = useMemo(() => {
        const depths = new Map<number, number>();
        if (!selectedMask || mismatched) return depths;
        const byIndex = new Map<number, JointWeight>();
        for (const j of selectedMask.joints) byIndex.set(j.index, j);
        for (const j of selectedMask.joints) depths.set(j.index, jointDepth(j.index, byIndex));
        return depths;
    }, [selectedMask, mismatched]);

    if (loading) {
        return (
            <div className="preview-panel__loading">
                <div className="spinner" />
                <span>Loading animation masks…</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="preview-panel__loading">
                <span>{error}</span>
            </div>
        );
    }

    if (!doc) return null;

    if (doc.masks.length === 0) {
        return (
            <div className="preview-panel__loading">
                <span>No masks found in this animation graph.</span>
            </div>
        );
    }

    return (
        <div style={{ display: 'flex', flexDirection: 'column', height: '100%' }}>
            <div style={{
                padding: '6px 10px',
                borderBottom: '1px solid var(--border-color, #333)',
                fontSize: 12,
                opacity: 0.7,
                flexShrink: 0,
            }}>
                {doc.masks.length} mask{doc.masks.length === 1 ? '' : 's'} · skeleton has {doc.skeletonJointCount} joint{doc.skeletonJointCount === 1 ? '' : 's'}
            </div>

            <div style={{ display: 'flex', flex: 1, minHeight: 0 }}>
                <div style={{
                    width: 220,
                    flexShrink: 0,
                    borderRight: '1px solid var(--border-color, #333)',
                    overflowY: 'auto',
                }}>
                    {doc.masks.map((m) => {
                        const rowMismatched = isMismatched(m);
                        const isSelected = selectedKey === m.key;
                        return (
                            <div
                                key={m.key}
                                onClick={() => setSelectedKey(m.key)}
                                style={{
                                    display: 'flex',
                                    alignItems: 'center',
                                    gap: 6,
                                    padding: '6px 10px',
                                    cursor: 'pointer',
                                    fontFamily: 'var(--font-mono, monospace)',
                                    fontSize: 12,
                                    background: isSelected ? 'var(--bg-hover, #2a2d35)' : 'transparent',
                                    borderBottom: '1px solid var(--border-subtle, #222)',
                                }}
                            >
                                {rowMismatched && (
                                    <span title="Weight count does not match the skeleton" style={{ color: 'var(--warning, #f0a020)' }}>
                                        ⚠
                                    </span>
                                )}
                                <span style={{ flex: 1, overflow: 'hidden', textOverflow: 'ellipsis', whiteSpace: 'nowrap' }}>
                                    {formatMaskKey(m.key)}
                                </span>
                                <span style={{ opacity: 0.6 }}>{m.joints.length}</span>
                            </div>
                        );
                    })}
                </div>

                <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                    {selectedMask ? (
                        <>
                            {mismatched && (
                                <div style={{
                                    display: 'flex',
                                    alignItems: 'flex-start',
                                    gap: 8,
                                    margin: 10,
                                    padding: '8px 10px',
                                    background: 'color-mix(in oklab, var(--warning, #f0a020) 12%, transparent)',
                                    border: '1px solid color-mix(in oklab, var(--warning, #f0a020) 30%, transparent)',
                                    borderRadius: 4,
                                    color: 'var(--warning, #f0a020)',
                                    fontSize: 12,
                                    flexShrink: 0,
                                }}>
                                    <span>⚠</span>
                                    <span>
                                        This mask has {selectedMask.joints.length} weights but the skeleton has{' '}
                                        {doc.skeletonJointCount} joints. Joint names are hidden because weight N no
                                        longer refers to joint N. This usually means the model was exported with a
                                        different skeleton.
                                    </span>
                                </div>
                            )}
                            {selectedMask.joints.map((joint) => (
                                <div
                                    key={joint.index}
                                    style={{
                                        display: 'flex',
                                        alignItems: 'center',
                                        gap: 8,
                                        padding: '4px 10px',
                                        paddingLeft: 10 + (depthByIndex.get(joint.index) ?? 0) * 14,
                                        borderBottom: '1px solid var(--border-subtle, #222)',
                                        fontSize: 12,
                                    }}
                                >
                                    <span style={{
                                        flex: 1,
                                        overflow: 'hidden',
                                        textOverflow: 'ellipsis',
                                        whiteSpace: 'nowrap',
                                        fontFamily: joint.name ? undefined : 'var(--font-mono, monospace)',
                                        opacity: joint.name ? 1 : 0.75,
                                    }}>
                                        {joint.name ?? `#${joint.index}`}
                                    </span>
                                    <span style={{ width: 56, textAlign: 'right', fontFamily: 'var(--font-mono, monospace)', opacity: 0.85 }}>
                                        {joint.weight.toFixed(2)}
                                    </span>
                                </div>
                            ))}
                        </>
                    ) : (
                        <div style={{ padding: 10, opacity: 0.6, fontSize: 12 }}>Select a mask to view its joint weights.</div>
                    )}
                </div>
            </div>
        </div>
    );
};
