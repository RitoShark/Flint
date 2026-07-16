import { useCallback, useEffect, useLayoutEffect, useRef, useState } from 'react';
import { convertFileSrc } from '@tauri-apps/api/core';
import { DiscLayer, EnvLayer, Layer, ModelLayer, TextLayer, updateLayer } from '../../lib/thumbnail/layers';
import { AnimClip, createThumbnailScene, MeshInfo, ThumbnailScene } from '../../lib/thumbnail/studioScene';
import { createMapEnvScene, MapEnvScene } from '../../lib/thumbnail/mapEnvScene';
import { fitFontSize, TextMeasure } from '../../lib/thumbnail/textFit';
import { resolveBackground, resolveGlowColor, resolveTextStyle, ThumbnailPresetId } from '../../lib/thumbnail/hue';
import { DiscComposite } from './DiscComposite';
import { FrameComposite } from './FrameComposite';
import { ModelStudioModal } from './ModelStudioModal';
import { DlIcon } from '../ui/design-lab';
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
   *  SKN (empty until the scene has finished loading it). The mesh/anim editor
   *  + Face-camera now live inside the artboard's own model toolbar, so these
   *  getters are internal — only `getScene` is still needed by the host. */
  /** The live Babylon scene instance (Task 8/9), for the compositor
   *  (Task 13) to call `screenshot(w, h)` on. Null until the scene-creation
   *  effect has run (always true by the time a user could click Export). */
  getScene: () => ThumbnailScene | null;
  /** The 3D map-env scene (own engine), for the compositor to draw behind the
   *  disc. Null when no map layer / before the scene-creation effect runs. */
  getMapScene: () => MapEnvScene | null;
  /** Maps a model LAYER id to the scene's internal model id (`model-N`).
   *  Needed by the export compositor: the scene keys models by its own ids,
   *  not layer ids. Null while the model is still loading / unbound. */
  getModelSceneId: (layerId: string) => string | null;
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
  /** Vignette strength (0-100) — cinematic edge-darkening over the whole comp. */
  vignette: number;
  /** Bottom-right corner glow strength (0-100) — a soft hue-tinted radial bloom
   *  (generated, no asset). Recolors with `hue`. */
  cornerGlow: number;
  /** Fired ONCE when the initial models + map have finished loading, so the
   *  host can dismiss the loading overlay. */
  onReady?: () => void;
}

/** CSS `filter: drop-shadow(...)` for a layer's shadow style, or undefined when
 *  the layer casts no shadow. The drop-shadow follows the layer's actual
 *  silhouette (text glyphs, disc/frame alpha) — offsets/blur are authored in
 *  the 640×360 stage space (the stage is CSS-scaled, so px map 1:1 here). */
function shadowFilter(layer: Layer): string | undefined {
  if (!layer.shadow) return undefined;
  const blur = layer.shadowBlur ?? 8;
  const ox = layer.shadowOffsetX ?? 0;
  const oy = layer.shadowOffsetY ?? 6;
  const op = layer.shadowOpacity ?? 0.5;
  return `drop-shadow(${ox}px ${oy}px ${blur}px rgba(0,0,0,${op}))`;
}

/** The hue-tinted color for the bottom-right corner glow at strength 0-100 —
 *  the theme glow color as an `rgba()` whose alpha scales with strength (capped
 *  so it blooms without washing out). Shared shape used by preview + export. */
