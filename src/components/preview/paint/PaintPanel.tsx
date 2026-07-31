import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../../lib/api';
import { useNotificationStore } from '../../../lib/stores';
import { requestRevealText } from '../../../lib/editor/binEditorEvents';
import { PaletteBar } from './PaletteBar';
import { DlSelect } from '../../ui/design-lab/DlSelect';
import { SystemList } from './SystemList';
import type { Vec4 } from '../../../lib/paint/colorMath';
import type {
    ColorTargetId,
    EmitterColors,
    VfxModel,
} from '../../../lib/api/paint';
import './PaintPanel.css';

interface PaintPanelProps {
    binPath: string;
    /** Called after a successful save so the editor can refresh its text view. */
    onSaved?: () => void;
    /** Close the panel — double-clicking a row hands off to the text editor. */
    onClose?: () => void;
}

/** Color slots, in the right-to-left order the blocks are laid out. */
const SLOTS: Array<{ id: Exclude<ColorTargetId, 'all'>; label: string; title: string }> = [
    { id: 'lingerColor', label: 'LC', title: 'Linger Color' },
    { id: 'fresnelColor', label: 'OC', title: 'Outline / Fresnel Color' },
    { id: 'birthColor', label: 'BC', title: 'Birth Color' },
    { id: 'color', label: 'Color', title: 'Base Color' },
];

