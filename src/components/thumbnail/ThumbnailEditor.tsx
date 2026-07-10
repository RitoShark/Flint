import { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import '../../styles/design-lab.css';
import '../../styles/thumbnail.css';
import { createHistory } from '../../lib/thumbnail/history';
import { Layer, removeLayer, toggleLock, updateLayer } from '../../lib/thumbnail/layers';
import { ThumbnailArtboard, ThumbnailArtboardHandle } from './ThumbnailArtboard';
import { LayersPanel } from './LayersPanel';
import { PropertiesPanel } from './PropertiesPanel';

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
      x: 388, y: 70, w: 230, h: 270,
      // Primary model: wired to the window's `skn` launch param so the
      // artboard loads a real SKN on mount (see ThumbnailArtboard).
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
  const artboardControlsRef = useRef<ThumbnailArtboardHandle | null>(null);
  const sidebarRef = useRef<HTMLDivElement>(null);
  const layersSecRef = useRef<HTMLDivElement>(null);

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

  return (
    <div className="dl-root" style={{ height: '100vh', display: 'flex', flexDirection: 'column' }}>
      <div style={{ padding: 12, borderBottom: '1px solid var(--border)', display: 'flex', gap: 8, alignItems: 'center' }}>
        <strong>Thumbnail Creator</strong>
        <span className="dl-badge">{skn.split(/[\\/]/).pop()}</span>
        <div style={{ flex: 1 }} />
        <button className="dl-btn dl-btn--sm" onClick={() => artboardControlsRef.current?.fitView()} title="Fit (Ctrl+0)">Fit</button>
        <button className="dl-btn dl-btn--sm" onClick={() => artboardControlsRef.current?.fullView()} title="100% (Ctrl+1)">100%</button>
        <button className="dl-btn dl-btn--sm" onClick={() => artboardControlsRef.current?.fitSelection()} title="Fit selection (Ctrl+9)">Fit sel</button>
        <button className="dl-btn dl-btn--sm" disabled={!history.canUndo()} onClick={undo} title="Undo (Ctrl+Z)">Undo</button>
        <button className="dl-btn dl-btn--sm" disabled={!history.canRedo()} onClick={redo} title="Redo (Ctrl+Shift+Z)">Redo</button>
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
          />
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
          />
          <div className="tb-side-split" title="Drag to resize" onPointerDown={handleSplitPointerDown} />
          <PropertiesPanel
            layer={selectedLayer}
            onChange={handlePropsChange}
            onBeginGesture={handleBeginGesture}
            onCommitGesture={handleCommitGesture}
            getModelAnims={(layerId) => artboardControlsRef.current?.getModelAnims(layerId) ?? []}
          />
        </div>
      </div>
      {project ? null : (
        <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--text-muted)' }}>No project path provided</div>
      )}
    </div>
  );
}