function cornerGlowColor(hue: number, strength: number): string {
  const hex = resolveGlowColor(hue).replace('#', '');
  const n = parseInt(hex, 16);
  const r = (n >> 16) & 0xff, g = (n >> 8) & 0xff, b = n & 0xff;
  const a = Math.max(0, Math.min(1, strength / 100)) * 0.75;
  return `rgba(${r}, ${g}, ${b}, ${a.toFixed(3)})`;
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

// Clip-name of an AnimClip (its friendly name, else the file stem).
function clipName(c: AnimClip): string {
  return (c.name || c.animation_path.split(/[\\/]/).pop() || c.animation_path).toLowerCase();
}

/** Pick the best default "idle" clip: the SHORTEST-named clip whose name
 *  contains "idle" (so plain `Idle` wins over `Idle_In` / `Idle_Base` /
 *  `Idle_Variant`). Falls back to the first clip if none contain "idle". */
function pickDefaultAnim(clips: AnimClip[]): AnimClip | null {
  if (clips.length === 0) return null;
  const idles = clips.filter(c => clipName(c).includes('idle'));
  const pool = idles.length > 0 ? idles : clips;
  return pool.reduce((best, c) => (clipName(c).length < clipName(best).length ? c : best), pool[0]);
}

export function ThumbnailArtboard({ layers, selId, onSelect, onChange, onBeginGesture, onCommitGesture, controlsRef, preset, hue, vignette, cornerGlow, onReady }: ThumbnailArtboardProps) {
  const viewportRef = useRef<HTMLDivElement>(null);
  const stageWrapRef = useRef<HTMLDivElement>(null);
  const stageRef = useRef<HTMLDivElement>(null);
  const sceneCanvasRef = useRef<HTMLCanvasElement>(null);
  const mapCanvasRef = useRef<HTMLCanvasElement>(null);
  // One on-screen canvas per MODEL layer (keyed by layer id), so each model
  // displays on its own canvas at its own z-index — this is what lets the disc
  // sit z-order BETWEEN two models. Handed to the scene via setModelCanvas once
  // the model has a sceneId (see the reconcile effect).
  const modelCanvasRefs = useRef<Map<string, HTMLCanvasElement>>(new Map());

  const [zoom, setZoom] = useState(1);
  const [pan, setPan] = useState({ x: 0, y: 0 });
  const [zoomLabel, setZoomLabel] = useState('100%');
  // Bumped whenever webfonts finish loading. Text auto-fit (fitFontSize) measures
  // with a canvas 2D context — if the real font (Anton / Beaufort) hasn't loaded
  // yet, measureText uses a WIDER fallback face, clamps the fitted size too
  // small, and never recovers. Re-rendering on font load re-measures with the
  // real glyph metrics so the text sizes correctly. (fontVersion is read in the
  // render below so the change actually triggers a re-fit.)
  const [fontVersion, setFontVersion] = useState(0);
  useEffect(() => {
    const fonts = (document as Document & { fonts?: FontFaceSet }).fonts;
    if (!fonts) return;
    let cancelled = false;
    const bump = () => { if (!cancelled) setFontVersion(v => v + 1); };
    // `ready` resolves once all pending fonts (incl. the bundled Anton) load;
    // `loadingdone` fires for any later loads (e.g. a font requested on a
    // preset swap). Both re-fit the text.
    fonts.ready.then(bump).catch(() => { /* ignore */ });
    fonts.addEventListener?.('loadingdone', bump);
    return () => { cancelled = true; fonts.removeEventListener?.('loadingdone', bump); };
  }, []);
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
  const mapSceneRef = useRef<MapEnvScene | null>(null);
  const modelBindingsRef = useRef<Map<string, { sceneId: string; sknPath: string; anim: string; frame: number; scale: number; orbit: number; tiltX: number; rollZ: number; posX: number; posY: number; posZ: number; x: number; y: number; w: number; h: number; hiddenMeshes: string; focusMode: string; hidden: boolean }>>(new Map());
  // Last-synced fingerprint of the env layer so the reconcile only touches the
  // map scene when the env layer actually changed (loads/variation/transform).
  const envSyncRef = useRef<string>('');
  const envLoadingRef = useRef(false);
  // Fire onReady exactly once, when the initial models have all loaded.
  const readyFiredRef = useRef(false);
  const onReadyRef = useRef(onReady);
  onReadyRef.current = onReady;
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

  const faceModelToCamera = useCallback((layerId: string): { orbit: number; tiltX: number } | null => {
    const scene = sceneRef.current;
    const binding = modelBindingsRef.current.get(layerId);
    if (!scene || !binding || !binding.sceneId) return null;
    const res = scene.faceModelToCamera(binding.sceneId);
    if (res) { binding.orbit = res.orbit; binding.tiltX = res.tiltX; } // keep binding in sync so reconcile doesn't re-push stale values
    return res;
  }, []);

  const getScene = useCallback((): ThumbnailScene | null => sceneRef.current, []);
  const getMapScene = useCallback((): MapEnvScene | null => mapSceneRef.current, []);
  const getModelSceneId = useCallback((layerId: string): string | null =>
    modelBindingsRef.current.get(layerId)?.sceneId || null, []);

  // ── Floating model toolbar (top-left of the artboard) — shown when a model
  // layer is selected. Hosts the ⚙ mesh/animation popover trigger + the Face
  // camera button, right over the canvas (not in the properties panel). ──
  const [studioOpen, setStudioOpen] = useState(false);
  const studioBtnRef = useRef<HTMLButtonElement>(null);

  // Patch just the selected MODEL layer (studio edits: hiddenMeshes/anim/frame/
  // focusMode) via the same updateLayer→onChange path everything else uses.
  const patchModelLayer = useCallback((id: string, patch: Partial<ModelLayer>, record: boolean) => {
    const next = updateLayer(layersRef.current, id, patch as Partial<Layer>);
    layersRef.current = next;
    onChangeRef.current(next, record);
  }, []);

  // Face camera for the selected model, persisting the returned Turn + Tilt.
  const faceSelectedModel = useCallback(() => {
    const id = selIdRef.current;
    if (!id) return;
    const res = faceModelToCamera(id);
    if (!res) return;
    patchModelLayer(id, { orbit: res.orbit, tiltX: res.tiltX }, true);
  }, [faceModelToCamera, patchModelLayer]);

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
    try { sceneRef.current?.setControlModel(null); } catch { /* ignore */ }
    orbitLayerIdRef.current = null;
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
    if (controlsRef) controlsRef.current = { fitView, fullView, fitSelection, getScene, getMapScene, getModelSceneId };
    return () => {
      if (controlsRef) controlsRef.current = null;
    };
  }, [controlsRef, fitView, fullView, fitSelection, getScene, getMapScene, getModelSceneId]);

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
    const onResize = () => { centerOn(STAGE_W / 2, STAGE_H / 2); mapSceneRef.current?.resize(); };
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
    // The 3D map-env backdrop runs on its own engine/canvas (behind the disc).
    const mapCanvas = mapCanvasRef.current;
    if (mapCanvas) mapSceneRef.current = createMapEnvScene(mapCanvas, convertFileSrc);
    return () => {
      sceneRef.current = null;
      modelBindingsRef.current.clear();
      scene.dispose();
      mapSceneRef.current?.dispose();
      mapSceneRef.current = null;
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
      const placeholder = { sceneId: '', sknPath: layer.sknPath, anim: layer.anim, frame: layer.frame, scale: layer.scale, orbit: layer.orbit, tiltX: layer.tiltX ?? 0, rollZ: layer.rollZ ?? 0, posX: layer.posX ?? 0, posY: layer.posY ?? 0, posZ: layer.posZ ?? 0, x: layer.x, y: layer.y, w: layer.w, h: layer.h, hiddenMeshes: JSON.stringify(layer.hiddenMeshes ?? []), focusMode: layer.focusMode ?? 'full', hidden: !!layer.hidden };
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
        // Attach this model's OWN view canvas now that it has a sceneId (the
        // async load finished after the reconcile ran, so wire it here too).
        scene.setModelCanvas(handle.id, modelCanvasRefs.current.get(layer.id) ?? null);
        scene.setModelTransform(handle.id, { x: layer.x, y: layer.y, w: layer.w, h: layer.h, scale: layer.scale, orbit: layer.orbit, tiltX: layer.tiltX ?? 0, rollZ: layer.rollZ ?? 0, posX: layer.posX ?? 0, posY: layer.posY ?? 0, posZ: layer.posZ ?? 0 });
        if (layer.hiddenMeshes && layer.hiddenMeshes.length > 0) {
          scene.setHiddenMeshes(handle.id, layer.hiddenMeshes);
        }
        if (layer.hidden) scene.setModelVisible(handle.id, false);
        if (layer.focusMode === 'head') {
          scene.setModelFocus(handle.id, 'head');
        }
        const clips = scene.listAnims(handle.id);
        // "Fresh" = the layer was just seeded (no explicit anim yet). For a
        // fresh model we default to the shortest IDLE clip. We do NOT auto-face
        // the camera on spawn — the artist controls the spawn pose (the Face
        // camera button stays available for a manual, on-demand turn).
        const initialAnim = layer.anim
          || pickDefaultAnim(clips)?.animation_path
          || clips[0]?.animation_path
          || clips[0]?.name
          || '';
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
          // PropertiesPanel reflects the real state. The spawn pose keeps the
          // layer's seeded orbit/tiltX (no auto-face).
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

      if (existing.x !== layer.x || existing.y !== layer.y || existing.w !== layer.w || existing.h !== layer.h || existing.scale !== layer.scale || existing.orbit !== layer.orbit || existing.tiltX !== (layer.tiltX ?? 0) || existing.rollZ !== (layer.rollZ ?? 0) || existing.posX !== (layer.posX ?? 0) || existing.posY !== (layer.posY ?? 0) || existing.posZ !== (layer.posZ ?? 0)) {
        scene.setModelTransform(existing.sceneId, { x: layer.x, y: layer.y, w: layer.w, h: layer.h, scale: layer.scale, orbit: layer.orbit, tiltX: layer.tiltX ?? 0, rollZ: layer.rollZ ?? 0, posX: layer.posX ?? 0, posY: layer.posY ?? 0, posZ: layer.posZ ?? 0 });
        existing.x = layer.x; existing.y = layer.y; existing.w = layer.w; existing.h = layer.h;
        existing.scale = layer.scale; existing.orbit = layer.orbit; existing.tiltX = layer.tiltX ?? 0; existing.rollZ = layer.rollZ ?? 0;
        existing.posX = layer.posX ?? 0; existing.posY = layer.posY ?? 0; existing.posZ = layer.posZ ?? 0;
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
      const focus = layer.focusMode ?? 'full';
      if (existing.focusMode !== focus) {
        existing.focusMode = focus;
        scene.setModelFocus(existing.sceneId, focus);
      }
      const hidden = !!layer.hidden;
      if (existing.hidden !== hidden) {
        existing.hidden = hidden;
        // Layers-panel eye toggle: hide/show the whole 3D model, not just its
        // DOM proxy box (which `sorted` already drops when hidden).
        scene.setModelVisible(existing.sceneId, !hidden);
      }
    }

    // Render order among models = ABSOLUTE layer-array position (earlier index =
    // front). Using the full-array index (not the model-filtered index) means
    // dragging a model in the Layers panel restacks it against the others where
    // their viewports overlap. Higher renderOrder renders last / on top.
    for (const layer of modelLayers) {
      const b = bindings.get(layer.id);
      if (!b?.sceneId) continue;
      const idx = layers.findIndex(l => l.id === layer.id);
      scene.setModelRenderOrder(b.sceneId, layers.length - idx);
    }

    // Attach each model's OWN view canvas to the scene (per-model rendering).
    // Done here (after sceneId is known) so a model displays on its own canvas
    // at its own z-index — this is what lets the disc sit between two models.
    for (const layer of modelLayers) {
      const b = bindings.get(layer.id);
      if (!b?.sceneId) continue;
      const canvasEl = modelCanvasRefs.current.get(layer.id) ?? null;
      scene.setModelCanvas(b.sceneId, canvasEl);
    }

    // Any binding whose layer no longer exists (deleted) -> remove from scene.
    for (const [layerId, binding] of bindings) {
      if (!seenLayerIds.has(layerId)) {
        if (binding.sceneId) scene.removeModel(binding.sceneId);
        bindings.delete(layerId);
      }
    }

    // ── Env (3D map) layer sync ──────────────────────────────────────────
    // Split into two paths so tuning the transform feels instant:
    //   • GLB + textures + visibility → async, load-guarded (heavy).
    //   • position/rotation/scale      → SYNC every run (cheap, no reload), so
    //     nudging the Position/Rotation/Scale number fields moves the map live.
    const mapScene = mapSceneRef.current;
    const envLayer = layers.find((l): l is EnvLayer => l.type === 'env') ?? null;
    const activeVar = envLayer?.variations.find(v => v.name === envLayer.activeVariation) ?? envLayer?.variations[0];
    if (mapScene) {
      // Heavy path: glb / textures / hidden.
      const envFp = envLayer && !envLayer.hidden
        ? JSON.stringify([envLayer.glb, activeVar?.textures ?? {}])
        : '';
      if (envFp !== envSyncRef.current && !envLoadingRef.current) {
        envSyncRef.current = envFp;
        if (!envLayer || envLayer.hidden) {
          mapScene.setVisible(false);
        } else {
          envLoadingRef.current = true;
          (async () => {
            try {
              await mapScene.setLayer(envLayer);
              mapScene.setVisible(true);
            } finally {
              envLoadingRef.current = false;
            }
          })();
        }
      }
      // Light path: transform, applied synchronously (only once the GLB exists).
      if (envLayer && !envLayer.hidden && mapScene.isLoaded()) {
        mapScene.setTransform(envLayer.position, envLayer.rotation, envLayer.mapScale);
      }
    }

    // Ready signal (fired once): all model layers that have a SKN path now have
    // a live sceneId, so the initial load is done and the overlay can dismiss.
    if (!readyFiredRef.current) {
      const pending = modelLayers.filter(l => l.sknPath && !bindings.get(l.id)?.sceneId);
      if (pending.length === 0) {
        readyFiredRef.current = true;
        // One more frame so the first render lands before we fade the overlay.
        requestAnimationFrame(() => onReadyRef.current?.());
      }
    }
  }, [layers]);

  // ── Orbit-mode wheel = adjust the orbited model's SCALE (not the artboard
  // zoom / camera radius) so wheel stays in sync with the Properties slider. ──
  // Binds to the ORBITED model's own view canvas (re-binds when orbit changes).
  useEffect(() => {
    if (!orbitLayerId) return;
    const canvas = modelCanvasRefs.current.get(orbitLayerId);
    if (!canvas) return;
    const onWheel = (e: WheelEvent) => {
      const orbitId = orbitLayerIdRef.current;
      if (!orbitId) return; // only in orbit mode
      e.preventDefault();
      e.stopPropagation();
      const layer = layersRef.current.find(l => l.id === orbitId);
      if (!layer || layer.type !== 'model') return;
      const factor = e.deltaY < 0 ? 1.08 : 1 / 1.08;
      const next = Math.round(Math.min(600, Math.max(20, layer.scale * factor)));
      const updated = updateLayer(layersRef.current, orbitId, { scale: next } as Partial<Layer>);
      layersRef.current = updated;
      onChangeRef.current(updated, true);
    };
    // Capture phase so this runs BEFORE Babylon's canvas wheel listeners.
    canvas.addEventListener('wheel', onWheel, { passive: false, capture: true });
    return () => canvas.removeEventListener('wheel', onWheel, { capture: true } as EventListenerOptions);
  }, [orbitLayerId]);

  // ── Orbit-mode LEFT-drag rotates the model on one axis, picked by modifier
  // (latched at press-down so a mid-drag key tap can't switch axes):
  //   • plain      → Turn  (yaw / orbit),   horizontal drag
  //   • ALT+drag   → Tilt  (pitch / tiltX), vertical drag
  //   • CTRL+drag  → Roll  (Z / rollZ),     horizontal drag
  // Right-drag stays with Babylon (pan). We intercept LEFT-button drags on the
  // scene canvas in capture phase so Babylon never sees them (drag-rotate is
  // disabled on the camera anyway) and translate pixels → degrees, driving the
  // SAME layer fields the Properties sliders use (so everything stays in sync). ──
  useEffect(() => {
    if (!orbitLayerId) return;
    const canvas = modelCanvasRefs.current.get(orbitLayerId);
    if (!canvas) return;
    let dragging: { startX: number; startY: number; base: number; mode: 'turn' | 'tilt' | 'roll' } | null = null;
    const DEG_PER_PX = 0.5; // drag feel — half a degree per pixel

    const wrap = (deg: number) => {
      let d = ((deg + 180) % 360 + 360) % 360 - 180; // normalize to (-180,180]
      if (d <= -180) d += 360;
      return Math.round(d);
    };

    const onDown = (e: PointerEvent) => {
      const orbitId = orbitLayerIdRef.current;
      if (!orbitId || e.button !== 0) return; // left-button only, orbit mode only
      const layer = layersRef.current.find(l => l.id === orbitId);
      if (!layer || layer.type !== 'model') return;
      e.preventDefault();
      e.stopPropagation();
      onBeginGesture();
      // Ctrl beats Alt if both are held.
      const mode: 'turn' | 'tilt' | 'roll' = e.ctrlKey || e.metaKey ? 'roll' : e.altKey ? 'tilt' : 'turn';
      const base = mode === 'roll' ? (layer.rollZ ?? 0) : mode === 'tilt' ? (layer.tiltX ?? 0) : (layer.orbit ?? 0);
      dragging = { startX: e.clientX, startY: e.clientY, base, mode };
      canvas.setPointerCapture(e.pointerId);
    };
    const onMove = (e: PointerEvent) => {
      if (!dragging) return;
      const orbitId = orbitLayerIdRef.current;
      if (!orbitId) return;
      e.preventDefault();
      e.stopPropagation();
      // Tilt tracks vertical motion (nod up/down); turn & roll track horizontal.
      const delta = dragging.mode === 'tilt' ? (e.clientY - dragging.startY) : (e.clientX - dragging.startX);
      const value = wrap(dragging.base + delta * DEG_PER_PX);
      const field = dragging.mode === 'tilt' ? 'tiltX' : dragging.mode === 'roll' ? 'rollZ' : 'orbit';
      const next = updateLayer(layersRef.current, orbitId, { [field]: value } as Partial<Layer>);
      layersRef.current = next;
      onChangeRef.current(next, false);
    };
    const onUp = (e: PointerEvent) => {
      if (!dragging) return;
      dragging = null;
      try { canvas.releasePointerCapture(e.pointerId); } catch { /* ignore */ }
      onCommitGesture();
    };
    canvas.addEventListener('pointerdown', onDown, { capture: true });
    canvas.addEventListener('pointermove', onMove, { capture: true });
    canvas.addEventListener('pointerup', onUp, { capture: true });
    canvas.addEventListener('pointercancel', onUp, { capture: true });
    return () => {
      canvas.removeEventListener('pointerdown', onDown, { capture: true } as EventListenerOptions);
      canvas.removeEventListener('pointermove', onMove, { capture: true } as EventListenerOptions);
      canvas.removeEventListener('pointerup', onUp, { capture: true } as EventListenerOptions);
      canvas.removeEventListener('pointercancel', onUp, { capture: true } as EventListenerOptions);
    };
  }, [orbitLayerId, onBeginGesture, onCommitGesture]);

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
    // During orbit, the middle-mouse / space pan of the ARTBOARD is disabled —
    // it moved the whole board while you were trying to interact with the
    // model (dumb). Camera pan uses right-drag on the model instead.
    if (e.button === 1 && orbitLayerIdRef.current) { e.preventDefault(); return; }
    if (e.button === 1 || (e.button === 0 && spaceHeld)) {
      panStateRef.current = { x: e.clientX, y: e.clientY, px: panRef.current.x, py: panRef.current.y };
      setPanning(true);
      (e.target as Element).setPointerCapture(e.pointerId);
      e.preventDefault();
      return;
    }
    // While orbiting, do NOT let a background click tear down the orbit here —
    // it races with Babylon's pointer capture on the canvas and left the scene
    // in a stuck state. Orbit exits only via the Done button / Escape.
    if (orbitLayerIdRef.current) return;
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

  // Env background click clears selection (orbit exits only via Done/Esc).
  const handleEnvPointerDown = useCallback((e: React.PointerEvent<HTMLDivElement>) => {
    if (orbitLayerIdRef.current) return;
    if (!spaceHeld && e.button === 0) { onSelect(null); }
  }, [spaceHeld, onSelect]);

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
    // Orbit mode LOCKS selection: while a model is being orbited, no other
    // layer can be selected/dragged and orbit doesn't get knocked out by a
    // stray click. Swallow the event entirely (Esc or clicking empty
    // background is the only way out — see exitOrbit call sites).
    if (orbitLayerIdRef.current) {
      e.stopPropagation();
      return;
    }
    if (selIdRef.current !== layer.id) onSelect(layer.id);
    if (layer.locked) return;
    startMove(e, layer);
  }, [panning, onSelect, startMove]);

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

  // Z-order comes from layer ARRAY position (earlier index = front). Each proxy,
  // each per-model canvas, and the disc get an explicit z-index derived from
  // their index, so dragging a layer in the panel restacks it — and the disc can
  // sit BETWEEN two models. `zOf` maps a layer id → z-index (front = high). Env
  // has no proxy.
  const zOf = (id: string): number => {
    const i = layers.findIndex(l => l.id === id);
    return i < 0 ? 1 : (layers.length - i) * 10;
  };
  const sorted = layers.filter(l => !l.hidden && l.type !== 'env');
  // The map (env) canvas z from the env layer's position (usually the back).
  const envId = layers.find(l => l.type === 'env')?.id;
  const mapCanvasZ = envId ? zOf(envId) : 0;
  const selectedLayer = layers.find(l => l.id === selId) ?? null;
  const selectedModel = selectedLayer && selectedLayer.type === 'model' ? selectedLayer : null;

  // Close the mesh/anim popover whenever the model toolbar itself goes away
  // (selection cleared or switched to a non-model layer).
  useEffect(() => {
    if (!selectedModel && studioOpen) setStudioOpen(false);
  }, [selectedModel, studioOpen]);

  // The disc's full visual (glow + black fill + gold ring) is painted by the
  // `.tb-disc-bg` element, z-indexed from the disc layer's array position (so it
  // orders against the models/text by layer order). Its selectable/draggable
  // `.tb-el` proxy stays in the main loop (empty body).
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

      {/* Floating MODEL toolbar — top-left of the artboard, shown only while a
          model layer is selected. Hosts the mesh/animation popover trigger and
          the Face-camera auto-orient, right over the canvas. */}
      {selectedModel && (
        <div className="tb-model-bar">
          <button
            ref={studioBtnRef}
            type="button"
            className={`tb-model-bar__btn${studioOpen ? ' tb-model-bar__btn--active' : ''}`}
            title="Edit meshes & animation"
            onClick={() => setStudioOpen(o => !o)}
          >
            <DlIcon name="settings" size={15} />
            <span>Meshes &amp; animation</span>
          </button>
          <button
            type="button"
            className="tb-model-bar__btn"
            title="Turn the character to face the camera"
            onClick={faceSelectedModel}
          >
            <DlIcon name="target" size={15} />
            <span>Face camera</span>
          </button>
        </div>
      )}
      {selectedModel && studioOpen && (
        <ModelStudioModal
          layer={selectedModel}
          anchorRef={studioBtnRef}
          getMeshes={() => getModelMeshes(selectedModel.id)}
          getClips={() => getModelAnims(selectedModel.id)}
          onChange={(patch, record) => patchModelLayer(selectedModel.id, patch, record)}
          onBeginGesture={onBeginGesture}
          onCommitGesture={onCommitGesture}
          onClose={() => setStudioOpen(false)}
        />
      )}

      <div
        className="tb-stage-wrap"
        ref={stageWrapRef}
        style={{ transform: `translate(${pan.x}px, ${pan.y}px) scale(${zoom})` }}
      >
        <div className={`tb-stage${orbitLayerId ? ' tb-stage--orbiting' : ''}`} ref={stageRef}>
          <div className="tb-env" onPointerDown={handleEnvPointerDown} style={{ background: resolveBackground(hue) }}>
            <span className="tb-env-lbl">environment slot</span>
          </div>
          {/* 3D map-env backdrop — its own Babylon canvas, BEHIND the disc so the
              disc "circle" composites between the map and the models (z-order:
              map → disc → models). Transparent clear lets the .tb-env backdrop
              show through where the map doesn't cover. */}
          <canvas ref={mapCanvasRef} className="tb-map-canvas" style={{ zIndex: mapCanvasZ }} />
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
                zIndex: zOf(discLayer.id),
              }}
            >
              <DiscComposite layer={discLayer} part="full" />
            </div>
          )}
          {/* OFFSCREEN Babylon engine canvas — the shared render target for the
              per-model views. Kept in the DOM (Babylon needs a real canvas) but
              hidden; each model is displayed on its OWN canvas below. */}
          <canvas ref={sceneCanvasRef} className="tb-scene-canvas tb-scene-canvas--offscreen" aria-hidden />
          {/* Per-model view canvases — one per model layer, positioned at the
              layer's box and z-index, so a 2D layer (the disc) can sit BETWEEN
              two models in z-order. The model's own drop-shadow lands on ITS
              canvas. */}
          {sorted.filter((l): l is ModelLayer => l.type === 'model').map(layer => (
            <canvas
              key={`mc-${layer.id}`}
              ref={(el) => {
                if (el) modelCanvasRefs.current.set(layer.id, el);
                else modelCanvasRefs.current.delete(layer.id);
              }}
              className={`tb-model-canvas${layer.id === orbitLayerId ? ' tb-model-canvas--orbit' : ''}`}
              style={{
                left: layer.x,
                top: layer.y,
                width: layer.w,
                height: layer.h,
                zIndex: zOf(layer.id),
                filter: layer.shadow ? shadowFilter(layer) : undefined,
              }}
            />
          ))}
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
                zIndex: zOf(layer.id),
                // Per-layer drop-shadow. Models cast their shadow on their own
                // view canvas (above); the model proxy here is a transparent
                // hit-target only.
                filter: layer.type === 'model' ? undefined : shadowFilter(layer),
              }}
              onPointerDown={(e) => handleElPointerDown(e, layer)}
              onDoubleClick={(e) => {
                if (layer.type === 'text') handleTextDoubleClick(e, layer);
                else if (layer.type === 'model') enterOrbit(layer.id);
              }}
            >
              <LayerBody layer={layer} preset={preset} hue={hue} fontVersion={fontVersion} />
            </div>
          ))}
          {/* Bottom-right corner glow — a soft hue-tinted radial bloom
              (generated, no asset). `screen` blend so it ADDS light (glows)
              rather than darkening. pointer-events:none; sits just under the
              vignette/text so it never blocks editing. */}
          {cornerGlow > 0 && (
            <div
              className="tb-corner-glow"
              style={{
                zIndex: 99998,
                background: `radial-gradient(ellipse 55% 60% at 100% 100%, ${cornerGlowColor(hue, cornerGlow)} 0%, transparent 70%)`,
              }}
            />
          )}
          {/* Vignette — cinematic edge darkening over the whole composition,
              above every layer. pointer-events:none so it never blocks editing.
              A very high z-index keeps it on top regardless of layer count. */}
          {vignette > 0 && (
            <div
              className="tb-vignette"
              style={{
                zIndex: 100000,
                background: `radial-gradient(ellipse 75% 75% at 50% 50%, transparent 40%, rgba(0,0,0,${(vignette / 100) * 0.85}) 100%)`,
              }}
            />
          )}
        </div>
        <SelOverlay
          layer={orbitLayerId ? null : selectedLayer}
          onHandlePointerDown={startResize}
        />
      </div>
      {orbitLayerId && (
        <div className="tb-orbit-hint">
          <span>Editing model · left-drag = turn · alt = tilt · ctrl = roll · right-drag = pan · wheel = scale · dbl-click to reset</span>
          <button className="tb-orbit-hint__exit" onClick={exitOrbit}>Done (Esc)</button>
        </div>
      )}
    </div>
  );
}

