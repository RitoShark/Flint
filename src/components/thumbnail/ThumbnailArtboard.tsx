import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { DiscLayer, Layer, ModelLayer, TextLayer, updateLayer } from '../../lib/thumbnail/layers';
import { AnimClip, createThumbnailScene, MeshInfo, ThumbnailScene } from '../../lib/thumbnail/studioScene';
import { fitFontSize, TextMeasure } from '../../lib/thumbnail/textFit';
import { resolveTextColor, ThumbnailPresetId } from '../../lib/thumbnail/hue';
import { DiscComposite } from './DiscComposite';
import '../../styles/thumbnail.css';

// Base cream/gold text color the whole thumbnail style family shares before
// any hue theming is mixed in (was hardcoded as `.tb-el.text .tb-body`'s
// `color: #f2ead9` in thumbnail.css — that CSS rule now only supplies the
// text-shadow/layout; color is computed per-render from the hue so it can
// react live to the ThemePanel slider). One shared base for every text
// layer (title/subtitle/label alike) — simplest choice and matches what
// the CSS previously hardcoded uniformly across all text layers.
const TEXT_BASE_COLOR = '#f2ead9';

// Fixed design canvas (16:9). Matches the prototype's CW/CH.
export const STAGE_W = 640;
export const STAGE_H = 360;

type ResizeHandle = 'tl' | 'tr' | 'bl' | 'br';

export interface ThumbnailArtboardHandle {
  fitView: () => void;
  fullView: () => void;
  fitSelection: () => void;
  /** Real animation clips available for a `model` layer's currently loaded
   *  SKN (empty until the scene has finished loading it). Backs the
   *  PropertiesPanel anim dropdown. */
  getModelAnims: (layerId: string) => AnimClip[];
  /** Submesh list (with per-submesh hidden state) for a `model` layer's
   *  loaded SKN — backs the mesh-visibility popup. Empty until loaded. */
  getModelMeshes: (layerId: string) => MeshInfo[];
  /** The live Babylon scene instance (Task 8/9), for the compositor
   *  (Task 13) to call `screenshot(w, h)` on. Null until the scene-creation
   *  effect has run (always true by the time a user could click Export). */
  getScene: () => ThumbnailScene | null;
}

interface ThumbnailArtboardProps {
  layers: Layer[];
  selId: string | null;
  onSelect: (id: string | null) => void;
  onChange: (next: Layer[], record: boolean) => void;
  /** Snapshot the pre-gesture baseline (call at drag/resize pointerdown, before the first move). */
  onBeginGesture: () => void;
  /** Record the gesture (baseline vs. final state) onto the undo stack (call on pointerup/release). */
  onCommitGesture: () => void;
  /** Ref-like escape hatch so the host (ThumbnailEditor) can trigger fit/100%/fit-selection from a toolbar or keyboard handler. */
  controlsRef?: React.MutableRefObject<ThumbnailArtboardHandle | null>;
  /** Active style — picks the text hue-mix intensity (Task 12: subtle for
   *  'riot', significant for 'divine'). */
  preset: ThumbnailPresetId;
  /** Global mod-hue (0-360) driving text recolor (and, contract-permitting,
   *  glow tint — see the reconciliation effect's glow comment below). */
  hue: number;
}

// Line-height factor applied to the fitted font size when summing a text
// block's total height — mirrors the CSS `line-height: 1.1` on `.tb-body`
// (see thumbnail.css) so the fit check and the actual rendered box agree.
const TEXT_LINE_HEIGHT = 1.1;

// Shared offscreen canvas 2D context for measuring real text width — one
// instance reused across every fit computation instead of allocating a
// canvas per call.
let measureCtx: CanvasRenderingContext2D | null = null;
function getMeasureCtx(): CanvasRenderingContext2D | null {
  if (measureCtx) return measureCtx;
  const canvas = document.createElement('canvas');
  measureCtx = canvas.getContext('2d');
  return measureCtx;
}

