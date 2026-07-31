import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import * as api from '../../../lib/api';
import { useNotificationStore } from '../../../lib/stores';
import { PaletteBar, modeUsesPalette } from './PaletteBar';
import { SystemList } from './SystemList';
import type { Vec4 } from '../../../lib/paint/colorMath';
import type {
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
    [0.85, 0.1, 0.2, 1],
    [0.15, 0.35, 0.9, 1],
];

const TARGET_TOGGLES: Array<[Exclude<ColorTargetId, 'all'>, string]> = [
    ['color', 'Color'],
    ['birthColor', 'BC'],
    ['fresnelColor', 'OC'],
    ['lingerColor', 'LC'],
];

export const PaintPanel: React.FC<PaintPanelProps> = ({ binPath, onSaved }) => {
    const showToast = useNotificationStore((s) => s.showToast);

    const [sessionId, setSessionId] = useState<number | null>(null);
    const [model, setModel] = useState<VfxModel | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [dirty, setDirty] = useState(false);
    const [saving, setSaving] = useState(false);

    const [selected, setSelected] = useState<Set<string>>(new Set());
    const [expanded, setExpanded] = useState<Set<string>>(new Set());
    const [filter, setFilter] = useState('');

    const [mode, setMode] = useState<RecolorModeId>('linear');
    const [palette, setPalette] = useState<Vec4[]>(DEFAULT_PALETTE);
    const [hslShift, setHslShift] = useState<[number, number, number]>([0, 0, 0]);
    const [hueTarget, setHueTarget] = useState(0);
    const [targets, setTargets] = useState<Set<ColorTargetId>>(
        new Set<ColorTargetId>(['color', 'birthColor', 'fresnelColor', 'lingerColor']),
    );
    const [ignoreBlackWhite, setIgnoreBlackWhite] = useState(true);
    const [preserveAlpha, setPreserveAlpha] = useState(true);

    // The session id the cleanup must close. Held in a ref so the unmount
    // effect closes the CURRENT session rather than one captured at mount.
    const sessionRef = useRef<number | null>(null);
    sessionRef.current = sessionId;

    useEffect(() => {
        let cancelled = false;
        setLoading(true);
        setError(null);
        setModel(null);
        setSelected(new Set());
        setDirty(false);

        api.paintOpen(binPath)
            .then((res) => {
                if (cancelled) {
                    // Unmounted mid-open: close the session we just created, or
                    // its tree would leak for the life of the process.
                    void api.paintClose(res.sessionId);
                    return;
                }
                setSessionId(res.sessionId);
                setModel(res.model);
                // Open every system by default — a collapsed tree hides the very
                // thing the panel exists to show.
                setExpanded(new Set([...res.model.systemOrder, ...res.model.materialOrder]));
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

    // Close the session only when the panel actually goes away.
    useEffect(
        () => () => {
            const id = sessionRef.current;
            if (id !== null) void api.paintClose(id);
        },
        [],
    );

    const emitterKeys = useMemo(() => [...selected], [selected]);

    const toggleEmitter = useCallback((key: string, additive: boolean) => {
        setSelected((prev) => {
            const next = additive ? new Set(prev) : new Set<string>();
            if (additive && prev.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const toggleSystem = useCallback(
        (systemKey: string) => {
            if (!model) return;
            const system = model.systems.find((s) => s.key === systemKey);
            if (!system) return;
            setSelected((prev) => {
                const next = new Set(prev);
                const allOn = system.emitterKeys.every((k) => next.has(k));
                for (const k of system.emitterKeys) {
                    if (allOn) next.delete(k);
                    else next.add(k);
                }
                return next;
            });
        },
        [model],
    );

    const toggleExpand = useCallback((key: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(key)) next.delete(key);
            else next.add(key);
            return next;
        });
    }, []);

    const selectAllVisible = useCallback(() => {
        if (!model) return;
        setSelected(new Set(model.emitters.map((e) => e.key)));
    }, [model]);

    const selectNone = useCallback(() => setSelected(new Set()), []);

    /** Patch refreshed colors into the resident model without a full refetch. */
    const patchColors = useCallback((colors: Record<string, EmitterColors>) => {
        setModel((prev) => {
            if (!prev) return prev;
            return {
                ...prev,
                emitters: prev.emitters.map((e) =>
                    colors[e.key] ? { ...e, colors: colors[e.key] } : e,
                ),
            };
        });
    }, []);

    const handleRecolor = useCallback(async () => {
        if (sessionId === null) return;
        if (emitterKeys.length === 0) {
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
                emitterKeys,
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
        emitterKeys,
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
                                      p.selectionKey === selectionKey
                                          ? { ...p, values: value }
                                          : p,
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

    const handleUndo = useCallback(async () => {
        if (sessionId === null) return;
        try {
            const next = await api.paintUndo(sessionId);
            if (!next) {
                showToast('info', 'Nothing to undo.');
                return;
            }
            setModel(next);
            setDirty(await api.paintIsDirty(sessionId));
        } catch (e) {
            showToast('error', e instanceof Error ? e.message : String(e));
        }
    }, [sessionId, showToast]);

    const handleRedo = useCallback(async () => {
        if (sessionId === null) return;
        try {
            const next = await api.paintRedo(sessionId);
            if (!next) {
                showToast('info', 'Nothing to redo.');
                return;
            }
            setModel(next);
            setDirty(await api.paintIsDirty(sessionId));
        } catch (e) {
            showToast('error', e instanceof Error ? e.message : String(e));
        }
    }, [sessionId, showToast]);

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
            showToast(
                'success',
                res.checkpointed ? 'Saved (checkpoint created)' : 'Saved',
            );
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

    return (
        <div className="paint-panel">
            <div className="paint-panel__header">
                <span className="paint-panel__stats">
                    {model.stats.systemCount} systems · {model.stats.emitterCount} emitters
                    {model.stats.materialCount > 0 && ` · ${model.stats.materialCount} materials`}
                    {selected.size > 0 && ` · ${selected.size} selected`}
                    {dirty && <span className="paint-panel__dirty" title="Unsaved changes"> ●</span>}
                </span>
                <div className="paint-panel__actions">
                    <button type="button" className="dl-btn dl-btn--ghost dl-btn--sm" onClick={handleUndo}>
                        Undo
                    </button>
                    <button type="button" className="dl-btn dl-btn--ghost dl-btn--sm" onClick={handleRedo}>
                        Redo
                    </button>
                    <button
                        type="button"
                        className="dl-btn dl-btn--primary dl-btn--sm"
                        onClick={handleSave}
                        disabled={!dirty || saving}
                        title={dirty ? 'Save the BIN (checkpoints the project first)' : 'No changes'}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </button>
                </div>
            </div>

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

            <div className="paint-panel__controls">
                <div className="paint-panel__targets">
                    {TARGET_TOGGLES.map(([id, label]) => (
                        <label key={id} className="paint-panel__target" title={`Recolor ${label}`}>
                            <input
                                type="checkbox"
                                checked={targets.has(id)}
                                onChange={() =>
                                    setTargets((prev) => {
                                        const next = new Set(prev);
                                        if (next.has(id)) next.delete(id);
                                        else next.add(id);
                                        return next;
                                    })
                                }
                            />
                            {label}
                        </label>
                    ))}
                    <label className="paint-panel__target" title="Skip pure black and pure white">
                        <input
                            type="checkbox"
                            checked={ignoreBlackWhite}
                            onChange={(e) => setIgnoreBlackWhite(e.target.checked)}
                        />
                        Ignore B/W
                    </label>
                    <label className="paint-panel__target" title="Keep each color's existing alpha">
                        <input
                            type="checkbox"
                            checked={preserveAlpha}
                            onChange={(e) => setPreserveAlpha(e.target.checked)}
                        />
                        Keep alpha
                    </label>
                </div>

                <button
                    type="button"
                    className="dl-btn dl-btn--primary dl-btn--sm"
                    onClick={handleRecolor}
                    disabled={selected.size === 0 || (modeUsesPalette(mode) && palette.length === 0)}
                    title={selected.size === 0 ? 'Select emitters first' : 'Recolor the selection'}
                >
                    Recolor
                </button>
            </div>

            <div className="paint-panel__search">
                <input
                    type="text"
                    className="dl-input paint-panel__filter"
                    placeholder="Filter systems and emitters…"
                    value={filter}
                    onChange={(e) => setFilter(e.target.value)}
                />
                <button type="button" className="dl-btn dl-btn--ghost dl-btn--sm" onClick={selectAllVisible}>
                    All
                </button>
                <button type="button" className="dl-btn dl-btn--ghost dl-btn--sm" onClick={selectNone}>
                    None
                </button>
            </div>

            <SystemList
                model={model}
                selected={selected}
                onToggleEmitter={toggleEmitter}
                onToggleSystem={toggleSystem}
                expanded={expanded}
                onToggleExpand={toggleExpand}
                onSetBlendMode={handleSetBlendMode}
                onSetMaterialParam={handleSetMaterialParam}
                filter={filter.trim().toLowerCase()}
            />
        </div>
    );
};
