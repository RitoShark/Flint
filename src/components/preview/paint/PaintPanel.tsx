import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../../lib/api';
import { useNotificationStore } from '../../../lib/stores';
import { PaletteBar, modeUsesPalette } from './PaletteBar';
import { SystemList } from './SystemList';
import type { Vec4 } from '../../../lib/paint/colorMath';
import type {
    ColorKeyframe,
    ColorTargetId,
    EmitterColors,
    RecolorModeId,
    VfxModel,
} from '../../../lib/api/paint';
import './PaintPanel.css';

interface PaintPanelProps {
    binPath: string;
    /** Called after a successful save so the editor can refresh its text view. */
    onSaved?: () => void;
}

const DEFAULT_PALETTE: Vec4[] = [
    [0.925, 0.725, 0.415, 1],
    [0.42, 0.55, 0.92, 1],
];

/** Color slots, in the right-to-left order the blocks are laid out. */
const SLOTS: Array<{ id: Exclude<ColorTargetId, 'all'>; label: string; title: string }> = [
    { id: 'lingerColor', label: 'LC', title: 'Linger Color' },
    { id: 'fresnelColor', label: 'OC', title: 'Outline / Fresnel Color' },
    { id: 'birthColor', label: 'BC', title: 'Birth Color' },
    { id: 'color', label: 'Color', title: 'Base Color' },
];

export const PaintPanel: React.FC<PaintPanelProps> = ({ binPath, onSaved }) => {
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

    const [mode, setMode] = useState<RecolorModeId>('linear');
    const [palette, setPalette] = useState<Vec4[]>(DEFAULT_PALETTE);
    const [hslShift, setHslShift] = useState<[number, number, number]>([0, 0, 0]);
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

    const selectByBlendMode = useCallback(() => {
        if (!model) return;
        const hits = model.emitters.filter(
            (e) => e.blendMode === blendModeSelect && !lockedSystems.has(e.systemKey),
        );
        setSelection(new Set(hits.map((e) => e.key)));
        showToast('info', `Selected ${hits.length} emitter(s) with BM ${blendModeSelect}`);
    }, [model, blendModeSelect, lockedSystems, showToast]);

    /** Pull a block's colors into the working palette — Quartz's "click a swatch
     *  to steal it" gesture, the fastest way to build a matching ramp. */
    const pickColors = useCallback(
        (colors: ColorKeyframe[]) => {
            if (colors.length === 0) return;
            setPalette(colors.map((c) => [...c.rgba] as Vec4));
            showToast('info', `Palette set from ${colors.length} keyframe(s)`);
        },
        [showToast],
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
                palette.map((c, i) => ({
                    vec4: c,
                    time: palette.length <= 1 ? 0 : i / (palette.length - 1),
                })),
                {
                    mode,
                    ignoreBlackWhite,
                    preserveAlpha,
                    hslShift,
                    hueTarget: mode === 'shift-hue' ? hueTarget : null,
                    // A fresh seed per click so repeated random runs differ.
                    seed: Math.floor(Math.random() * 0xffffffff) + 1,
                },
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
        palette,
        mode,
        ignoreBlackWhite,
        preserveAlpha,
        hslShift,
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
            <PaletteBar
                mode={mode}
                onModeChange={setMode}
                palette={palette}
                onPaletteChange={setPalette}
                hslShift={hslShift}
                onHslShiftChange={setHslShift}
                hueTarget={hueTarget}
                onHueTargetChange={setHueTarget}
            />

            {/* Blend-mode selector + color-target toggles. */}
            <div className="paint-toolbar">
                <div className="paint-toolbar__group">
                    <span className="paint-toolbar__label">BM</span>
                    <select
                        className="dl-select paint-toolbar__bm"
                        value={blendModeSelect}
                        onChange={(e) => setBlendModeSelect(Number(e.target.value))}
                        aria-label="Blend mode to select by"
                    >
                        {[0, 1, 2, 3, 4].map((n) => (
                            <option key={n} value={n}>
                                {n}
                            </option>
                        ))}
                    </select>
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
                <input
                    type="text"
                    className="dl-input paint-search__field"
                    placeholder="Filter systems and emitters…"
                    value={searchQuery}
                    onChange={(e) => setSearchQuery(e.target.value)}
                />
                <button type="button" className="dl-btn dl-btn--ghost dl-btn--sm" onClick={selectAll}>
                    All
                </button>
                <button type="button" className="dl-btn dl-btn--ghost dl-btn--sm" onClick={selectNone}>
                    None
                </button>
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
                onPickColors={pickColors}
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
                            {' '}
                            ● unsaved
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
                        disabled={
                            selectedEmitterKeys.length === 0 ||
                            (modeUsesPalette(mode) && palette.length === 0)
                        }
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