// Real `TextMeasure` used to fit a text layer's rendered font size: width
// comes from `measureText` at the layer's font/weight/style, height is the
// size scaled by the block's CSS line-height so multi-line totals match
// what actually renders.
function canvasMeasure(layer: TextLayer): TextMeasure {
  return (text: string, size: number) => {
    const ctx = getMeasureCtx();
    if (!ctx) return { w: text.length * size * 0.6, h: size * TEXT_LINE_HEIGHT };
    ctx.font = `${layer.italic ? 'italic ' : ''}800 ${size}px ${layer.font}`;
    const w = ctx.measureText(text).width + Math.max(0, text.length - 1) * layer.spacing;
    return { w, h: size * TEXT_LINE_HEIGHT };
  };
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

export function ThumbnailArtboard({ layers, selId, onSelect, onChange, onBeginGesture, onCommitGesture, controlsRef, preset, hue }: ThumbnailArtboardProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneCanvasRef = useRef<HTMLCanvasElement>(null);

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoomLabel, setZoomLabel] = useState('100%');
  // The model layer currently in interactive orbit mode (double-clicked), or
  // null. In orbit mode the Babylon camera for that model receives drag/wheel
  // (rotate/pan/zoom the model inside its box); the DOM proxy passes pointers
  // through to the scene canvas.
  const [orbitLayerId, setOrbitLayerId] = useState<string | null>(null);
  const orbitLayerIdRef = useRef<string | null>(null);
  orbitLayerIdRef.current = orbitLayerId;

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

  // ── Babylon scene (Task 8) instance + layer-id -> scene-model-id bindings.
  // Declared here (ahead of use) so both the controlsRef exposure effect and
  // the reconciliation effect further down can reference them. See the
  // reconciliation effect for the full placement-model writeup.
  const sceneRef = useRef<ThumbnailScene | null>(null);
  const modelBindingsRef = useRef<Map<string, { sceneId: string; sknPath: string; anim: string; frame: number; scale: number; orbit: number; x: number; y: number; w: number; h: number; hiddenMeshes: string }>>(new Map());
  const onChangeRef = useRef(onChange);
  onChangeRef.current = onChange;

  const getModelAnims = useCallback((layerId: string): AnimClip[] => {
    const scene = sceneRef.current;
    const binding = modelBindingsRef.current.get(layerId);
    if (!scene || !binding || !binding.sceneId) return [];
    return scene.listAnims(binding.sceneId);
  }, []);

  const getModelMeshes = useCallback((layerId: string): MeshInfo[] => {
    const scene = sceneRef.current;
    const binding = modelBindingsRef.current.get(layerId);
    if (!scene || !binding || !binding.sceneId) return [];
    return scene.listMeshes(binding.sceneId);
  }, []);

  const getScene = useCallback((): ThumbnailScene | null => sceneRef.current, []);

  // Enter/exit interactive orbit for a model layer. Enter attaches the scene's
  // camera control to that model (drag=rotate, wheel=zoom, right/ctrl-drag=pan);
  // exit detaches. Double-clicking the SAME model that's already orbiting
  // resets its view to the default centered pose.
  const enterOrbit = useCallback((layerId: string) => {
    const scene = sceneRef.current;
    const binding = modelBindingsRef.current.get(layerId);
    if (!scene || !binding || !binding.sceneId) return;
    if (orbitLayerIdRef.current === layerId) {
      scene.resetModelView(binding.sceneId);
      return;
    }
    scene.setControlModel(binding.sceneId);
    setOrbitLayerId(layerId);
  }, []);

  const exitOrbit = useCallback(() => {
    if (!orbitLayerIdRef.current) return;
    sceneRef.current?.setControlModel(null);
    setOrbitLayerId(null);
  }, []);

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

  // Expose fit/100%/fit-selection/getModelAnims to the host (toolbar / keyboard shortcuts / PropertiesPanel).
  useEffect(() => {
    if (controlsRef) controlsRef.current = { fitView, fullView, fitSelection, getModelAnims, getModelMeshes, getScene };
    return () => {
      if (controlsRef) controlsRef.current = null;
    };
  }, [controlsRef, fitView, fullView, fitSelection, getModelAnims, getModelMeshes, getScene]);

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

  // ── Babylon scene (Task 8) instantiation + model-layer reconciliation ──
  //
  // Placement model: ONE shared Babylon scene renders behind the DOM stage
  // (a single <canvas> filling .tb-stage, painted first so every .tb-el sits
  // above it in DOM order), but each `model` layer gets its OWN camera whose
  // screen-space viewport is derived from that layer's x/y/w/h box (see
  // studioScene.ts). So the 3D render for each model lands exactly inside its
  // artboard box — dragging/resizing the box moves/resizes the render, and
  // multiple models no longer overlap at the origin. The DOM proxy box stays
  // (translucent) purely for drag/resize/select hit-testing; the real render
  // shows through it. `scale`/`orbit`/`hiddenMeshes` are also forwarded to
  // the scene. (sceneRef/modelBindingsRef/onChangeRef are declared above.)
  useEffect(() => {
    const canvas = sceneCanvasRef.current;
    if (!canvas) return;
    const scene = createThumbnailScene(canvas, { w: STAGE_W, h: STAGE_H });
    sceneRef.current = scene;
    return () => {
      sceneRef.current = null;
      modelBindingsRef.current.clear();
      scene.dispose();
    };
  }, []);

  // Reconcile `model` layers -> scene models whenever layers change.
  useEffect(() => {
    const scene = sceneRef.current;
    if (!scene) return;
    const bindings = modelBindingsRef.current;
    const modelLayers = layers.filter((l): l is ModelLayer => l.type === 'model');
    const seenLayerIds = new Set<string>();

    // Reserves a binding placeholder and kicks off addModel + initial anim
    // load for a layer that has no scene model yet.
    const loadModelForLayer = (layer: ModelLayer) => {
      if (!layer.sknPath) return; // nothing to load yet
      // Reserve the binding immediately so a second effect run (e.g. a
      // fast prop change while the load is in flight) doesn't fire a
      // duplicate addModel for the same layer.
      const placeholder = { sceneId: '', sknPath: layer.sknPath, anim: layer.anim, frame: layer.frame, scale: layer.scale, orbit: layer.orbit, x: layer.x, y: layer.y, w: layer.w, h: layer.h, hiddenMeshes: JSON.stringify(layer.hiddenMeshes ?? []) };
      bindings.set(layer.id, placeholder);
      scene.addModel(layer.sknPath).then(async (handle) => {
        if (modelBindingsRef.current.get(layer.id) !== placeholder) {
          // Layer removed/changed while this load was in flight — addModel
          // already registered real meshes/materials/textures in the scene
          // under handle.id, so we must remove them here or they leak.
          scene.removeModel(handle.id);
          return;
        }
        placeholder.sceneId = handle.id;
        scene.setModelTransform(handle.id, { x: layer.x, y: layer.y, w: layer.w, h: layer.h, scale: layer.scale, orbit: layer.orbit });
        if (layer.hiddenMeshes && layer.hiddenMeshes.length > 0) {
          scene.setHiddenMeshes(handle.id, layer.hiddenMeshes);
        }
        const clips = scene.listAnims(handle.id);
        const initialAnim = layer.anim || clips[0]?.animation_path || clips[0]?.name || '';
        if (initialAnim) {
          await scene.setModelAnim(handle.id, initialAnim);
          if (modelBindingsRef.current.get(layer.id) !== placeholder) {
            // Same abandonment case, but discovered after the anim load —
            // still clean up the model we created.
            scene.removeModel(handle.id);
            return;
          }
          const maxFrame = scene.getMaxFrame(handle.id);
          placeholder.anim = initialAnim;
          scene.setModelFrame(handle.id, layer.frame);
          // Push the resolved anim/maxFrame back onto the layer so the
          // PropertiesPanel dropdown/slider reflect the real clip list.
          const current = layersRef.current.find(l => l.id === layer.id);
          if (current && current.type === 'model') {
            const next = updateLayer(layersRef.current, layer.id, { anim: initialAnim, maxFrame } as Partial<Layer>);
            layersRef.current = next;
            onChangeRef.current(next, false);
          }
        }
      }).catch((e) => {
        console.error('[ThumbnailArtboard] addModel failed for', layer.sknPath, e);
      });
    };

    for (const layer of modelLayers) {
      seenLayerIds.add(layer.id);
      const existing = bindings.get(layer.id);

      if (!existing) {
        loadModelForLayer(layer);
        continue;
      }

      if (!existing.sceneId) continue; // still loading

      if (existing.sknPath !== layer.sknPath) {
        // Model swapped to a different SKN — drop and reload immediately
        // under the same layer id (don't wait for another effect pass).
        scene.removeModel(existing.sceneId);
        bindings.delete(layer.id);
        loadModelForLayer(layer);
        continue;
      }

      if (existing.x !== layer.x || existing.y !== layer.y || existing.w !== layer.w || existing.h !== layer.h || existing.scale !== layer.scale || existing.orbit !== layer.orbit) {
        scene.setModelTransform(existing.sceneId, { x: layer.x, y: layer.y, w: layer.w, h: layer.h, scale: layer.scale, orbit: layer.orbit });
        existing.x = layer.x; existing.y = layer.y; existing.w = layer.w; existing.h = layer.h;
        existing.scale = layer.scale; existing.orbit = layer.orbit;
      }
      if (existing.anim !== layer.anim && layer.anim) {
        existing.anim = layer.anim;
        scene.setModelAnim(existing.sceneId, layer.anim).then(() => {
          if (bindings.get(layer.id) !== existing) return;
          const maxFrame = scene.getMaxFrame(existing.sceneId);
          scene.setModelFrame(existing.sceneId, existing.frame);
          const current = layersRef.current.find(l => l.id === layer.id);
          if (current && current.type === 'model' && current.maxFrame !== maxFrame) {
            const next = updateLayer(layersRef.current, layer.id, { maxFrame } as Partial<Layer>);
            layersRef.current = next;
            onChangeRef.current(next, false);
          }
        });
      }
      if (existing.frame !== layer.frame) {
        existing.frame = layer.frame;
        scene.setModelFrame(existing.sceneId, layer.frame);
      }
      const hiddenKey = JSON.stringify(layer.hiddenMeshes ?? []);
      if (existing.hiddenMeshes !== hiddenKey) {
        existing.hiddenMeshes = hiddenKey;
        scene.setHiddenMeshes(existing.sceneId, layer.hiddenMeshes ?? []);
      }
    }

    // Any binding whose layer no longer exists (deleted) -> remove from scene.
    for (const [layerId, binding] of bindings) {
      if (!seenLayerIds.has(layerId)) {
        if (binding.sceneId) scene.removeModel(binding.sceneId);
        bindings.delete(layerId);
      }
    }
  }, [layers]);

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
    // Click on empty viewport/stage-wrap background clears selection + exits orbit.
    const targetEl = e.target as HTMLElement;
    if ((targetEl === viewportRef.current || targetEl.classList.contains('tb-stage-wrap')) && !spaceHeld && e.button === 0) {
      exitOrbit();
      onSelect(null);
    }
  }, [spaceHeld, onSelect, exitOrbit]);

  const handleViewportPointerMove = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!panning || !panStateRef.current) return;
    const s = panStateRef.current;
    applyPanZoom(zoomRef.current, s.px + (e.clientX - s.x), s.py + (e.clientY - s.y));
  }, [panning, applyPanZoom]);

  const handleViewportPointerUp = useCallback(() => {
    setPanning(false);
    panStateRef.current = null;
  }, []);

  // Env background click also clears selection + exits orbit.
  const handleEnvPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (!spaceHeld && e.button === 0) { exitOrbit(); onSelect(null); }
  }, [spaceHeld, onSelect, exitOrbit]);

  // Escape exits orbit mode.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => {
      if (e.key === 'Escape' && orbitLayerIdRef.current) {
        e.preventDefault();
        exitOrbit();
      }
    };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [exitOrbit]);

  // ── Drag-move (startMove port) ──
  const startMove = useCallback((e: React.PointerEvent<HTMLDivElement>, layer: Layer) => {
    if (layer.locked) return;
    e.preventDefault();
    onBeginGesture();
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
      onCommitGesture();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }, [onChange, onBeginGesture, onCommitGesture]);

  // ── Corner resize (startResize port) ──
  const startResize = useCallback((e: React.PointerEvent<HTMLDivElement>, layer: Layer, handle: ResizeHandle) => {
    if (layer.locked) return;
    e.preventDefault();
    e.stopPropagation();
    onBeginGesture();
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
      onCommitGesture();
    };
    window.addEventListener('pointermove', mv);
    window.addEventListener('pointerup', up);
  }, [onChange, onBeginGesture, onCommitGesture]);

  const handleElPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>, layer: Layer) => {
    if (panning) return;
    // While a model is in orbit mode, its DOM proxy is pointer-events:none so
    // this never fires for it — but guard anyway: don't drag-move the model
    // that's being orbited (Babylon owns the drag).
    if (orbitLayerIdRef.current === layer.id) return;
    // Clicking a DIFFERENT layer exits orbit mode.
    if (orbitLayerIdRef.current && orbitLayerIdRef.current !== layer.id) exitOrbit();
    if (selIdRef.current !== layer.id) onSelect(layer.id);
    if (layer.locked) return;
    startMove(e, layer);
  }, [panning, onSelect, startMove, exitOrbit]);

  // Inline text editing (dblclick), mirrors the prototype's contenteditable flow.
  // Multi-line (Task 11): while editing, the body switches to plain text
  // content (one line per `\n`) so the browser's native contentEditable
  // caret/selection behavior stays simple; Enter inserts a newline instead
  // of committing. Commit happens on blur or Escape; Shift+Enter also
  // commits (per the brief) since Enter alone already means "newline".
  const handleTextDoubleClick = useCallback((e: React.MouseEvent<HTMLDivElement>, layer: Layer) => {
    if (layer.type !== 'text' || layer.locked) return;
    e.preventDefault();
    const body = e.currentTarget.querySelector('.tb-body') as HTMLDivElement | null;
    if (!body) return;
    body.style.pointerEvents = 'auto';
    body.contentEditable = 'true';
    body.textContent = layer.text;
    body.focus();
    const range = document.createRange();
    range.selectNodeContents(body);
    const sel = window.getSelection();
    sel?.removeAllRanges();
    sel?.addRange(range);

    let committed = false;
    const commit = () => {
      if (committed) return;
      committed = true;
      // `innerText` (not `textContent`) reflects the browser's own rendered
      // line breaks from a plain-Enter contentEditable div (which inserts
      // <div>/<br> boundaries, not literal "\n" characters), normalized to
      // "\n". Chromium leaves one extra trailing "\n" for the caret-holding
      // empty line at the very end of the div — strip exactly one.
      const raw = body.innerText.replace(/\r\n/g, '\n');
      const text = raw.endsWith('\n') ? raw.slice(0, -1) : raw;
      body.contentEditable = 'false';
      body.style.pointerEvents = 'none';
      const next = updateLayer(layersRef.current, layer.id, { text } as Partial<Layer>);
      layersRef.current = next;
      onChange(next, true);
    };
    const onBlur = () => commit();
    const onKeyDown = (ev: KeyboardEvent) => {
      if (ev.key === 'Escape') {
        ev.preventDefault();
        body.blur();
      } else if (ev.key === 'Enter' && ev.shiftKey) {
        ev.preventDefault();
        body.blur();
      }
      // Plain Enter: let the browser insert a newline (default contentEditable
      // behavior) — do NOT preventDefault, do NOT commit.
    };
    body.addEventListener('blur', onBlur, { once: true });
    body.addEventListener('keydown', onKeyDown);
  }, [onChange]);

  const sorted = [...layers].filter(l => !l.hidden).sort((a, b) => zrank(a) - zrank(b));
  const selectedLayer = layers.find(l => l.id === selId) ?? null;

  // The disc layer's gold RING renders as a SEPARATE front-band pass (see
  // DiscComposite's `part` prop) so it paints above the model layers'
  // `.tb-el` proxies (and the scene canvas underneath them) while the
  // glow/black-fill pieces stay in the disc's normal `sorted` position
  // behind the model (zrank 20 < model's 40). This is purely a render
  // split — the disc stays ONE entry in `layers`/`sorted` (one selectable/
  // lockable/deletable `.tb-el`, rendered by the main loop above); this
  // overlay just re-paints the ring piece using the SAME layer's box, and
  // is never itself an independent hit-target (pointer-events:none, no
  // data-id, no pointer handlers) so it can't be selected, dragged, or
  // otherwise diverge from the real disc element.
  const discLayer = sorted.find((l): l is DiscLayer => l.type === 'disc') ?? null;

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
          {/* Disc ("circle") — the BACKGROUND SEPARATOR for the hero. Painted
              BETWEEN the env and the (transparent) scene canvas, so the full
              circle (glow + darkened fill + gold ring) sits BEHIND the models:
              the hero renders ON TOP of the circle, with the circle visible
              around it. The selectable/deletable disc hit-proxy is still a
              `.tb-el` in the `sorted` map below (its LayerBody is empty — the
              visual lives here). */}
          {discLayer && !discLayer.hidden && (
            <div
              className="tb-disc-bg"
              style={{
                left: discLayer.x,
                top: discLayer.y,
                width: discLayer.w,
                height: discLayer.h,
                transform: `rotate(${discLayer.rot}deg)`,
              }}
            >
              <DiscComposite layer={discLayer} part="full" />
            </div>
          )}
          {/* Shared Babylon scene (Task 8) — one canvas behind every DOM
              layer element, rendering all `model` layers' actual SKN
              meshes. See the reconciliation effect above for how layer
              props are pushed into the scene; x/y/w/h placement of the
              rendered model within this canvas is a Task 13 (compositor)
              concern, not this canvas's. */}
          <canvas ref={sceneCanvasRef} className={`tb-scene-canvas${orbitLayerId ? ' tb-scene-canvas--orbit' : ''}`} />
          {sorted.map(layer => (
            <div
              key={layer.id}
              className={`tb-el ${layer.type}${layer.id === selId ? ' selected' : ''}${layer.locked ? ' locked' : ''}${layer.id === orbitLayerId ? ' orbiting' : ''}`}
              data-id={layer.id}
              style={{
                left: layer.x,
                top: layer.y,
                width: layer.w,
                height: layer.h,
                transform: `rotate(${layer.rot}deg)`,
              }}
              onPointerDown={(e) => handleElPointerDown(e, layer)}
              onDoubleClick={(e) => {
                if (layer.type === 'text') handleTextDoubleClick(e, layer);
                else if (layer.type === 'model') enterOrbit(layer.id);
              }}
            >
              <LayerBody layer={layer} preset={preset} hue={hue} />
            </div>
          ))}
        </div>
        <SelOverlay
          layer={selectedLayer}
          onHandlePointerDown={startResize}
        />
      </div>
      {orbitLayerId && (
        <div className="tb-orbit-hint">
          Orbiting model · drag to rotate · wheel to zoom · double-click to reset · Esc to exit
        </div>
      )}
    </div>
  );
}