function LayerBody({ layer, preset, hue, fontVersion }: { layer: Layer; preset: ThumbnailPresetId; hue: number; fontVersion: number }) {
  // `fontVersion` is consumed only to re-run the text auto-fit when webfonts
  // finish loading (measureText metrics change once the real font is ready).
  void fontVersion;
  if (layer.type === 'text') {
    // Auto-shrink (Task 11): the stored `layer.size` is the user's MAX —
    // the actually-rendered size shrinks (never grows past it) so every
    // line fits the box width and the stacked lines fit the box height.
    // This is a render-only concern; `layer.size` itself is untouched.
    const lines = layer.text.split('\n');
    const fitted = fitFontSize(canvasMeasure(layer), lines, layer.w, layer.h, layer.size);
    // Global mod-hue theme (Task 12) + per-layer treatment: color mixes from
    // the layer's base (cream, or white for Divine) toward the hue by the
    // layer's `hueMix` (falling back to the preset default), and an optional
    // colored glow (same color as the text) is layered into the text-shadow.
    // Everything reacts live to the ThemePanel slider.
    const { color, textShadow } = resolveTextStyle(preset, hue, layer.baseColor ?? TEXT_BASE_COLOR, {
      hueMix: layer.hueMix,
      glow: layer.glow,
      glowStrength: layer.glowStrength,
    });
    return (
      <div
        className="tb-body"
        style={{ fontSize: fitted, fontFamily: layer.font, fontStyle: layer.italic ? 'italic' : 'normal', letterSpacing: layer.spacing, color, textShadow }}
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
  if (layer.type === 'env') {
    // The map env renders in Babylon (no DOM proxy); it's edited from the
    // Layers/Properties panels, not dragged on the artboard.
    return null;
  }
  if (layer.type === 'frame') {
    // The bundled line-art frame (stroke.webp), tinted toward the theme hue.
    return <div className="tb-body tb-frame-body"><FrameComposite layer={layer} hue={hue} /></div>;
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