export const PaintPanel: React.FC<PaintPanelProps> = ({ binPath, onSaved, onClose }) => {
    const showToast = useNotificationStore((s) => s.showToast);

    const [sessionId, setSessionId] = useState<number | null>(null);
    const [model, setModel] = useState<VfxModel | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    const [selection, setSelection] = useState<Set<string>>(new Set());
    const [lockedSystems, setLockedSystems] = useState<Set<string>>(new Set());
    const [expandedSystems, setExpandedSystems] = useState<Set<string>>(new Set());
    const [expandedMaterials, setExpandedMaterials] = useState<Set<string>>(new Set());
    const [searchQuery, setSearchQuery] = useState('');

    const [hueTarget, setHueTarget] = useState(0);
    const [targets, setTargets] = useState<Set<ColorTargetId>>(
        new Set<ColorTargetId>(['color', 'birthColor', 'fresnelColor', 'lingerColor']),
    );
    const [ignoreBlackWhite, setIgnoreBlackWhite] = useState(true);
    const [preserveAlpha, setPreserveAlpha] = useState(true);
    const [blendModeSelect, setBlendModeSelect] = useState(0);

    /* The live session id, mirrored into a ref so the cleanup paths can read it
       without re-subscribing. Written ONLY where the session is opened/closed —
       assigning it every render would clobber the value the path-change effect
       needs to close the outgoing session. */
    const sessionRef = useRef<number | null>(null);

    useEffect(() => {
        let cancelled = false;
        // Whatever session this panel held is for the PREVIOUS path; drop it
        // here rather than in an unmount-only cleanup, or switching files while
        // the panel stays mounted strands its tree for the life of the process.
        const previous = sessionRef.current;
        if (previous !== null) {
            void api.paintClose(previous);
            sessionRef.current = null;
        }

        setSessionId(null);
        setLoading(true);
        setError(null);
        setModel(null);
        setSelection(new Set());
        setLockedSystems(new Set());
        setDirty(false);

        api.paintOpen(binPath)
            .then((res) => {
                if (cancelled) {
                    // Unmounted (or the path changed) mid-open: close the
                    // session we just created, nobody else holds its id.
                    void api.paintClose(res.sessionId);
                    return;
                }
                sessionRef.current = res.sessionId;
                setSessionId(res.sessionId);
                setModel(res.model);
                setExpandedSystems(new Set(res.model.systemOrder));
                setExpandedMaterials(new Set(res.model.materialOrder));
                setLoading(false);
            })
            .catch((e: unknown) => {
                if (cancelled) return;
                setError(e instanceof Error ? e.message : String(e));
                setLoading(false);
            });

        return () => {
            cancelled = true;
        };
    }, [binPath]);

    // Close the live session when the panel goes away for good.
    useEffect(
        () => () => {
            const id = sessionRef.current;
            if (id !== null) {
                void api.paintClose(id);
                sessionRef.current = null;
            }
        },
        [],
    );

    /* Only emitter keys go to the recolor command; material params are edited
       one at a time, so a mixed selection must not send them through. */
    const selectedEmitterKeys = useMemo(() => {
        if (!model) return [];
        const valid = new Set(model.emitters.map((e) => e.key));
        return [...selection].filter((k) => valid.has(k));
    }, [selection, model]);

    const toggleKey = useCallback((key: string) => {
        setSelection((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const toggleSystem = useCallback(
        (systemKey: string, selected: boolean) => {
            if (!model) return;
            const system = model.systems.find((s) => s.key === systemKey);
            if (!system) return;
            setSelection((prev) => {
                const next = new Set(prev);
                for (const k of system.emitterKeys) {
                    if (selected) next.add(k);
                    else next.delete(k);
                }
                return next;
            });
        },
        [model],
    );

    const toggleLock = useCallback((systemKey: string) => {
        setLockedSystems((prev) => {
            const next = new Set(prev);
            if (next.has(systemKey)) next.delete(systemKey);
            else next.add(systemKey);
            return next;
        });
        // A locked system's emitters must leave the selection, or a recolor
        // would still write to the rows the lock is meant to protect.
        setSelection((prevSel) => {
            const system = model?.systems.find((s) => s.key === systemKey);
            if (!system) return prevSel;
            const next = new Set(prevSel);
            for (const k of system.emitterKeys) next.delete(k);
            return next;
        });
    }, [model]);

    const toggleExpand = useCallback((key: string) => {
        setExpandedSystems((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const toggleMaterialExpand = useCallback((key: string) => {
        setExpandedMaterials((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const selectAll = useCallback(() => {
        if (!model) return;
        setSelection(
            new Set(
                model.emitters
                    .filter((e) => !lockedSystems.has(e.systemKey))
                    .map((e) => e.key),
            ),
        );
    }, [model, lockedSystems]);

    const selectNone = useCallback(() => setSelection(new Set()), []);

    /* Selectable = every emitter not inside a locked system. The header box is
       tri-state against that set, so locking a system doesn't leave it stuck
       showing "partially selected" forever. */
    const { allSelected, someSelected } = useMemo(() => {
        const selectable = model
            ? model.emitters.filter((e) => !lockedSystems.has(e.systemKey))
            : [];
        const hit = selectable.filter((e) => selection.has(e.key)).length;
        return {
            allSelected: selectable.length > 0 && hit === selectable.length,
            someSelected: hit > 0 && hit < selectable.length,
        };
    }, [model, selection, lockedSystems]);

    const selectByBlendMode = useCallback(() => {
        if (!model) return;
        const hits = model.emitters.filter(
            (e) => e.blendMode === blendModeSelect && !lockedSystems.has(e.systemKey),
        );
        setSelection(new Set(hits.map((e) => e.key)));
        showToast('info', `Selected ${hits.length} emitter(s) with BM ${blendModeSelect}`);
    }, [model, blendModeSelect, lockedSystems, showToast]);

    /** Click a colour block to adopt its hue as the target — the "steal that
     *  colour" gesture, adapted to this panel's single hue-shift mode. */
    const pickHueFrom = useCallback(
        (rgba: number[]) => {
            const [r, g, b] = rgba;
            const max = Math.max(r, g, b);
            const min = Math.min(r, g, b);
            const d = max - min;
            if (d === 0) {
                // Greyscale has no hue to adopt; say so rather than snapping to 0.
                showToast('info', 'That colour is greyscale — no hue to pick.');
                return;
            }
            let h: number;
            if (max === r) h = ((g - b) / d + (g < b ? 6 : 0)) / 6;
            else if (max === g) h = ((b - r) / d + 2) / 6;
            else h = ((r - g) / d + 4) / 6;
            const deg = Math.round(h * 360) % 360;
            setHueTarget(deg);
            showToast('info', `Target hue set to ${deg}°`);
        },
        [showToast],
    );

    /* Double-click hands off to the text editor: close the overlay first so the
       reveal is actually visible, then ask the editor to find the name. The
       editor owns the search — it has the live Monaco model. */
    const revealInText = useCallback(
        (needle: string) => {
            if (!needle) return;
            onClose?.();
            requestRevealText(binPath, needle);
        },
        [binPath, onClose],
    );

    /** Patch refreshed colors into the resident model without a full refetch. */
    const patchColors = useCallback((colors: Record<string, EmitterColors>) => {
        setModel((prev) =>
            prev
                ? {
                      ...prev,
                      emitters: prev.emitters.map((e) =>
                          colors[e.key] ? { ...e, colors: colors[e.key] } : e,
                      ),
                  }
                : prev,
        );
    }, []);

    const handleRecolor = useCallback(async () => {
        if (sessionId === null) return;
        if (selectedEmitterKeys.length === 0) {
            showToast('info', 'Select at least one emitter to recolor.');
            return;
        }
        const targetList = [...targets];
        if (targetList.length === 0) {
            showToast('info', 'Enable at least one color target.');
            return;
        }
        try {
            const res = await api.paintRecolor(
                sessionId,
                selectedEmitterKeys,
                targetList,
                // Hue-target mode never samples the palette.
                [],
                { mode: 'shift-hue', ignoreBlackWhite, preserveAlpha, hueTarget },
            );
            if (res.changed === 0) {
                showToast('info', 'Nothing changed — try disabling "Ignore B/W".');
                return;
            }
            patchColors(res.colors);
            setDirty(true);
            showToast('success', `Recolored ${res.changed} color group(s)`);
        } catch (e) {
            showToast('error', e instanceof Error ? e.message : String(e));
        }
    }, [
        sessionId,
        selectedEmitterKeys,
        targets,
        ignoreBlackWhite,
        preserveAlpha,
        hueTarget,
        patchColors,
        showToast,
    ]);

    const handleSetBlendMode = useCallback(
        async (emitterKey: string, blendMode: number) => {
            if (sessionId === null) return;
            try {
                const changed = await api.paintSetBlendMode(sessionId, emitterKey, blendMode);
                if (!changed) return;
                setModel((prev) =>
                    prev
                        ? {
                              ...prev,
                              emitters: prev.emitters.map((e) =>
                                  e.key === emitterKey ? { ...e, blendMode } : e,
                              ),
                          }
                        : prev,
                );
                setDirty(true);
            } catch (e) {
                showToast('error', e instanceof Error ? e.message : String(e));
            }
        },
        [sessionId, showToast],
    );

    const handleSetMaterialParam = useCallback(
        async (selectionKey: string, value: Vec4) => {
            if (sessionId === null) return;
            try {
                const changed = await api.paintSetMaterialParam(
                    sessionId,
                    selectionKey,
                    value,
                    false,
                );
                if (!changed) return;
                setModel((prev) =>
                    prev
                        ? {
                              ...prev,
                              materials: prev.materials.map((m) => ({
                                  ...m,
                                  colorParams: m.colorParams.map((p) =>
                                      p.selectionKey === selectionKey ? { ...p, values: value } : p,
                                  ),
                              })),
                          }
                        : prev,
                );
                setDirty(true);
            } catch (e) {
                showToast('error', e instanceof Error ? e.message : String(e));
            }
        },
        [sessionId, showToast],
    );

    const refreshDirty = useCallback(
        async (id: number) => {
            try {
                setDirty(await api.paintIsDirty(id));
            } catch {
                // A failed probe must not wedge the panel; the Save button just
                // keeps its current enabled state.
            }
        },
        [],
    );

    const handleUndo = useCallback(async () => {
        if (sessionId === null) return;
        try {
            const next = await api.paintUndo(sessionId);
            if (!next) {
                showToast('info', 'Nothing to undo.');
                return;
            }
            setModel(next);
            await refreshDirty(sessionId);
        } catch (e) {
            showToast('error', e instanceof Error ? e.message : String(e));
        }
    }, [sessionId, showToast, refreshDirty]);

    const handleRedo = useCallback(async () => {
        if (sessionId === null) return;
        try {
            const next = await api.paintRedo(sessionId);
            if (!next) {
                showToast('info', 'Nothing to redo.');
                return;
            }
            setModel(next);
            await refreshDirty(sessionId);
        } catch (e) {
            showToast('error', e instanceof Error ? e.message : String(e));
        }
    }, [sessionId, showToast, refreshDirty]);

    const handleSave = useCallback(async () => {
        if (sessionId === null || saving) return;
        setSaving(true);
        try {
            const res = await api.paintSave(sessionId);
            if (!res.saved) {
                showToast('info', 'No changes to save.');
                return;
            }
            setDirty(false);
            showToast('success', res.checkpointed ? 'Saved (checkpoint created)' : 'Saved');
            onSaved?.();
        } catch (e) {
            showToast('error', e instanceof Error ? e.message : String(e));
        } finally {
            setSaving(false);
        }
    }, [sessionId, saving, showToast, onSaved]);

    if (loading) {
        return <div className="paint-panel paint-panel--message">Loading VFX…</div>;
    }
    if (error) {
        return (
            <div className="paint-panel paint-panel--message paint-panel--error">
                Could not open this BIN for painting: {error}
            </div>
        );
    }
    if (!model) {
        return <div className="paint-panel paint-panel--message">No VFX data.</div>;
    }

    const toggleTarget = (id: ColorTargetId) =>
        setTargets((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });

    return (
        <div className="paint-panel">
            <PaletteBar hueTarget={hueTarget} onHueTargetChange={setHueTarget} />

            {/* Blend-mode selector + color-target toggles. */}
            <div className="paint-toolbar">
                <div className="paint-toolbar__group">
                    <span className="paint-toolbar__label">BM</span>
                    <DlSelect
                        value={String(blendModeSelect)}
                        onChange={(v) => setBlendModeSelect(Number(v))}
                        options={[0, 1, 2, 3, 4].map((n) => ({ value: String(n), label: String(n) }))}
                        width={64}
                        title="Blend mode to select by"
                    />
                    <button
                        type="button"
                        className="dl-btn dl-btn--secondary dl-btn--sm"
                        onClick={selectByBlendMode}
                    >
                        Select BM {blendModeSelect}
                    </button>
                </div>

                <div className="paint-toolbar__group paint-toolbar__group--targets">
                    {SLOTS.map((slot) => (
                        <label
                            key={slot.id}
                            className={`paint-toolbar__target${
                                targets.has(slot.id) ? ' is-on' : ''
                            }`}
                            title={`Recolor ${slot.title}`}
                        >
                            <input
                                type="checkbox"
                                checked={targets.has(slot.id)}
                                onChange={() => toggleTarget(slot.id)}
                            />
                            {slot.label}
                        </label>
                    ))}
                </div>
            </div>

            {/* Search + selection + view options. */}
            <div className="paint-search">
                {/* One tri-state box, like Quartz — All/None as two buttons was
                    twice the chrome for the same decision. */}
                <input
                    type="checkbox"
                    className="paint-search__all"
                    checked={allSelected}
                    ref={(el) => {
                        if (el) el.indeterminate = someSelected && !allSelected;
                    }}
                    onChange={() => (allSelected || someSelected ? selectNone() : selectAll())}
                    title={allSelected || someSelected ? 'Deselect all' : 'Select all emitters'}
                    aria-label="Select all emitters"
                />
                <input
                    type="text"
                    className="dl-input paint-search__field"
                    placeholder="Filter systems and emitters…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                />
                <span className="paint-search__sep" />
                <label className="paint-search__opt" title="Skip pure black and pure white">
                    <input
                        type="checkbox"
                        checked={ignoreBlackWhite}
                        onChange={(e) => setIgnoreBlackWhite(e.target.checked)}
                    />
                    Ignore B/W
                </label>
                <label className="paint-search__opt" title="Keep each color's existing alpha">
                    <input
                        type="checkbox"
                        checked={preserveAlpha}
                        onChange={(e) => setPreserveAlpha(e.target.checked)}
                    />
                    Keep alpha
                </label>
            </div>

            <SystemList
                model={model}
                selection={selection}
                lockedSystems={lockedSystems}
                expandedSystems={expandedSystems}
                expandedMaterials={expandedMaterials}
                searchQuery={searchQuery}
                showBaseColor={targets.has('color')}
                showBirthColor={targets.has('birthColor')}
                showOC={targets.has('fresnelColor')}
                showLingerColor={targets.has('lingerColor')}
                onToggleEmitter={toggleKey}
                onToggleSystem={toggleSystem}
                onToggleLock={toggleLock}
                onToggleExpand={toggleExpand}
                onToggleMaterialExpand={toggleMaterialExpand}
                onSetBlendMode={handleSetBlendMode}
                onSetMaterialParam={handleSetMaterialParam}
                onPickHue={pickHueFrom}
                onRevealInText={revealInText}
            />

            <div className="paint-footer">
                <span className="paint-footer__stats">
                    {model.stats.systemCount} systems · {model.stats.emitterCount} emitters
                    {model.stats.materialCount > 0 && ` · ${model.stats.materialCount} materials`}
                    {selection.size > 0 && (
                        <span className="paint-footer__selected"> · {selection.size} selected</span>
                    )}
                    {dirty && (
                        <span className="paint-footer__dirty" title="Unsaved changes">
                            Unsaved
                        </span>
                    )}
                </span>

                <div className="paint-footer__actions">
                    <button
                        type="button"
                        className="dl-btn dl-btn--ghost dl-btn--sm"
                        onClick={handleUndo}
                        title="Undo the last edit"
                    >
                        Undo
                    </button>
                    <button
                        type="button"
                        className="dl-btn dl-btn--ghost dl-btn--sm"
                        onClick={handleRedo}
                        title="Redo the last undone edit"
                    >
                        Redo
                    </button>
                    <button
                        type="button"
                        className="dl-btn dl-btn--primary paint-footer__recolor"
                        onClick={handleRecolor}
                        disabled={selectedEmitterKeys.length === 0}
                        title={
                            selectedEmitterKeys.length === 0
                                ? 'Select emitters first'
                                : 'Recolor the selection'
                        }
                    >
                        Recolor{selectedEmitterKeys.length > 0 && ` (${selectedEmitterKeys.length})`}
                    </button>
                    <button
                        type="button"
                        className="dl-btn dl-btn--sm paint-footer__save"
                        onClick={handleSave}
                        disabled={!dirty || saving}
                        title={dirty ? 'Save the BIN (checkpoints the project first)' : 'No changes'}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>
        </div>
    );
};
