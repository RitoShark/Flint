import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { open, save } from '@tauri-apps/plugin-dialog';
import { readTextFile, writeTextFile } from '../../lib/api/file';
import '../../styles/design-lab.css';
import '../../styles/thumbnail.css';
import { createHistory } from '../../lib/thumbnail/history';
import { Layer, ModelLayer, removeLayer, toggleLock, updateLayer } from '../../lib/thumbnail/layers';
import { loadPreset, presetToLayers, PresetId } from '../../lib/thumbnail/preset';
import { buildPresetFile, parsePresetFile, PresetFile, suggestPresetFilename } from '../../lib/thumbnail/presetFile';
import { composeThumbnail, ExportFormat, resolveOutputSize } from '../../lib/thumbnail/export';
import { saveThumbnail } from '../../lib/api/thumbnail';
import { ThumbnailArtboard, ThumbnailArtboardHandle } from './ThumbnailArtboard';
import { LayersPanel } from './LayersPanel';
import { PropertiesPanel } from './PropertiesPanel';
import { ThemePanel } from './ThemePanel';
import { SavePresetModal } from './SavePresetModal';
import { ModelStudioModal } from './ModelStudioModal';
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

function seedLayers(sknPath: string): Layer[] {
  return [
    {
      id: 'title',
      type: 'text',
      name: 'Title',
      hidden: false,
      rot: 0,
      locked: false,
      x: 34, y: 288, w: 280, h: 56,
      text: 'NEW SKIN',
      size: 40,
      font: 'Beaufort for LOL',
      italic: false,
      spacing: 1,
    },
    {
      id: 'hero',
      type: 'model',
      name: 'Hero — big',
      hidden: false,
      rot: 0,
      locked: false,
      x: 360, y: 40, w: 270, h: 300,
      // Primary model: wired to the window's `skn` launch param so the
      // artboard loads a real SKN on mount (see ThumbnailArtboard). Its own
      // camera viewport = this box (see studioScene.ts per-model cameras).
      sknPath,
      anim: '',
      frame: 0,
      maxFrame: 0,
      scale: 100,
      orbit: 0,
    },
    {
      id: 'fullbody',
      type: 'model',
      name: 'Full body',
      hidden: false,
      rot: 0,
      locked: false,
      // Smaller full-body model at bottom-left (the "whole body" companion to
      // the big hero), the second default model per the composition brief.
      x: 40, y: 110, w: 150, h: 230,
      sknPath,
      anim: '',
      frame: 0,
      maxFrame: 0,
      scale: 100,
      orbit: 0,
    },
  ];
}

