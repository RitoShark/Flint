import { useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { ModelLayer } from '../../lib/thumbnail/layers';
import { AnimClip, MeshInfo } from '../../lib/thumbnail/studioScene';
import { DlButton, DlIcon, DlSegmented, DlSelect, DlSlider } from '../ui/design-lab';

export interface ModelStudioModalProps {
  layer: ModelLayer;
  /** Live getters — the SKN loads async, so the modal polls these until the
   *  submesh/clip lists populate rather than capturing a one-shot snapshot. */
  getMeshes: () => MeshInfo[];
  getClips: () => AnimClip[];
  onChange: (patch: Partial<ModelLayer>, record: boolean) => void;
  onBeginGesture: () => void;
  onCommitGesture: () => void;
  onClose: () => void;
}

/**
 * Mesh & Animation studio for a single model layer — a design-lab popup that
 * lets the user pick which submeshes to show/hide, which animation clip to
 * play, and which frame to freeze on. Edits flow straight to the model layer
 * (`hiddenMeshes`, `anim`, `frame`); the artboard reconciles them into the
 * Babylon scene live, so changes preview immediately behind the modal.
 */
export function ModelStudioModal({ layer, getMeshes, getClips, onChange, onBeginGesture, onCommitGesture, onClose }: ModelStudioModalProps) {
  useEffect(() => {
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') onClose(); };
    window.addEventListener('keydown', onKey);
    return () => window.removeEventListener('keydown', onKey);
  }, [onClose]);

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
    <div className="dl-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dl-modal dl-modal--wide" onMouseDown={(e) => e.stopPropagation()}>
        <div className="dl-modal__head">
          <h3 className="dl-modal__title"><DlIcon name="model" style={{ marginRight: 8 }} />Meshes &amp; animation — {layer.name}</h3>
          <button className="dl-modal__close" onClick={onClose} title="Close"><DlIcon name="close" /></button>
        </div>
        <div className="dl-modal__body tb-studio">
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
              <div className="tb-hint">Head auto-focuses the character's head/face with a slight zoom.</div>
            </div>
            <div className="tb-studio__head" style={{ marginTop: 12 }}>
              <span className="tb-studio__title">Animation</span>
            </div>
            <div className="tb-grp">
              <label>Clip</label>
              <DlSelect
                width="100%"
                value={layer.anim || (animOptions[0]?.value ?? null)}
                onChange={(v) => onChange({ anim: v }, true)}
                options={animOptions}
                placeholder={clips.length === 0 ? 'No animations' : 'Select clip'}
                disabled={clips.length === 0}
              />
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
              <div className="tb-hint">Pick the exact pose frame the poster freezes on.</div>
            </div>
          </section>
        </div>
        <div className="dl-modal__foot" style={{ padding: 12, display: 'flex', justifyContent: 'flex-end' }}>
          <DlButton variant="primary" onClick={onClose}>Done</DlButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
