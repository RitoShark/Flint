import { useEffect, useLayoutEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { open } from '@tauri-apps/plugin-dialog';
import { ModelLayer } from '../../lib/thumbnail/layers';
import { AnimClip, MeshInfo } from '../../lib/thumbnail/studioScene';
import { DlButton, DlIcon, DlSegmented, DlSelect, DlSlider } from '../ui/design-lab';

export interface ModelStudioModalProps {
  layer: ModelLayer;
  /** The trigger button the popover anchors to — position is derived from its
   *  on-screen rect (like the SKN preview's corner popups). */
  anchorRef: React.RefObject<HTMLElement>;
  /** Live getters — the SKN loads async, so the popover polls these until the
   *  submesh/clip lists populate rather than capturing a one-shot snapshot. */
  getMeshes: () => MeshInfo[];
  getClips: () => AnimClip[];
  /** Load clips from a manually-picked `.anm` folder, overriding skin-BIN
   *  derivation. Resolves to the clips now available (empty = folder held no
   *  `.anm` files). */
  onPickAnimFolder: (dir: string) => Promise<AnimClip[]>;
  onChange: (patch: Partial<ModelLayer>, record: boolean) => void;
  onBeginGesture: () => void;
  onCommitGesture: () => void;
  onClose: () => void;
}

const POP_W = 460; // popover width (px)

/**
 * Mesh & Animation studio for a single model layer — an anchored design-lab
 * POPOVER (not a centered modal) that floats next to its trigger button, the
 * same interaction as the SKN preview's corner popups: click-outside or Esc to
 * close, no dimming backdrop. Lets the user pick which submeshes to show/hide,
 * which animation clip to play, and which frame to freeze on. Edits flow
 * straight to the model layer (`hiddenMeshes`, `anim`, `frame`); the artboard
 * reconciles them into the Babylon scene live, so changes preview immediately.
 */
export function ModelStudioModal({ layer, anchorRef, getMeshes, getClips, onPickAnimFolder, onChange, onBeginGesture, onCommitGesture, onClose }: ModelStudioModalProps) {
  const popRef = useRef<HTMLDivElement>(null);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const [picking, setPicking] = useState(false);
  const [pickError, setPickError] = useState<string | null>(null);

  // Point the model at a folder of `.anm` files, for projects whose clips
  // aren't reachable from the skin BIN. Selecting the first clip immediately
  // is deliberate: the artist picked a folder to GET an animation, so landing
  // on one saves a second interaction.
  const pickAnimFolder = async () => {
    setPickError(null);
    const dir = await open({ title: 'Select folder of .anm animations', directory: true });
    if (typeof dir !== 'string') return; // cancelled
    setPicking(true);
    try {
      const found = await onPickAnimFolder(dir);
      if (found.length === 0) {
        setPickError('No .anm files in that folder.');
        return;
      }
      onChange({ animDir: dir, anim: found[0].animation_path, frame: 0 }, true);
    } catch (e) {
      setPickError(e instanceof Error ? e.message : String(e));
    } finally {
      setPicking(false);
    }
  };

  // Position the popover next to its anchor button, opening to the LEFT of the
  // properties panel (the panel hugs the right edge) and clamped to the
  // viewport so it never spills off-screen.
  useLayoutEffect(() => {
    const anchor = anchorRef.current;
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const margin = 8;
      // Prefer left of the anchor; fall back to right if there's no room.
      let left = r.left - POP_W - margin;
      if (left < margin) left = Math.min(r.right + margin, window.innerWidth - POP_W - margin);
      left = Math.max(margin, left);
      let top = r.top;
      const h = popRef.current?.offsetHeight ?? 360;
      if (top + h > window.innerHeight - margin) top = Math.max(margin, window.innerHeight - h - margin);
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [anchorRef]);

  // Close on Esc or a click outside the popover + its trigger.
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t)) return;
      if (anchorRef.current?.contains(t)) return;
      onClose();
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [onClose, anchorRef]);

  // Poll the live scene until the SKN's submeshes/clips have loaded (the model
  // may still be loading when the popup opens), then stop.
  const [meshes, setMeshes] = useState<MeshInfo[]>(() => getMeshes());
  const [clips, setClips] = useState<AnimClip[]>(() => getClips());
  useEffect(() => {
    let raf = 0;
    let stop = false;
    const poll = () => {
      if (stop) return;
      const m = getMeshes();
      const c = getClips();
      setMeshes(m);
      setClips(c);
      if (m.length === 0 || c.length === 0) {
        raf = window.setTimeout(poll, 200) as unknown as number;
      }
    };
    poll();
    return () => { stop = true; if (raf) clearTimeout(raf); };
  }, [getMeshes, getClips]);

  const hidden = useMemo(() => new Set(layer.hiddenMeshes ?? []), [layer.hiddenMeshes]);

  const animOptions = clips.length > 0
    ? clips.map(c => ({ value: c.animation_path, label: c.name || c.animation_path.split(/[\\/]/).pop() || c.animation_path }))
    : (layer.anim ? [{ value: layer.anim, label: layer.anim }] : []);

  const toggleMesh = (name: string) => {
    const next = new Set(hidden);
    if (next.has(name)) next.delete(name);
    else next.add(name);
    onChange({ hiddenMeshes: [...next] }, true);
  };

  const setAll = (show: boolean) => {
    onChange({ hiddenMeshes: show ? [] : meshes.map(m => m.name) }, true);
  };

  const shownCount = meshes.length - hidden.size;

  return createPortal(
    <div
      ref={popRef}
      className="tb-studio-pop"
      style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: POP_W, visibility: pos ? 'visible' : 'hidden' }}
      onMouseDown={(e) => e.stopPropagation()}
    >
      <div className="tb-studio-pop__head">
        <span className="tb-studio-pop__title"><DlIcon name="model" size={14} style={{ marginRight: 8 }} />Meshes &amp; animation — {layer.name}</span>
        <button className="tb-studio-pop__close" onClick={onClose} title="Close"><DlIcon name="close" size={14} /></button>
      </div>
      <div className="tb-studio-pop__body tb-studio">
        {/* ── Meshes ── */}
        <section className="tb-studio__col">
          <div className="tb-studio__head">
            <span className="tb-studio__title">Meshes <span className="tb-studio__count">{shownCount}/{meshes.length} shown</span></span>
            <div className="tb-studio__actions">
              <DlButton size="sm" variant="ghost" onClick={() => setAll(true)} disabled={hidden.size === 0}>Show all</DlButton>
              <DlButton size="sm" variant="ghost" onClick={() => setAll(false)} disabled={hidden.size === meshes.length && meshes.length > 0}>Hide all</DlButton>
            </div>
          </div>
          <div className="tb-studio__list">
            {meshes.length === 0 ? (
              <div className="tb-studio__empty">Loading meshes…</div>
            ) : (
              meshes.map(m => {
                const isHidden = hidden.has(m.name);
                return (
                  <button
                    key={m.name}
                    type="button"
                    className={`tb-mesh-row${isHidden ? ' tb-mesh-row--off' : ''}`}
                    onClick={() => toggleMesh(m.name)}
                    title={isHidden ? 'Hidden — click to show' : 'Visible — click to hide'}
                  >
                    <DlIcon name={isHidden ? 'eye-off' : 'eye'} size={14} />
                    <span className="tb-mesh-row__nm">{m.name}</span>
                  </button>
                );
              })
            )}
          </div>
        </section>

        {/* ── Animation + framing ── */}
        <section className="tb-studio__col">
          <div className="tb-studio__head">
            <span className="tb-studio__title">Framing</span>
          </div>
          <div className="tb-grp">
            <DlSegmented
              fill
              aria-label="Camera framing"
              value={layer.focusMode ?? 'full'}
              onChange={(v) => onChange({ focusMode: v as 'full' | 'head' }, true)}
              options={[
                { value: 'full', label: 'Full body' },
                { value: 'head', label: 'Head' },
              ]}
            />
          </div>
          <div className="tb-studio__head" style={{ marginTop: 12 }}>
            <span className="tb-studio__title">Animation</span>
          </div>
          <div className="tb-grp">
            <label>Clip</label>
            <div className="tb-clip-row">
              <DlSelect
                width="100%"
                value={layer.anim || (animOptions[0]?.value ?? null)}
                onChange={(v) => onChange({ anim: v }, true)}
                options={animOptions}
                placeholder={clips.length === 0 ? 'No animations' : 'Select clip'}
                disabled={clips.length === 0}
              />
              {/* Stays enabled even with an empty dropdown — an empty list is
                  exactly when the artist needs to point at a folder. */}
              <DlButton
                size="sm"
                variant="ghost"
                onClick={pickAnimFolder}
                disabled={picking}
                title={layer.animDir
                  ? `Animations from: ${layer.animDir}`
                  : 'Load animations from a folder of .anm files'}
              >
                <DlIcon name={picking ? 'refresh' : 'folder'} size={14} />
              </DlButton>
            </div>
            {pickError && <div className="tb-clip-note tb-clip-note--err">{pickError}</div>}
            {!pickError && layer.animDir && (
              <div className="tb-clip-note" title={layer.animDir}>
                {clips.length} clips from folder
              </div>
            )}
          </div>
          <div className="tb-grp">
            <label>Frame <b>{layer.frame} / {layer.maxFrame}</b></label>
            <DlSlider
              min={0}
              max={layer.maxFrame}
              value={layer.frame}
              bubble={`${layer.frame}`}
              onPointerDown={onBeginGesture}
              onChange={(v) => onChange({ frame: v }, false)}
              onPointerUp={onCommitGesture}
            />
          </div>
        </section>
      </div>
    </div>,
    document.body,
  );
}
