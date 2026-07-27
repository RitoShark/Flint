import React, { useCallback, useEffect, useMemo, useState } from 'react';
import * as api from '../../lib/api';
import { useNotificationStore } from '../../lib/stores';
import type { JointWeight, MaskDocument, MaskView } from '../../lib/api/animask';
import { invertAll, setAll, setSubtree } from '../../lib/maskOps';

interface MaskEditorProps {
    binPath: string;
    /** Omit to let the backend resolve the skeleton from the BIN itself. */
    sklPath?: string;
}

/** Clamp to the valid weight range; slider and numeric input share this. */
function clampWeight(value: number): number {
    return Math.min(1, Math.max(0, value));
}

function formatWeight(value: number): string {
    return value.toFixed(2);
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

interface JointRowProps {
    joint: JointWeight;
    depth: number;
    onWeightChange: (index: number, weight: number) => void;
    onSetSubtree: (index: number, weight: number) => void;
    /** True when this mask's hierarchy can't be trusted (see `isMismatched`) —
     *  index `i` no longer provably refers to bone `i`, so "this joint and
     *  everything below it" has no meaning and the control is disabled. */
    subtreeDisabled: boolean;
}

/** One joint's slider + numeric input. Edits update the parent's state on
 *  every slider drag; the numeric field validates on blur/Enter so a
 *  mid-keystroke string (`"0."`, empty, `"-"`) is never sent upstream. */
const JointRow: React.FC<JointRowProps> = ({ joint, depth, onWeightChange, onSetSubtree, subtreeDisabled }) => {
    const [draft, setDraft] = useState(() => formatWeight(joint.weight));
    const [focused, setFocused] = useState(false);

    // Resync the draft text from the committed weight (slider drag, a bulk
    // op, or switching masks and back) — but never while the user is mid-edit
    // in this very field, or every keystroke would be clobbered by the
    // re-render it triggers.
    useEffect(() => {
        if (!focused) setDraft(formatWeight(joint.weight));
    }, [joint.weight, focused]);

    const commitDraft = () => {
        const trimmed = draft.trim();
        const parsed = Number(trimmed);
        if (trimmed === '' || !Number.isFinite(parsed)) {
            // Not a number at all — reject silently, revert to last-good value.
            setDraft(formatWeight(joint.weight));
            return;
        }
        const clamped = clampWeight(parsed);
        if (clamped !== joint.weight) onWeightChange(joint.index, clamped);
        else setDraft(formatWeight(clamped));
    };

    return (
        <div
            style={{
                display: 'flex',
                alignItems: 'center',
                gap: 8,
                padding: '4px 10px',
                paddingLeft: 10 + depth * 14,
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
            <input
                type="range"
                min={0}
                max={1}
                step={0.01}
                value={joint.weight}
                onChange={(e) => onWeightChange(joint.index, clampWeight(parseFloat(e.target.value)))}
                style={{ width: 100 }}
            />
            <input
                type="number"
                min={0}
                max={1}
                step={0.01}
                value={draft}
                onFocus={() => setFocused(true)}
                onChange={(e) => setDraft(e.target.value)}
                onBlur={() => { setFocused(false); commitDraft(); }}
                onKeyDown={(e) => {
                    if (e.key === 'Enter') { commitDraft(); (e.target as HTMLInputElement).blur(); }
                }}
                style={{
                    width: 56,
                    textAlign: 'right',
                    fontFamily: 'var(--font-mono, monospace)',
                    background: 'var(--bg-tertiary)',
                    border: '1px solid var(--border)',
                    borderRadius: 4,
                    color: 'var(--text-primary)',
                    fontSize: 12,
                }}
            />
            <button
                className="btn btn--sm"
                onClick={() => onSetSubtree(joint.index, joint.weight)}
                disabled={subtreeDisabled}
                title={
                    subtreeDisabled
                        ? 'Unavailable: this mask\'s joint hierarchy is unreliable'
                        : `Apply ${formatWeight(joint.weight)} to this joint and every descendant`
                }
                style={{ fontSize: 10, padding: '2px 6px', flexShrink: 0 }}
            >
                Subtree
            </button>
        </div>
    );
};

export const MaskEditor: React.FC<MaskEditorProps> = ({ binPath, sklPath }) => {
    const showToast = useNotificationStore((s) => s.showToast);

    const [doc, setDoc] = useState<MaskDocument | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [selectedKey, setSelectedKey] = useState<number | null>(null);

    // Live edits, keyed by mask key, independent of `doc` (the load baseline).
    // Kept separate — and never reset by switching `selectedKey` — so
    // switching masks cannot silently discard unsaved edits.
    const [editedByKey, setEditedByKey] = useState<Record<number, JointWeight[]>>({});
    const [saving, setSaving] = useState(false);

    // The value "Set all" applies to every joint in the selected mask.
    const [bulkValue, setBulkValue] = useState(1);

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setDoc(null);
        setSelectedKey(null);
        setEditedByKey({});

        api.readAnimationMasks(binPath, sklPath)
            .then((d) => {
                if (cancelled) return;
                setDoc(d);
                setSelectedKey(d.masks[0]?.key ?? null);
                const initial: Record<number, JointWeight[]> = {};
                for (const m of d.masks) initial[m.key] = m.joints.map((j) => ({ ...j }));
                setEditedByKey(initial);
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

    // The live (possibly edited) joints for whichever mask is selected — this,
    // not `selectedMask.joints`, is what renders on the right and what Save reads.
    const selectedMaskJoints: JointWeight[] = useMemo(() => {
        if (selectedKey === null) return [];
        return editedByKey[selectedKey] ?? selectedMask?.joints ?? [];
    }, [editedByKey, selectedKey, selectedMask]);

    // Derived per-mask rather than read off `doc.jointCountMismatch` directly:
    // that flag is an OR across every mask in the document, so a document
    // containing one broken mask and one healthy one would otherwise make
    // the healthy mask's pane show a warning (and hide its real names) too.
    const mismatched = selectedMaskJoints.some((j) => j.name === null);

    const depthByIndex = useMemo(() => {
        const depths = new Map<number, number>();
        if (mismatched || selectedMaskJoints.length === 0) return depths;
        const byIndex = new Map<number, JointWeight>();
        for (const j of selectedMaskJoints) byIndex.set(j.index, j);
        for (const j of selectedMaskJoints) depths.set(j.index, jointDepth(j.index, byIndex));
        return depths;
    }, [selectedMaskJoints, mismatched]);

    // Which masks have edits pending, and how many individual weights changed —
    // drives both the per-row indicator in the mask list and the Save label.
    const { dirtyKeys, dirtyWeightCount } = useMemo(() => {
        const keys: number[] = [];
        let weightCount = 0;
        if (doc) {
            for (const m of doc.masks) {
                const current = editedByKey[m.key];
                if (!current) continue;
                let changed = 0;
                for (let i = 0; i < current.length; i++) {
                    if (current[i].weight !== m.joints[i]?.weight) changed++;
                }
                if (changed > 0) {
                    keys.push(m.key);
                    weightCount += changed;
                }
            }
        }
        return { dirtyKeys: keys, dirtyWeightCount: weightCount };
    }, [doc, editedByKey]);

    const dirtyKeySet = useMemo(() => new Set(dirtyKeys), [dirtyKeys]);

    const handleWeightChange = useCallback((maskKey: number, jointIndex: number, weight: number) => {
        setEditedByKey((prev) => {
            const joints = prev[maskKey];
            if (!joints) return prev;
            const next = joints.map((j) => (j.index === jointIndex ? { ...j, weight } : j));
            return { ...prev, [maskKey]: next };
        });
    }, []);

    // Bulk operations — same guarded update-in-place shape as
    // `handleWeightChange`, just delegating the transform to the pure
    // `maskOps` functions instead of touching one joint.
    const handleSetAll = useCallback((maskKey: number, weight: number) => {
        setEditedByKey((prev) => {
            const joints = prev[maskKey];
            if (!joints) return prev;
            return { ...prev, [maskKey]: setAll(joints, weight) };
        });
    }, []);

    const handleInvertAll = useCallback((maskKey: number) => {
        setEditedByKey((prev) => {
            const joints = prev[maskKey];
            if (!joints) return prev;
            return { ...prev, [maskKey]: invertAll(joints) };
        });
    }, []);

    const handleSetSubtree = useCallback((maskKey: number, jointIndex: number, weight: number) => {
        setEditedByKey((prev) => {
            const joints = prev[maskKey];
            if (!joints) return prev;
            return { ...prev, [maskKey]: setSubtree(joints, jointIndex, weight) };
        });
    }, []);

    const handleSave = useCallback(async () => {
        if (!doc || dirtyKeys.length === 0 || saving) return;

        const payload: MaskView[] = dirtyKeys.map((key) => ({ key, joints: editedByKey[key] }));

        setSaving(true);
        try {
            const written = await api.saveAnimationMasks(binPath, payload);
            showToast('success', `Saved ${written} mask${written === 1 ? '' : 's'}`);
            // The write succeeded for exactly these masks — fold them into the
            // baseline so they read as clean without a round-trip re-read.
            setDoc((prev) => {
                if (!prev) return prev;
                return {
                    ...prev,
                    masks: prev.masks.map((m) => (
                        dirtyKeySet.has(m.key) ? { ...m, joints: editedByKey[m.key] } : m
                    )),
                };
            });
        } catch (err) {
            const flintErr = err as api.FlintError;
            const msg = flintErr?.getUserMessage?.() || (err as Error)?.message || String(err);
            // write_masks is all-or-nothing: a failed save wrote nothing at
            // all, not "everything except the bad mask" — say so explicitly
            // rather than leaving the user to guess what landed.
            showToast('error', `Save failed — nothing was written. ${msg}`);
        } finally {
            setSaving(false);
        }
    }, [doc, dirtyKeys, dirtyKeySet, editedByKey, binPath, showToast, saving]);

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
                display: 'flex',
                alignItems: 'center',
                justifyContent: 'space-between',
                gap: 12,
                padding: '6px 10px',
                borderBottom: '1px solid var(--border-color, #333)',
                fontSize: 12,
                flexShrink: 0,
            }}>
                <span style={{ opacity: 0.7 }}>
                    {doc.masks.length} mask{doc.masks.length === 1 ? '' : 's'} · skeleton has {doc.skeletonJointCount} joint{doc.skeletonJointCount === 1 ? '' : 's'}
                </span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                    <span style={{ opacity: 0.7 }}>
                        {dirtyKeys.length === 0
                            ? 'No changes'
                            : `${dirtyWeightCount} weight${dirtyWeightCount === 1 ? '' : 's'} changed in ${dirtyKeys.length} mask${dirtyKeys.length === 1 ? '' : 's'}`}
                    </span>
                    <button
                        className="btn btn--primary btn--sm"
                        onClick={handleSave}
                        disabled={dirtyKeys.length === 0 || saving}
                        title={dirtyKeys.length === 0 ? 'No edited masks to save' : `Save ${dirtyKeys.length} edited mask${dirtyKeys.length === 1 ? '' : 's'}`}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
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
                        const rowDirty = dirtyKeySet.has(m.key);
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
                                {rowDirty && (
                                    <span title="This mask has unsaved edits" style={{ color: 'var(--accent-primary)', fontSize: 8 }}>
                                        ●
                                    </span>
                                )}
                                <span style={{ opacity: 0.6 }}>{m.joints.length}</span>
                            </div>
                        );
                    })}
                </div>

                <div style={{ flex: 1, minWidth: 0, overflowY: 'auto', display: 'flex', flexDirection: 'column' }}>
                    {selectedMask ? (
                        <>
                            <div style={{
                                display: 'flex',
                                alignItems: 'center',
                                gap: 8,
                                padding: '6px 10px',
                                borderBottom: '1px solid var(--border-subtle, #222)',
                                fontSize: 12,
                                flexShrink: 0,
                            }}>
                                <span style={{ opacity: 0.7 }}>Bulk</span>
                                <input
                                    type="number"
                                    min={0}
                                    max={1}
                                    step={0.01}
                                    value={bulkValue}
                                    onChange={(e) => {
                                        const parsed = parseFloat(e.target.value);
                                        if (Number.isFinite(parsed)) setBulkValue(clampWeight(parsed));
                                    }}
                                    style={{
                                        width: 56,
                                        textAlign: 'right',
                                        fontFamily: 'var(--font-mono, monospace)',
                                        background: 'var(--bg-tertiary)',
                                        border: '1px solid var(--border)',
                                        borderRadius: 4,
                                        color: 'var(--text-primary)',
                                        fontSize: 12,
                                    }}
                                />
                                <button
                                    className="btn btn--sm"
                                    onClick={() => handleSetAll(selectedMask.key, bulkValue)}
                                    title={`Set every joint in this mask to ${formatWeight(bulkValue)}`}
                                    style={{ fontSize: 11, padding: '2px 8px' }}
                                >
                                    Set all
                                </button>
                                <button
                                    className="btn btn--sm"
                                    onClick={() => handleInvertAll(selectedMask.key)}
                                    title="Map every weight w to 1 - w"
                                    style={{ fontSize: 11, padding: '2px 8px' }}
                                >
                                    Invert
                                </button>
                            </div>
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
                                        This mask has {selectedMaskJoints.length} weights but the skeleton has{' '}
                                        {doc.skeletonJointCount} joints. Joint names are hidden because weight N no
                                        longer refers to joint N. This usually means the model was exported with a
                                        different skeleton.
                                    </span>
                                </div>
                            )}
                            {selectedMaskJoints.length === 0 && (
                                <div style={{ padding: 10, opacity: 0.6, fontSize: 12 }}>This mask has no weights.</div>
                            )}
                            {selectedMaskJoints.map((joint) => (
                                <JointRow
                                    key={joint.index}
                                    joint={joint}
                                    depth={depthByIndex.get(joint.index) ?? 0}
                                    onWeightChange={(idx, w) => handleWeightChange(selectedMask.key, idx, w)}
                                    onSetSubtree={(idx, w) => handleSetSubtree(selectedMask.key, idx, w)}
                                    subtreeDisabled={mismatched}
                                />
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
