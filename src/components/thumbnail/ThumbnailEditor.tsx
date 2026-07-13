import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '../../lib/api/file';
import '../../styles/design-lab.css';
import '../../styles/thumbnail.css';
import { createHistory } from '../../lib/thumbnail/history';
import { Layer, ModelLayer, makeDefaultEnvLayer, removeLayer, reorderGroup, reorderLayer, toggleLock, updateLayer } from '../../lib/thumbnail/layers';
import { loadPreset, presetToLayers, PresetId } from '../../lib/thumbnail/preset';
import { buildPresetFile, parsePresetFile, PresetFile, suggestPresetFilename } from '../../lib/thumbnail/presetFile';
import { loadStoredPresets, saveStoredPresets } from '../../lib/thumbnail/presetStore';
import { composeThumbnail, ExportFormat, resolveOutputSize } from '../../lib/thumbnail/export';
import { saveThumbnail } from '../../lib/api/thumbnail';
import { openProject } from '../../lib/api/project';
import { useNotificationStore } from '../../lib/stores';
import { ThumbnailArtboard, ThumbnailArtboardHandle } from './ThumbnailArtboard';
import { LayersPanel } from './LayersPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { HuePopover } from './HuePopover';
import { SavePresetModal } from './SavePresetModal';
import { DlButton, DlIcon, DlIconButton, DlMenu, DlSelect } from '../ui/design-lab';

type ExportFormatId = 'webp' | 'png' | 'jpg';
type ExportRatioId = '16:9' | '16:10' | '4:3' | '1:1';

const FORMAT_MIME: Record<ExportFormatId, ExportFormat> = {
  webp: 'image/webp',
  png: 'image/png',
  jpg: 'image/jpeg',
};

// Default preset id + starting hue for the seed layer stack (before any
// preset has been explicitly applied) — matches riot.json's own hue so the
// initial look is consistent with picking "Riot" from the dropdown.
const DEFAULT_PRESET: PresetId = 'riot';
const DEFAULT_HUE = 210;

// Per-style default for the bottom-right corner glow (0-100): Riot has NONE,
// Divine gets the poster bloom. Applied on preset swap (and matches the initial
// state, since Riot is the default).
const PRESET_CORNER_GLOW: Record<PresetId, number> = { riot: 0, divine: 45 };

// The default opening composition — the Riot style, dev-tuned in
// `riot-base.thumbnail.json`. Layer stack, front → back:
//   title → subtitle → hero → disc → full body → map env.
// Text/disc values come from the shipped riot.json (so they stay in sync); the
// two models + the map env are seeded here (presets are model/env-agnostic).
// The hero sits IN FRONT of the disc, the disc in front of the full body.
function seedLayers(sknPath: string): Layer[] {
  const riotLayers = presetToLayers(loadPreset('riot'));
  const textLayers = riotLayers.filter(l => l.type === 'text');
  const discLayer = riotLayers.find(l => l.type === 'disc');
  const hero: Layer = {
    id: 'hero',
    type: 'model',
    name: 'Hero — big',
    hidden: false,
    rot: 0,
    locked: false,
    // Large box overlapping the disc, head-focus. Hero scale = 250.
    x: 257, y: -2, w: 385, h: 363,
    sknPath,
    anim: '',
    frame: 0,
    maxFrame: 0,
    scale: 250,
    orbit: 0,
    focusMode: 'head',
  };
  const fullbody: Layer = {
    id: 'fullbody',
    type: 'model',
    name: 'Full body',
    hidden: false,
    rot: 0,
    locked: false,
    // Full-body companion spawns straight-on (level camera). Dev-tuned
    // defaults: scale 1.10x, Turn Y -20, Tilt X -1, moved in 3D
    // (X -44, Y -17, Z 50 depth).
    x: 2, y: 2, w: 398, h: 354,
    sknPath,
    anim: '',
    frame: 0,
    maxFrame: 0,
    scale: 110,
    orbit: -20,
    tiltX: -1,
    posX: -44,
    posY: -17,
    posZ: 50,
    focusMode: 'full',
    shadow: false,
  };
  // Match riot-base.thumbnail.json exactly: title, subtitle, hero, disc,
  // fullbody, env.
  return [
    ...textLayers,
    hero,
    ...(discLayer ? [discLayer] : []),
    fullbody,
    makeDefaultEnvLayer(),
  ];
}