function LayerBody({ layer, preset, hue }: { layer: Layer; preset: ThumbnailPresetId; hue: number }) {
  if (layer.type === 'text') {
    // Auto-shrink (Task 11): the stored `layer.size` is the user's MAX —
    // the actually-rendered size shrinks (never grows past it) so every
    // line fits the box width and the stacked lines fit the box height.
    // This is a render-only concern; `layer.size` itself is untouched.
    const lines = layer.text.split('\n');
    const fitted = fitFontSize(canvasMeasure(layer), lines, layer.w, layer.h, layer.size);
    // Global mod-hue theme (Task 12): color is resolved per-render from the
    // shared cream base + the active hue, mixed subtly for Riot / strongly
    // for Divine (see hue.ts). No per-text color picker - the whole style
    // reacts to the ONE ThemePanel slider.
    const color = resolveTextColor(preset, hue, TEXT_BASE_COLOR);
    return (
      <div
        className="tb-body"
        style={{ fontSize: fitted, fontFamily: layer.font, fontStyle: layer.italic ? 'italic' : 'normal', letterSpacing: layer.spacing, color }}
      >
        {lines.map((line, i) => (
          // Empty lines (a blank row from a plain Enter) still need to take
          // up a row's height — nbsp keeps the flex row from collapsing.
          <span className="tb-line" key={i}>{line.length > 0 ? line : ' '}</span>
        ))}
      </div>
    );
  }
  if (layer.type === 'model') {
    // Placeholder body — real SKN preview lands in a later phase.
    return <div className="tb-body">{layer.name.split('—')[0].trim()}</div>;
  }
  if (layer.type === 'disc') {
    // The disc's VISUAL is painted behind the scene canvas (see the
    // `.tb-disc-bg` element in the artboard) so the hero renders on top of the
    // circle. This `.tb-el` is just the transparent selection/drag hit-proxy —
    // empty body.
    return <div className="tb-body tb-disc-proxy" />;
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
