import { useEffect, useMemo, useRef, useState } from 'react';
import '../../styles/design-lab.css';
import { createHistory } from '../../lib/thumbnail/history';
import { Layer } from '../../lib/thumbnail/layers';
import { ThumbnailArtboard, ThumbnailArtboardHandle } from './ThumbnailArtboard';

function seedLayers(): Layer[] {
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
      sknPath: '',
      anim: 'idle1.anm',
      frame: 0,
      maxFrame: 120,
      scale: 100,
      orbit: 0,
    },
  ];
}

export function ThumbnailEditor({ project, skn }: { project: string; skn: string }) {
  const history = useMemo(() => createHistory(seedLayers()), []);
  const [, forceRender] = useState(0);
  const [selId, setSelId] = useState<string | null>('hero');
  const artboardControlsRef = useRef<ThumbnailArtboardHandle | null>(null);

  const layers = history.get();

  const handleChange = (next: Layer[], record: boolean) => {
    history.set(next, record);
    forceRender(n => n + 1);
  };

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
        const next = layers.filter(l => l.id !== selId);
        history.set(next, true);
        setSelId(next[0]?.id ?? null);
        forceRender(n => n + 1);
      }
    };
    window.addEventListener('keydown', onKeyDown);
    return () => window.removeEventListener('keydown', onKeyDown);
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [selId, layers]);

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
      <div style={{ flex: 1, position: 'relative', minHeight: 0 }}>
        <ThumbnailArtboard
          layers={layers}
          selId={selId}
          onSelect={setSelId}
          onChange={handleChange}
          controlsRef={artboardControlsRef}
        />
      </div>
      {project ? null : (
        <div style={{ padding: '4px 12px', fontSize: 11, color: 'var(--text-muted)' }}>No project path provided</div>
      )}
    </div>
  );
}