/** Carry the current 3D map env across a preset swap. Presets ship no env
 *  layer, so replacing the stack would drop the map. If `next` already has an
 *  env (e.g. an imported preset that includes one) keep it as-is; otherwise
 *  append the current stack's env at the back. */
function mergeEnv(next: Layer[], current: Layer[]): Layer[] {
  if (next.some(l => l.type === 'env')) return next;
  const env = current.find(l => l.type === 'env');
  return env ? [...next, env] : next;
}

export function ThumbnailEditor({ project, skn }: { project: string; skn: string }) {
  const history = useMemo(() => createHistory(seedLayers(skn)), []);
  const [, forceRender] = useState(0);
  const [selId, setSelId] = useState<string | null>('hero');
  // Global mod-hue theme (Task 12). Seeded from the default preset's hue;
  // applying a preset re-seeds it from that preset's own `hue` field.
  const [preset, setPreset] = useState<PresetId>(DEFAULT_PRESET);
  const [hue, setHue] = useState<number>(DEFAULT_HUE);
  // Global vignette strength (0-100) — a cinematic edge-darkening over the whole
  // composition. Default subtle.
  const [vignette, setVignette] = useState<number>(35);
  // Bottom-right corner glow strength (0-100) — a soft hue-tinted radial bloom
  // in the lower-right corner (matches the reference splash). It's a STYLE
  // thing, driven by the preset: OFF for Riot (default), on for Divine. Set
  // per-preset on apply; the slider still lets the user override it.
  const [cornerGlow, setCornerGlow] = useState<number>(0);
  // Loading overlay: true until the artboard reports the initial models loaded.
  // The build renders behind it (dimmed) so it feels like it's coming together.
  const [loading, setLoading] = useState(true);
  // Safety: never trap the user behind the overlay if a model fails to load.
  useEffect(() => {
    const t = setTimeout(() => setLoading(false), 12000);
    return () => clearTimeout(t);
  }, []);
  const artboardControlsRef = useRef<ThumbnailArtboardHandle | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const layersSecRef = useRef<HTMLDivElement>(null);

  // Export (Task 13). Default format is WebP per the brief. Output ratio is
  // fixed to the artboard's native 16:9 (the ratio picker was removed — the
  // composition canvas is 640×360, so any other ratio would letterbox/crop).
  const [exportFormat, setExportFormat] = useState<ExportFormatId>('webp');
  const exportRatio: ExportRatioId = '16:9';
  const [exporting, setExporting] = useState(false);
  // Export/import/save status is surfaced through the standard Flint toast
  // popups (mounted by ThumbnailWindow's ToastContainer), not an inline banner.
  const showToast = useNotificationStore((s) => s.showToast);

  // Resolved project names for the auto-fill, cached so preset swaps can re-fill
  // (a fresh preset re-seeds placeholder text). Populated on first open.
  const projectNamesRef = useRef<{ title: string; champion: string }>({ title: '', champion: '' });

  // Fill any text layer STILL holding its role placeholder with the project's
  // mod/champion name. Role-based (NOT hardcoded ids), so every preset behaves
  // the same and user-edited text is never clobbered. Returns the (possibly
  // unchanged) layer list.
  const fillRoles = useCallback((layers: Layer[]): Layer[] => {
    const names = projectNamesRef.current;
    const PLACEHOLDERS: Record<'title' | 'champion', string> = { title: 'MOD NAME', champion: 'Champion' };
    let next = layers;
    for (const l of layers) {
      if (l.type !== 'text' || !l.role) continue;
      const value = names[l.role];
      if (value && l.text === PLACEHOLDERS[l.role]) {
        next = updateLayer(next, l.id, { text: value } as Partial<Layer>);
      }
    }
    return next;
  }, []);

  // Auto-fill the mod name / champion name from the project on first open.
  const autoFilledRef = useRef(false);
  useEffect(() => {
    if (autoFilledRef.current || !project) return;
    autoFilledRef.current = true;
    (async () => {
      try {
        const p = await openProject(project);
        const modName = (p.display_name || p.name || '').trim();
        const champ = (p.champion || '').trim();
        const champName = champ
          ? champ.charAt(0).toUpperCase() + champ.slice(1)
          : (p.creator || '').trim();
        projectNamesRef.current = { title: modName, champion: champName };
        const next = fillRoles(history.get());
        if (next !== history.get()) {
          history.set(next, false);
          forceRender(n => n + 1);
        }
      } catch {
        // No project / unreadable config — keep the preset placeholders.
      }
    })();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // User presets: built-in styles plus any the user saved/imported. Saved
  // presets PERSIST across window reopens (localStorage via presetStore). Each
  // carries a STABLE id (not its array index) so the picker value stays valid.
  const [userPresets, setUserPresets] = useState<{ id: string; file: PresetFile }[]>(() => loadStoredPresets());
  const presetIdRef = useRef(Date.now());
  const [showSavePreset, setShowSavePreset] = useState(false);
  const addUserPreset = useCallback((file: PresetFile) => {
    const id = `user-${presetIdRef.current++}`;
    setUserPresets(prev => {
      const next = [...prev, { id, file }];
      saveStoredPresets(next);
      return next;
    });
  }, []);
  const deleteUserPreset = useCallback((id: string) => {
    setUserPresets(prev => {
      const next = prev.filter(p => p.id !== id);
      saveStoredPresets(next);
      return next;
    });
  }, []);

  const layers = history.get();

  const handleChange = (next: Layer[], record: boolean) => {
    history.set(next, record);
    forceRender(n => n + 1);
  };

  const handleBeginGesture = useCallback(() => {
    history.begin();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleCommitGesture = useCallback(() => {
    history.commitGesture();
    forceRender(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleDeleteLayer = useCallback((id: string) => {
    const next = removeLayer(history.get(), id);
    history.set(next, true);
    setSelId(prev => (prev === id ? next[0]?.id ?? null : prev));
    forceRender(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleHidden = useCallback((id: string) => {
    const current = history.get();
    const target = current.find(l => l.id === id);
    if (!target) return;
    const next = updateLayer(current, id, { hidden: !target.hidden } as Partial<Layer>);
    history.set(next, true);
    forceRender(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handleToggleLock = useCallback((id: string) => {
    const next = toggleLock(history.get(), id);
    history.set(next, true);
    forceRender(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Drag-reorder in the Layers panel: move `id` before `beforeId` (null = end).
  // Array order IS z-order (earlier = on top), so this restacks the layers.
  const handleReorder = useCallback((id: string, beforeId: string | null) => {
    const next = reorderLayer(history.get(), id, beforeId);
    if (next === history.get()) return;
    history.set(next, true);
    forceRender(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Move a whole category group (a run of layer ids) before `beforeId`.
  const handleReorderGroup = useCallback((ids: string[], beforeId: string | null) => {
    const next = reorderGroup(history.get(), ids, beforeId);
    if (next === history.get()) return;
    history.set(next, true);
    forceRender(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  const handlePropsChange = useCallback((patch: Partial<Layer>, record: boolean) => {
    if (!selId) return;
    const next = updateLayer(history.get(), selId, patch);
    history.set(next, record);
    forceRender(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId]);

  // Swap the whole layer stack for a shipped preset. A preset's `model`
  // layer(s) (if any) ship with an empty `sknPath` (presets are hero-model
  // agnostic — see divine.json) — filled in with the CURRENT hero's SKN so
  // the picker never blanks out the loaded model. If the preset has no
  // model layer at all (riot.json: disc + text only, per the saved
  // reference), the current model layer(s) are carried over unchanged so
  // switching to Riot never drops the hero model from the stage.
  const handleApplyPreset = useCallback((id: PresetId) => {
    const loaded = loadPreset(id);
    const presetLayers = presetToLayers(loaded);
    const hasModelLayer = presetLayers.some(l => l.type === 'model');
    const current = history.get();
    const currentModels = current.filter((l): l is ModelLayer => l.type === 'model');

    const filled = presetLayers.map(l =>
      l.type === 'model' && !l.sknPath
        ? { ...l, sknPath: currentModels[0]?.sknPath ?? skn }
        : l
    );
    const withModels = hasModelLayer ? filled : [...filled, ...currentModels];
    // The 3D map env is ENVIRONMENT, not style — carry the current env layer
    // across preset swaps (presets don't ship one, so switching would otherwise
    // drop the map from the stage). Keep it at the back (append).
    const withEnv = mergeEnv(withModels, current);
    // Re-apply the auto-filled mod/champion names (the fresh preset re-seeds
    // placeholder text).
    const next = fillRoles(withEnv);

    history.set(next, true);
    setSelId(next.find(l => l.type === 'model')?.id ?? next[0]?.id ?? null);
    setPreset(id);
    setHue(loaded.hue);
    setCornerGlow(PRESET_CORNER_GLOW[id]); // Riot: off, Divine: on
    forceRender(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skn, fillRoles]);

  // Apply a user-saved / imported preset file. Same model-fill behaviour as
  // handleApplyPreset: preset model layers ship with an empty sknPath, so we
  // reuse the current hero's SKN; presets with no model layer keep the
  // current models on stage.
  const applyPresetFile = useCallback((file: PresetFile) => {
    const hasModelLayer = file.layers.some(l => l.type === 'model');
    const current = history.get();
    const currentModels = current.filter((l): l is ModelLayer => l.type === 'model');
    const filled = file.layers.map(l =>
      l.type === 'model' && !l.sknPath
        ? { ...l, sknPath: currentModels[0]?.sknPath ?? skn }
        : l
    );
    const withModels = hasModelLayer ? filled : [...filled, ...currentModels];
    // Preserve the current 3D map env (environment, not style) unless the
    // imported preset file explicitly carries one.
    const withEnv = mergeEnv(withModels, current);
    const next = fillRoles(withEnv);
    history.set(next, true);
    setSelId(next.find(l => l.type === 'model')?.id ?? next[0]?.id ?? null);
    setPreset(file.base);
    setHue(file.hue);
    setCornerGlow(PRESET_CORNER_GLOW[file.base]); // Riot: off, Divine: on
    forceRender(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skn, fillRoles]);

  // Unified preset picker: built-in ids + any user preset (keyed by stable id).
  const handlePresetPick = useCallback((value: string) => {
    if (value === 'riot' || value === 'divine') {
      handleApplyPreset(value);
      return;
    }
    const entry = userPresets.find(p => p.id === value);
    if (entry) applyPresetFile(entry.file);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [handleApplyPreset, applyPresetFile, userPresets]);

  // Build the current composition into a portable preset file (shared by
  // "Save preset" — kept in the session list — and "Export preset" — written
  // to a user-chosen .json on disk).
  const currentAsPresetFile = useCallback((name: string): PresetFile => {
    const fontLayer = history.get().find((l): l is Extract<Layer, { type: 'text' }> => l.type === 'text');
    return buildPresetFile({
      name,
      base: preset,
      font: fontLayer?.font ?? 'Beaufort for LOL',
      hue,
      layers: history.get(),
    });
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [preset, hue]);

  const handleSavePreset = useCallback((name: string) => {
    const file = currentAsPresetFile(name);
    addUserPreset(file);
    setShowSavePreset(false);
    showToast('success', `Saved preset "${file.name}" — pick it from the preset menu.`);
  }, [currentAsPresetFile, addUserPreset]);

  const handleExportPreset = useCallback(async () => {
    const defaultName = skn.split(/[\\/]/).pop()?.replace(/\.skn$/i, '') || 'preset';
    const outputPath = await save({
      title: 'Export Preset',
      defaultPath: suggestPresetFilename(defaultName),
      filters: [{ name: 'Thumbnail Preset', extensions: ['json'] }],
    });
    if (!outputPath) return;
    try {
      const file = currentAsPresetFile(defaultName);
      await writeTextFile(outputPath, JSON.stringify(file, null, 2));
      showToast('success', `Exported preset to ${outputPath}`);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Preset export failed');
    }
  }, [skn, currentAsPresetFile]);

  const handleImportPreset = useCallback(async () => {
    const picked = await open({
      title: 'Import Preset',
      multiple: false,
      filters: [{ name: 'Thumbnail Preset', extensions: ['json'] }],
    });
    if (!picked || typeof picked !== 'string') return;
    try {
      const text = await readTextFile(picked);
      const file = parsePresetFile(text);
      applyPresetFile(file);
      addUserPreset(file);
      showToast('success', `Imported and applied "${file.name}".`);
    } catch (err) {
      showToast('error', err instanceof Error ? err.message : 'Preset import failed');
    }
  }, [applyPresetFile, addUserPreset]);

  // Export the current stage as a composited poster (Task 13). Deselects
  // first so the sel-overlay handles never influence the artboard's own
  // internal state, though composeThumbnail never reads DOM selection —
  // this is just to avoid a distracting "still selected" state on return.
  const handleExport = useCallback(async () => {
    const scene = artboardControlsRef.current?.getScene();
    if (!scene) {
      showToast('error', 'Scene not ready yet — try again in a moment.');
      return;
    }

    const projectName = skn.split(/[\\/]/).pop()?.replace(/\.skn$/i, '') || 'thumbnail';
    const outputPath = await save({
      title: 'Export Thumbnail',
      defaultPath: `${projectName}.${exportFormat}`,
      filters: [{ name: exportFormat.toUpperCase(), extensions: [exportFormat] }],
    });
    if (!outputPath) return;

    setExporting(true);
    try {
      const { w, h } = resolveOutputSize(exportRatio);
      const blob = await composeThumbnail({
        scene,
        mapScene: artboardControlsRef.current?.getMapScene() ?? null,
        layers: history.get(),
        preset,
        hue,
        vignette,
        cornerGlow,
        outW: w,
        outH: h,
        format: FORMAT_MIME[exportFormat],
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await saveThumbnail(bytes, outputPath);
      showToast('success', `Exported to ${outputPath}`);
    } catch (err) {
      console.error('Thumbnail export failed:', err);
      showToast('error', err instanceof Error ? err.message : 'Export failed');
    } finally {
      setExporting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skn, exportFormat, exportRatio, preset, hue, vignette, cornerGlow]);

  // ── Draggable Layers/Properties divider (ports the prototype's #sideSplit). ──
  const handleSplitPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const sidebar = sidebarRef.current;
      const lsec = layersSecRef.current;
      if (!sidebar || !lsec) return;
      // Height of the Layers section = pointer Y minus the SECTION's own top
      // (not the sidebar's — the section may sit below other panels, which was
      // the source of the divider "teleport" jump). Clamp within the sidebar.
      const sidebarRect = sidebar.getBoundingClientRect();
      const lsecTop = lsec.getBoundingClientRect().top;
      let h = ev.clientY - lsecTop;
      const maxH = sidebarRect.bottom - lsecTop - 120; // leave room for props
      h = Math.max(80, Math.min(maxH, h));
      lsec.style.flex = `0 0 ${h}px`;
      lsec.style.maxHeight = 'none';
    };
    const onUp = () => {
      window.removeEventListener('pointermove', onMove);
      window.removeEventListener('pointerup', onUp);
    };
    window.addEventListener('pointermove', onMove);
    window.addEventListener('pointerup', onUp);
  }, []);

  const undo = () => {
    history.undo();
    if (!history.get().find(l => l.id === selId)) setSelId(history.get()[0]?.id ?? null);
    forceRender(n => n + 1);
  };
  const redo = () => {
    history.redo();
    if (!history.get().find(l => l.id === selId)) setSelId(history.get()[0]?.id ?? null);
    forceRender(n => n + 1);
  };

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;

      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'z') {
        e.preventDefault();
        if (e.shiftKey) redo(); else undo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'y') {
        e.preventDefault();
        redo();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '0') {
        e.preventDefault();
        artboardControlsRef.current?.fitView();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '1') {
        e.preventDefault();
        artboardControlsRef.current?.fullView();
        return;
      }
      if ((e.ctrlKey || e.metaKey) && e.key === '9') {
        e.preventDefault();
        artboardControlsRef.current?.fitSelection();
        return;
      }
      if (!editing && (e.key === 'Delete' || e.key === 'Backspace') && selId) {
        e.preventDefault();
        handleDeleteLayer(selId);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId, layers]);

  const selectedLayer = layers.find(l => l.id === selId) ?? null;

  return (
    <div className="dl-root" style={{ height: '100vh', display: 'flex', flexDirection: 'column', position: 'relative' }}>
      {loading && (
        <div className="tb-loading" aria-live="polite">
          <div className="tb-loading__spinner" />
          <div className="tb-loading__label">Loading models & scene…</div>
        </div>
      )}
      <div className="tb-toolbar">
        <span className="tb-toolbar__title"><DlIcon name="picture" size={16} />Thumbnail Creator</span>
        <span className="dl-badge">{skn.split(/[\\/]/).pop()}</span>

        <div className="tb-toolbar__group">
          <DlSelect
            width={150}
            title="Apply a preset"
            placeholder="Preset…"
            value={preset}
            onChange={handlePresetPick}
            options={[
              { value: 'riot', label: 'Riot style', icon: 'color-palette' },
              { value: 'divine', label: 'Divine style', icon: 'color-palette' },
              ...userPresets.map(p => ({ value: p.id, label: p.file.name, icon: 'save' as const })),
            ]}
          />
          <DlButton icon="save" variant="secondary" title="Save the current layout as a local preset" onClick={() => setShowSavePreset(true)}>Save</DlButton>
          <DlMenu
            title="Import / export / manage presets"
            menuWidth={240}
            items={[
              { label: 'Export preset to file…', icon: 'export', onClick: handleExportPreset },
              { label: 'Import preset from file…', icon: 'import', onClick: handleImportPreset },
              ...(userPresets.length > 0
                ? [{ divider: true as const, label: '', onClick: () => {} },
                   ...userPresets.map(p => ({
                     label: `Delete "${p.file.name}"`,
                     icon: 'trash' as const,
                     danger: true,
                     onClick: () => deleteUserPreset(p.id),
                   }))]
                : []),
            ]}
          />
        </div>

        <div style={{ flex: 1 }} />

        <div className="tb-toolbar__group">
          <DlSelect
            width={100}
            title="Output format"
            value={exportFormat}
            onChange={(v) => setExportFormat(v as ExportFormatId)}
            options={[
              { value: 'webp', label: 'WebP' },
              { value: 'png', label: 'PNG' },
              { value: 'jpg', label: 'JPG' },
            ]}
          />
          <DlButton variant="primary" icon="picture" loading={exporting} onClick={handleExport} title="Export composited poster">
            {exporting ? 'Exporting…' : 'Export'}
          </DlButton>
        </div>
      </div>
      <div style={{ flex: 1, display: 'flex', minHeight: 0 }}>
        <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
          <ThumbnailArtboard
            layers={layers}
            selId={selId}
            onSelect={setSelId}
            onChange={handleChange}
            onBeginGesture={handleBeginGesture}
            onCommitGesture={handleCommitGesture}
            controlsRef={artboardControlsRef}
            preset={preset}
            hue={hue}
            vignette={vignette}
            cornerGlow={cornerGlow}
            onReady={() => setLoading(false)}
          />
          {/* Theme-hue swatch button — top-right of the artboard, opens the hue
              slider in an anchored popover (like the model mesh/anim popup). */}
          <div className="tb-hue-anchor">
            <HuePopover hue={hue} onChange={setHue} vignette={vignette} onVignetteChange={setVignette} cornerGlow={cornerGlow} onCornerGlowChange={setCornerGlow} />
          </div>
          {/* Floating zoom + history controls, anchored bottom-left of the canvas. */}
          <div className="tb-floatbar">
            <div className="tb-floatbar__group">
              <DlButton size="sm" variant="ghost" onClick={() => artboardControlsRef.current?.fitView()} title="Fit artboard (Ctrl+0)">Fit</DlButton>
              <DlButton size="sm" variant="ghost" onClick={() => artboardControlsRef.current?.fullView()} title="Zoom to 100% (Ctrl+1)">100%</DlButton>
              <DlButton size="sm" variant="ghost" onClick={() => artboardControlsRef.current?.fitSelection()} title="Fit selection (Ctrl+9)">Fit sel</DlButton>
            </div>
            <div className="tb-floatbar__group">
              <DlIconButton size="sm" icon="history" title="Redo (Ctrl+Shift+Z)" disabled={!history.canRedo()} onClick={redo} className="tb-redo" />
              <DlIconButton size="sm" icon="history" title="Undo (Ctrl+Z)" disabled={!history.canUndo()} onClick={undo} />
            </div>
          </div>
        </div>
        <div className="tb-sidebar" ref={sidebarRef}>
          <LayersPanel
            sectionRef={layersSecRef}
            layers={layers}
            selId={selId}
            onSelect={setSelId}
            onToggleHidden={handleToggleHidden}
            onToggleLock={handleToggleLock}
            onDelete={handleDeleteLayer}
            onReorder={handleReorder}
            onReorderGroup={handleReorderGroup}
          />
          <div className="tb-side-split" title="Drag to resize" onPointerDown={handleSplitPointerDown} />
          <PropertiesPanel
            layer={selectedLayer}
            onChange={handlePropsChange}
            onBeginGesture={handleBeginGesture}
            onCommitGesture={handleCommitGesture}
          />
        </div>
      </div>
      {project ? null : (
        <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--text-muted)' }}>No project path provided</div>
      )}
      {showSavePreset && (
        <SavePresetModal
          initialName={skn.split(/[\\/]/).pop()?.replace(/\.skn$/i, '') || 'My preset'}
          onSave={handleSavePreset}
          onClose={() => setShowSavePreset(false)}
        />
      )}
    </div>
  );
}
