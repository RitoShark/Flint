import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { Layer, updateLayer } from '../../lib/thumbnail/layers';
import '../../styles/thumbnail.css';

// Fixed design canvas (16:9). Matches the prototype's CW/CH.
export const STAGE_W = 640;
export const STAGE_H = 360;

type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br';

export interface ThumbnailArtboardHandle {
  fitView: () => void;
  fullView: () => void;
  fitSelection: () => void;
}

interface ThumbnailArtboardProps {
  layers: Layer[];
  selId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (next: Layer[], record: boolean) => void;
  /** Ref-like escape hatch so the host (ThumbnailEditor) can trigger fit/100%/fit-selection from a toolbar or keyboard handler. */
  controlsRef?: React.MutableRefObject<ThumbnailArtboardHandle | null>;
}

// z-order within the stage, mirrors the prototype's zrank().
function zrank(layer: Layer): number {
  switch (layer.type) {
    case 'disc':
      return 20;
    case 'model':
      return 40;
    case 'deco':
      return layer.z === 'behind' ? 12 : 65;
    case 'text':
      return 80;
    default:
      return 50;
  }
}

export function ThumbnailArtboard({ layers, selId, onSelect, onChange, controlsRef }: ThumbnailArtboardProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoomLabel, setZoomLabel] = useState('100%');

  // Live refs mirroring state so pointer-event handlers (added once, closed over
  // stale state otherwise) always read the latest values without re-binding.
  const zoomRef = useRef(zoom);
  const panRef = useRef(pan);
  const layersRef = useRef(layers);
  const selIdRef = useRef(selId);
  zoomRef.current = zoom;
  panRef.current = pan;
  layersRef.current = layers;
  selIdRef.current = selId;

  const applyPanZoom = useCallback((nz: number, npx: number, npy: number) => {
    zoomRef.current = nz;
    panRef.current = { x: npx, y: npy };
    setZoom(nz);
    setPan({ x: npx, y: npy });
    setZoomLabel(`${Math.round(nz * 100)}%`);
  }, []);

  const centerOn = useCallback((cx: number, cy: number) => {
    const vp = viewportRef.current;
    if (!vp) return;
    const nz = zoomRef.current;
    const npx = vp.clientWidth / 2 - cx * nz;
    const npy = vp.clientHeight / 2 - cy * nz;
    applyPanZoom(nz, npx, npy);
  }, [applyPanZoom]);

  const fitView = useCallback(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const vw = Math.max(1, vp.clientWidth - 56);
    const vh = Math.max(1, vp.clientHeight - 56);
    const nz = Math.min(vw / STAGE_W, vh / STAGE_H);
    zoomRef.current = nz;
    setZoom(nz);
    const npx = vp.clientWidth / 2 - (STAGE_W / 2) * nz;
    const npy = vp.clientHeight / 2 - (STAGE_H / 2) * nz;
    applyPanZoom(nz, npx, npy);
  }, [applyPanZoom]);

  const fullView = useCallback(() => {
    zoomRef.current = 1;
    setZoom(1);
    centerOn(STAGE_W / 2, STAGE_H / 2);
  }, [centerOn]);

  const fitSelection = useCallback(() => {
    const vp = viewportRef.current;
    const L = layersRef.current.find(l => l.id === selIdRef.current);
    if (!vp || !L) {
      fitView();
      return;
    }
    const vw = vp.clientWidth - 80;
    const vh = vp.clientHeight - 80;
    const nz = Math.min(4, Math.max(0.2, Math.min(vw / Math.max(40, L.w), vh / Math.max(40, L.h))));
    zoomRef.current = nz;
    setZoom(nz);
    centerOn(L.x + L.w / 2, L.y + L.h / 2);
  }, [centerOn, fitView]);

  // Expose fit/100%/fit-selection to the host (toolbar / keyboard shortcuts).
  useEffect(() => {
    if (controlsRef) controlsRef.current = { fitView, fullView, fitSelection };
    return () => {
      if (controlsRef) controlsRef.current = null;
    };
  }, [controlsRef, fitView, fullView, fitSelection]);

  // ── Fit once the viewport has real dimensions. Double-rAF handles the
  // normal first paint; a ResizeObserver catches the cold-WebView case where
  // the viewport is still 0x0 on the first frames. ──
  useLayoutEffect(() => {
    let didFit = false;
    const tryFit = () => {
      const vp = viewportRef.current;
      if (!didFit && vp && vp.clientWidth > 0 && vp.clientHeight > 0) {
        fitView();
        didFit = true;
      }
    };
    const raf1 = requestAnimationFrame(() => requestAnimationFrame(tryFit));
    const ro = new ResizeObserver(() => {
      if (!didFit) tryFit();
    });
    if (viewportRef.current) ro.observe(viewportRef.current);
    return () => {
      cancelAnimationFrame(raf1);
      ro.disconnect();
    };
    // Intentionally run once on mount (fit is a one-time bootstrap, not a reactive effect).
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, []);

  // Re-center (keep zoom) on window resize, matching the prototype.
  useEffect(() => {
    const onResize = () => centerOn(STAGE_W / 2, STAGE_H / 2);
    window.addEventListener('resize', onResize);
    return () => window.removeEventListener('resize', onResize);
  }, [centerOn]);

  // ── Alt+wheel zoom toward cursor ──
  useEffect(() => {
    const vp = viewportRef.current;
    if (!vp) return;
    const onWheel = (e: WheelEvent) => {
      if (!e.altKey) return;
      e.preventDefault();
      const rect = stageWrapRef.current?.getBoundingClientRect();
      if (!rect) return;
      const z = zoomRef.current;
      const lx = (e.clientX - rect.left) / z;
      const ly = (e.clientY - rect.top) / z;
      const factor = e.deltaY < 0 ? 1.12 : 1 / 1.12;
      const nz = Math.min(6, Math.max(0.1, z * factor));
      const npx = panRef.current.x + lx * z - lx * nz;
      const npy = panRef.current.y + ly * z - ly * nz;
      applyPanZoom(nz, npx, npy);
    };
    vp.addEventListener('wheel', onWheel, { passive: false });
    return () => vp.removeEventListener('wheel', onWheel);
  }, [applyPanZoom]);

  // ── Pan: Space-held + drag OR middle-mouse drag. Shift is reserved for
  // move axis-lock / resize aspect-lock. ──
  const [spaceHeld, setSpaceHeld] = useState(false);
  const panStateRef = useRef<{ x: number; y: number; px: number; py: number } | null>(null);
  const [panning, setPanning] = useState(false);

  useEffect(() => {
    const onKeyDown = (e: KeyboardEvent) => {
      const target = e.target as HTMLElement | null;
      const editing = target?.tagName === 'INPUT' || target?.tagName === 'TEXTAREA' || target?.isContentEditable;
      if (e.code === 'Space' && !editing) {
        setSpaceHeld(true);
        e.preventDefault();
      }
    };
    const onKeyUp = (e: KeyboardEvent) => {
      if (e.code === 'Space') setSpaceHeld(false);
    };
    window.addEventListener('keydown', onKeyDown);
    window.addEventListener('keyup', onKeyUp);
    return () => {
      window.removeEventListener('keydown', onKeyDown);
      window.removeEventListener('keyup', onKeyUp);
    };
  }, []);

  const handleViewportPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      panStateRef.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y };
      setPanning(true);
      (e.target as Element).setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    // Click on empty viewport/stage-wrap background clears selection.
    const targetEl = e.target as HTMLElement;
    if ((targetEl === viewportRef.current || targetEl.classList.contains('tb-stage-wrap')) && !spaceHeld && e.button === 0) {
      onSelect(null);
    }
  }, [spaceHeld, onSelect]);

  const handleViewportPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!panning || !panStateRef.current) return;
    const s = panStateRef.current;
    applyPanZoom(zoomRef.current, s.px + (e.clientX - s.x), s.py + (e.clientY - s.y));
  }, [panning, applyPanZoom]);

  const handleViewportPointerUp = useCallback(() => {
    setPanning(false);
    panStateRef.current = null;
  }, []);

  // Env background click also clears selection (mirrors the prototype's env pointerdown).
  const handleEnvPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!spaceHeld && e.button === 0) onSelect(null);
  }, [spaceHeld, onSelect]);

  // ── Drag-move (startMove port) ──
  const startMove = useCallback((e: React.PointerEvent<HTMLDivElement>, layer: Layer) => {
    if (layer.locked) return;
    e.preventDefault();
    const sx = e.clientX, sy = e.clientY, ox = layer.x, oy = layer.y;
    const el = e.currentTarget;
    el.classList.add('dragging');
    el.setPointerCapture(e.pointerId);

    const mv = (ev: PointerEvent) => {
      const stageEl = stageRef.current;
      if (!stageEl) return;
      const s = stageEl.getBoundingClientRect().width / STAGE_W;
      let ddx = (ev.clientX - sx) / s;
      let ddy = (ev.clientY - sy) / s;
      if (ev.shiftKey) {
        if (Math.abs(ddx) >= Math.abs(ddy)) ddy = 0;
        else ddx = 0;
      }
      const nx = Math.round(ox + ddx);
      const ny = Math.round(oy + ddy);
      const next = updateLayer(layersRef.current, layer.id, { x: nx, y: ny } as Partial<Layer>);
      layersRef.current = next;
      onChange(next, false);
    };
    const up = () => {
      el.classList.remove('dragging');
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      onChange(layersRef.current, true);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }, [onChange]);

  // ── Corner resize (startResize port) ──
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>, layer: Layer, handle: ResizeHandle) => {
    if (layer.locked) return;
    e.preventDefault();
    e.stopPropagation();
    const sx = e.clientX, sy = e.clientY;
    const { x, y, w, h } = layer;
    const aspect = w / Math.max(1, h);
    const stageEl = stageRef.current;
    const s = stageEl ? stageEl.getBoundingClientRect().width / STAGE_W : 1;

    const mv = (ev: PointerEvent) => {
      const dx = (ev.clientX - sx) / s;
      const dy = (ev.clientY - sy) / s;
      let nw = handle.includes('l') ? w - dx : w + dx;
      let nh = handle.includes('t') ? h - dy : h + dy;
      nw = Math.max(12, nw);
      nh = Math.max(12, nh);
      if (ev.shiftKey) nh = Math.round(nw / aspect);
      // Recompute left/top so the opposite corner stays pinned.
      const nx = handle.includes('l') ? x + (w - nw) : x;
      const ny = handle.includes('t') ? y + (h - nh) : y;
      const next = updateLayer(layersRef.current, layer.id, {
        x: Math.round(nx), y: Math.round(ny), w: Math.round(nw), h: Math.round(nh),
      } as Partial<Layer>);
      layersRef.current = next;
      onChange(next, false);
    };
    const up = () => {
      window.removeEventListener('pointermove', mv);
      window.removeEventListener('pointerup', up);
      onChange(layersRef.current, true);
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }, [onChange]);

  const handleElPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, layer: Layer) => {
    if (panning) return;
    if (selIdRef.current !== layer.id) onSelect(layer.id);
    if (layer.locked) return;
    startMove(e, layer);
  }, [panning, onSelect, startMove]);

  // Inline text editing (dblclick), mirrors the prototype's contenteditable flow.
  const handleTextDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>, layer: Layer) => {
    if (layer.type !== 'text' || layer.locked) return;
    e.preventDefault();
    const body = e.currentTarget.querySelector('.tb-body') as HTMLDivElement | null;
    if (!body) return;
    body.style.pointerEvents = 'auto';
    body.contentEditable = 'true';
    body.focus();
    const range = document.createRange();
    range.selectNodeContents(body);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    const done = () => {
      body.contentEditable = 'false';
      body.style.pointerEvents = 'none';
      const next = updateLayer(layersRef.current, layer.id, { text: body.textContent ?? '' } as Partial<Layer>);
      layersRef.current = next;
      onChange(next, true);
    };
    body.addEventListener('blur', done, { once: true });
    body.addEventListener('keydown', (ev) => {
      if (ev.key === 'Enter') {
        ev.preventDefault();
        body.blur();
      }
    });
  }, [onChange]);

  const sorted = [...layers].filter(l => !l.hidden).sort((a, b) => zrank(a) - zrank(b));
  const selectedLayer = layers.find(l => l.id === selId) ?? null;

  return (
    <div
      className="tb-viewport"
      id="tb-viewport"
      ref={viewportRef}
      onPointerDown={handleViewportPointerDown}
      onPointerMove={handleViewportPointerMove}
      onPointerUp={handleViewportPointerUp}
      style={{ cursor: spaceHeld ? (panning ? 'grabbing' : 'grab') : undefined }}
    >
      <div className="tb-zoom-info">{zoomLabel} &middot; Alt+scroll zoom &middot; Ctrl+0 fit &middot; Ctrl+1 100%</div>
      <div
        className="tb-stage-wrap"
        ref={stageWrapRef}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        <div className="tb-stage" ref={stageRef}>
          <div className="tb-env" onPointerDown={handleEnvPointerDown}>
            <span className="tb-env-lbl">environment slot</span>
          </div>
          {sorted.map(layer => (
            <div
              key={layer.id}
              className={`tb-el ${layer.type}${layer.id === selId ? ' selected' : ''}${layer.locked ? ' locked' : ''}`}
              data-id={layer.id}
              style={{
                left: layer.x,
                top: layer.y,
                width: layer.w,
                height: layer.h,
                transform: `rotate(${layer.rot}deg)`,
              }}
              onPointerDown={(e) => handleElPointerDown(e, layer)}
              onDoubleClick={(e) => handleTextDoubleClick(e, layer)}
            >
              <LayerBody layer={layer} />
            </div>
          ))}
        </div>
        <SelOverlay
          layer={selectedLayer}
          onHandlePointerDown={startResize}
        />
      </div>
    </div>
  );
}