export function ThumbnailEditor({ project, skn }: { project: string; skn: string }) {
  const history = useMemo(() => createHistory(seedLayers(skn)), []);
  const [, forceRender] = useState(0);
  const [selId, setSelId] = useState<string | null>('hero');
  // Global mod-hue theme (Task 12). Seeded from the default preset's hue;
  // applying a preset re-seeds it from that preset's own `hue` field.
  const [preset, setPreset] = useState<PresetId>(DEFAULT_PRESET);
  const [hue, setHue] = useState<number>(DEFAULT_HUE);
  const artboardControlsRef = useRef<ThumbnailArtboardHandle | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const layersSecRef = useRef<HTMLDivElement>(null);

  // Export (Task 13). Default format is WebP per the brief. Output ratio is
  // fixed to the artboard's native 16:9 (the ratio picker was removed — the
  // composition canvas is 640×360, so any other ratio would letterbox/crop).
  const [exportFormat, setExportFormat] = useState<ExportFormatId>('webp');
  const exportRatio: ExportRatioId = '16:9';
  const [exporting, setExporting] = useState(false);
  const [exportStatus, setExportStatus] = useState<{ kind: 'success' | 'error'; message: string } | null>(null);

  // User presets: built-in styles plus any the user saved/imported this session
  // (kept in memory; a saved/exported preset is also written to disk as JSON).
  // Each carries a STABLE id (not its array index) so the preset picker's
  // value stays valid if the list is ever reordered or an entry removed.
  const [userPresets, setUserPresets] = useState<{ id: string; file: PresetFile }[]>([]);
  const presetIdRef = useRef(0);
  const [showSavePreset, setShowSavePreset] = useState(false);
  const addUserPreset = useCallback((file: PresetFile) => {
    const id = `user-${presetIdRef.current++}`;
    setUserPresets(prev => [...prev, { id, file }]);
  }, []);

  // Which model layer id has the mesh & animation studio popup open (null = closed).
  const [studioLayerId, setStudioLayerId] = useState<string | null>(null);

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
    const currentModels = history.get().filter((l): l is ModelLayer => l.type === 'model');

    const filled = presetLayers.map(l =>
      l.type === 'model' && !l.sknPath
        ? { ...l, sknPath: currentModels[0]?.sknPath ?? skn }
        : l
    );
    const next = hasModelLayer ? filled : [...filled, ...currentModels];

    history.set(next, true);
    setSelId(next.find(l => l.type === 'model')?.id ?? next[0]?.id ?? null);
    setPreset(id);
    setHue(loaded.hue);
    forceRender(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skn]);

  // Apply a user-saved / imported preset file. Same model-fill behaviour as
  // handleApplyPreset: preset model layers ship with an empty sknPath, so we
  // reuse the current hero's SKN; presets with no model layer keep the
  // current models on stage.
  const applyPresetFile = useCallback((file: PresetFile) => {
    const hasModelLayer = file.layers.some(l => l.type === 'model');
    const currentModels = history.get().filter((l): l is ModelLayer => l.type === 'model');
    const filled = file.layers.map(l =>
      l.type === 'model' && !l.sknPath
        ? { ...l, sknPath: currentModels[0]?.sknPath ?? skn }
        : l
    );
    const next = hasModelLayer ? filled : [...filled, ...currentModels];
    history.set(next, true);
    setSelId(next.find(l => l.type === 'model')?.id ?? next[0]?.id ?? null);
    setPreset(file.base);
    setHue(file.hue);
    forceRender(n => n + 1);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skn]);

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
    setExportStatus({ kind: 'success', message: `Saved preset "${file.name}" — pick it from the preset menu.` });
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
      setExportStatus({ kind: 'success', message: `Exported preset to ${outputPath}` });
    } catch (err) {
      setExportStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Preset export failed' });
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
      setExportStatus({ kind: 'success', message: `Imported and applied "${file.name}".` });
    } catch (err) {
      setExportStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Preset import failed' });
    }
  }, [applyPresetFile, addUserPreset]);

  // Export the current stage as a composited poster (Task 13). Deselects
  // first so the sel-overlay handles never influence the artboard's own
  // internal state, though composeThumbnail never reads DOM selection —
  // this is just to avoid a distracting "still selected" state on return.
  const handleExport = useCallback(async () => {
    const scene = artboardControlsRef.current?.getScene();
    if (!scene) {
      setExportStatus({ kind: 'error', message: 'Scene not ready yet — try again in a moment.' });
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
    setExportStatus(null);
    try {
      const { w, h } = resolveOutputSize(exportRatio);
      const blob = await composeThumbnail({
        scene,
        layers: history.get(),
        preset,
        hue,
        outW: w,
        outH: h,
        format: FORMAT_MIME[exportFormat],
      });
      const bytes = new Uint8Array(await blob.arrayBuffer());
      await saveThumbnail(bytes, outputPath);
      setExportStatus({ kind: 'success', message: `Exported to ${outputPath}` });
    } catch (err) {
      console.error('Thumbnail export failed:', err);
      setExportStatus({ kind: 'error', message: err instanceof Error ? err.message : 'Export failed' });
    } finally {
      setExporting(false);
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [skn, exportFormat, exportRatio, preset, hue]);

  // ── Draggable Layers/Properties divider (ports the prototype's #sideSplit). ──
  const handleSplitPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    (e.target as Element).setPointerCapture(e.pointerId);
    e.preventDefault();
    const onMove = (ev: PointerEvent) => {
      const sidebar = sidebarRef.current;
      const lsec = layersSecRef.current;
      if (!sidebar || !lsec) return;
      const rect = sidebar.getBoundingClientRect();
      let h = ev.clientY - rect.top - 22; // minus the Layers header
      h = Math.max(80, Math.min(rect.height - 120, h));
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
  const studioModelLayer = studioLayerId
    ? (layers.find(l => l.id === studioLayerId && l.type === 'model') as ModelLayer | undefined) ?? null
    : null;

  return (
    <div className="dl-root" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div className="tb-toolbar">
        <span className="tb-toolbar__title"><DlIcon name="picture" size={16} />Thumbnail Creator</span>
        <span className="dl-badge">{skn.split(/[\\/]/).pop()}</span>

        <div className="tb-toolbar__group">
          <DlSelect
            width={150}
            resetAfterSelect
            title="Apply a preset"
            placeholder="Preset…"
            value={null}
            onChange={handlePresetPick}
            options={[
              { value: 'riot', label: 'Riot style', icon: 'color-palette' },
              { value: 'divine', label: 'Divine style', icon: 'color-palette' },
              ...userPresets.map(p => ({ value: p.id, label: p.file.name, icon: 'save' as const })),
            ]}
          />
          <DlMenu
            title="Preset actions"
            menuWidth={220}
            items={[
              { label: 'Save preset…', icon: 'save', onClick: () => setShowSavePreset(true) },
              { label: 'Export preset to file…', icon: 'export', onClick: handleExportPreset },
              { divider: true, label: '', onClick: () => {} },
              { label: 'Import preset from file…', icon: 'import', onClick: handleImportPreset },
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
      {exportStatus && (
        <div className={`tb-status tb-status--${exportStatus.kind}`}>
          <DlIcon name={exportStatus.kind === 'error' ? 'error' : 'success'} size={14} />
          <span>{exportStatus.message}</span>
          <button className="tb-status__close" title="Dismiss" onClick={() => setExportStatus(null)}>
            <DlIcon name="close" size={12} />
          </button>
        </div>
      )}
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
          />
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
          <ThemePanel hue={hue} onChange={setHue} />
          <LayersPanel
            sectionRef={layersSecRef}
            layers={layers}
            selId={selId}
            onSelect={setSelId}
            onToggleHidden={handleToggleHidden}
            onToggleLock={handleToggleLock}
            onDelete={handleDeleteLayer}
          />
          <div className="tb-side-split" title="Drag to resize" onPointerDown={handleSplitPointerDown} />
          <PropertiesPanel
            layer={selectedLayer}
            onChange={handlePropsChange}
            onBeginGesture={handleBeginGesture}
            onCommitGesture={handleCommitGesture}
            onOpenModelStudio={selectedLayer?.type === 'model' ? () => setStudioLayerId(selectedLayer.id) : undefined}
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
      {studioModelLayer && (
        <ModelStudioModal
          layer={studioModelLayer}
          getMeshes={() => artboardControlsRef.current?.getModelMeshes(studioModelLayer.id) ?? []}
          getClips={() => artboardControlsRef.current?.getModelAnims(studioModelLayer.id) ?? []}
          onChange={(patch, record) => {
            const next = updateLayer(history.get(), studioModelLayer.id, patch as Partial<Layer>);
            history.set(next, record);
            forceRender(n => n + 1);
          }}
          onBeginGesture={handleBeginGesture}
          onCommitGesture={handleCommitGesture}
          onClose={() => setStudioLayerId(null)}
        />
      )}
    </div>
  );
}