function LayerBody({ layer }: { layer: Layer }) {
  if (layer.type === 'text') {
    return (
      <div
        className="tb-body"
        style={{ fontSize: layer.size, fontFamily: layer.font, fontStyle: layer.italic ? 'italic' : 'normal', letterSpacing: layer.spacing }}
      >
        {layer.text}
      </div>
    );
  }
  if (layer.type === 'model') {
    // Placeholder body — real SKN preview lands in a later phase.
    return <div className="tb-body">{layer.name.split('—')[0].trim()}</div>;
  }
  if (layer.type === 'disc') {
    return <div className="tb-body" />;
  }
  // deco
  return <div className="tb-body deco-empty">{layer.asset ? '' : 'corner PNG slot'}</div>;
}

function SelOverlay({
  layer,
  onHandlePointerDown,
}: {
  layer: Layer | null;
  onHandlePointerDown: (e: React.PointerEvent<HTMLDivElement>, layer: Layer, handle: ResizeHandle) => void;
}) {
  return (
    <div className="tb-sel-overlay" id="tb-sel-overlay">
      {layer && (
        <div
          className={`tb-selbox${layer.locked ? ' locked' : ''}`}
          style={{
            left: layer.x,
            top: layer.y,
            width: layer.w,
            height: layer.h,
            transform: `rotate(${layer.rot}deg)`,
          }}
        >
          {layer.locked ? (
            <div className="tb-lockbadge">locked - pinned</div>
          ) : (
            (['tl', 'tr', 'bl', 'br'] as ResizeHandle[]).map(h => (
              <div
                key={h}
                className={`tb-hnd ${h}`}
                data-h={h}
                onPointerDown={(e) => {
                  e.stopPropagation();
                  onHandlePointerDown(e, layer, h);
                }}
              />
            ))
          )}
        </div>
      )}
    </div>
  );
}
