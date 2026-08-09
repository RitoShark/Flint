import { ChangeEvent, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Layer } from '../../lib/thumbnail/layers';
import { DlIcon, DlSegmented, DlSlider } from '../ui/design-lab';

export type LayerPatch = Partial<Layer>;

export interface PropertiesPanelProps {
  layer: Layer | null;
  onChange: (patch: LayerPatch, record: boolean) => void;
  /** Snapshot the pre-gesture baseline (call at slider pointerdown, before the first input). */
  onBeginGesture: () => void;
  /** Record the gesture (baseline vs. final state) onto the undo stack (call on slider pointerup). */
  onCommitGesture: () => void;
}

type ChangeProps = { onChange: PropertiesPanelProps['onChange']; onBeginGesture: PropertiesPanelProps['onBeginGesture']; onCommitGesture: PropertiesPanelProps['onCommitGesture'] };

const round1 = (n: number) => Math.round(n * 10) / 10;

function TextProps({ layer, onChange, onBeginGesture, onCommitGesture }: { layer: Extract<Layer, { type: 'text' }> } & ChangeProps) {
  return (
    <>
      <div className="tb-grp">
        <label>Content</label>
        <input
          className="dl-input"
          value={layer.text}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ text: e.target.value }, false)}
          onBlur={(e) => onChange({ text: e.target.value }, true)}
        />
      </div>
      <div className="tb-grp">
        <label>Font</label>
        <input
          className="dl-input"
          value={layer.font}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ font: e.target.value }, false)}
          onBlur={(e) => onChange({ font: e.target.value }, true)}
        />
      </div>
      <div className="tb-grp">
        <label>Size <b>{layer.size}px</b></label>
        <DlSlider
          min={8}
          max={120}
          value={layer.size}
          bubble={`${layer.size}px`}
          onPointerDown={onBeginGesture}
          onChange={(v) => onChange({ size: v }, false)}
          onPointerUp={onCommitGesture}
        />
      </div>
      <div className="tb-grp">
        <label>Letter spacing <b>{layer.spacing}px</b></label>
        <DlSlider
          min={0}
          max={16}
          value={layer.spacing}
          bubble={`${layer.spacing}px`}
          onPointerDown={onBeginGesture}
          onChange={(v) => onChange({ spacing: v }, false)}
          onPointerUp={onCommitGesture}
        />
      </div>
      <div className="tb-grp">
        <label>Style</label>
        <DlSegmented
          fill
          aria-label="Text style"
          value={layer.italic ? 'italic' : 'regular'}
          onChange={(v) => onChange({ italic: v === 'italic' }, true)}
          options={[
            { value: 'regular', label: 'Regular' },
            { value: 'italic', label: 'Italic' },
          ]}
        />
      </div>
      <div className="tb-grp tb-grp--sep">
        <label>Hue mix <b>{Math.round((layer.hueMix ?? 0) * 100)}%</b></label>
        <DlSlider
          min={0} max={100} value={Math.round((layer.hueMix ?? 0) * 100)}
          bubble={`${Math.round((layer.hueMix ?? 0) * 100)}%`}
          onPointerDown={onBeginGesture}
          onChange={(v) => onChange({ hueMix: v / 100 }, false)}
          onPointerUp={onCommitGesture}
        />
      </div>
      <div className="tb-grp">
        <CheckRow label="Colored glow" checked={!!layer.glow} onChange={(v) => onChange({ glow: v }, true)} />
      </div>
      {layer.glow && (
        <div className="tb-grp">
          <label>Glow strength <b>{Math.round((layer.glowStrength ?? 0.6) * 100)}%</b></label>
          <DlSlider
            min={0} max={100} value={Math.round((layer.glowStrength ?? 0.6) * 100)}
            bubble={`${Math.round((layer.glowStrength ?? 0.6) * 100)}%`}
            onPointerDown={onBeginGesture}
            onChange={(v) => onChange({ glowStrength: v / 100 }, false)}
            onPointerUp={onCommitGesture}
          />
        </div>
      )}
    </>
  );
}

function ModelProps({ layer, onChange, onBeginGesture, onCommitGesture }: { layer: Extract<Layer, { type: 'model' }> } & ChangeProps) {
  const hiddenCount = layer.hiddenMeshes?.length ?? 0;
  const transformTouched =
    !!layer.posX || !!layer.posY || !!layer.posZ || !!layer.tiltX || !!layer.rollZ;
  const [transformOpen, setTransformOpen] = useState(transformTouched);
  return (
    <>
      {(layer.anim || hiddenCount > 0) && (
        <div className="tb-grp">
          <div className="tb-hint">
            {layer.anim ? `${layer.anim.split(/[\\/]/).pop()} · ${layer.frame}/${layer.maxFrame}` : 'No animation'}
            {hiddenCount > 0 ? ` · ${hiddenCount} hidden` : ''}
          </div>
        </div>
      )}
      <div className="tb-grp">
        <label>Scale <b>{(layer.scale / 100).toFixed(2)}&times;</b></label>
        <SliderNum
          min={20} max={600} value={layer.scale} suffix="%"
          onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture}
          onChange={(v, rec) => onChange({ scale: v }, rec)}
        />
      </div>
      <div className="tb-grp">
        <label>Turn — Y</label>
        <SliderNum
          min={-180} max={180} value={layer.orbit} suffix="°"
          onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture}
          onChange={(v, rec) => onChange({ orbit: v }, rec)}
        />
      </div>

      <button
        type="button"
        className="tb-disclose"
        onClick={() => setTransformOpen(v => !v)}
        aria-expanded={transformOpen}
      >
        <span className={`tb-disclose__chev${transformOpen ? ' tb-disclose__chev--open' : ''}`}>
          <DlIcon name="chevronRight" />
        </span>
        <span>Transform</span>
        {!transformOpen && transformTouched && <span className="tb-disclose__dot" />}
      </button>

      {transformOpen && (
        <>
          <div className="tb-grp">
            <label>Move X <b>{round1(layer.posX ?? 0)}</b></label>
            <SliderNum
              min={-500} max={500} step={1} value={round1(layer.posX ?? 0)}
              onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture}
              onChange={(v, rec) => onChange({ posX: v }, rec)}
            />
          </div>
          <div className="tb-grp">
            <label>Move Y <b>{round1(layer.posY ?? 0)}</b></label>
            <SliderNum
              min={-500} max={500} step={1} value={round1(layer.posY ?? 0)}
              onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture}
              onChange={(v, rec) => onChange({ posY: v }, rec)}
            />
          </div>
          <div className="tb-grp">
            <label>Move Z (depth) <b>{round1(layer.posZ ?? 0)}</b></label>
            <SliderNum
              min={-500} max={500} step={1} value={round1(layer.posZ ?? 0)}
              onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture}
              onChange={(v, rec) => onChange({ posZ: v }, rec)}
            />
          </div>
          <div className="tb-grp">
            <label>Tilt — X</label>
            <SliderNum
              min={-180} max={180} value={layer.tiltX ?? 0} suffix="°"
              onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture}
              onChange={(v, rec) => onChange({ tiltX: v }, rec)}
            />
          </div>
          <div className="tb-grp">
            <label>Roll — Z</label>
            <SliderNum
              min={-180} max={180} value={layer.rollZ ?? 0} suffix="°"
              onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture}
              onChange={(v, rec) => onChange({ rollZ: v }, rec)}
            />
          </div>
        </>
      )}
    </>
  );
}

/** Slider + a compact numeric input, side by side. The number field lets the
 *  user type an exact value; both drive the same onChange. `rec` = whether the
 *  change should be recorded on the undo stack (slider drag: false until
 *  pointerup; typed value / commit: true). */
function SliderNum({ min, max, value, suffix, step, onChange, onBeginGesture, onCommitGesture }: {
  min: number; max: number; value: number; suffix?: string; step?: number;
  onChange: (v: number, record: boolean) => void;
  onBeginGesture: () => void; onCommitGesture: () => void;
}) {
  const clamp = (n: number) => Math.max(min, Math.min(max, n));
  return (
    <div className="tb-slidernum">
      <DlSlider
        min={min} max={max} step={step} value={value} bubble={`${value}${suffix ?? ''}`}
        onPointerDown={onBeginGesture}
        onChange={(v) => onChange(v, false)}
        onPointerUp={onCommitGesture}
      />
      <input
        className="dl-input tb-slidernum__in"
        type="number"
        min={min}
        max={max}
        step={step}
        value={value}
        onChange={(e) => {
          const n = Number(e.target.value);
          if (Number.isFinite(n)) onChange(clamp(n), true);
        }}
      />
    </div>
  );
}

/** A labeled toggle row (design-lab `.dl-check`). */
function CheckRow({ label, checked, onChange }: { label: string; checked: boolean; onChange: (v: boolean) => void }) {
  return (
    <label className="dl-check tb-check-row">
      <input type="checkbox" checked={checked} onChange={(e) => onChange(e.target.checked)} />
      <span>{label}</span>
    </label>
  );
}

/** Drop-shadow layer style — shared by every non-env layer. Toggle + blur /
 *  offset / opacity sliders (in the 640×360 stage space). */
function ShadowProps({ layer, onChange, onBeginGesture, onCommitGesture }: { layer: Layer } & ChangeProps) {
  const on = !!layer.shadow;
  return (
    <>
      <div className="tb-grp tb-grp--sep">
        <CheckRow label="Drop shadow" checked={on} onChange={(v) => onChange({ shadow: v } as LayerPatch, true)} />
      </div>
      {on && (
        <>
          <div className="tb-grp">
            <label>Blur <b>{layer.shadowBlur ?? 8}</b></label>
            <SliderNum
              min={0} max={60} value={layer.shadowBlur ?? 8}
              onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture}
              onChange={(v, rec) => onChange({ shadowBlur: v } as LayerPatch, rec)}
            />
          </div>
          <div className="tb-grp">
            <label>Offset X <b>{layer.shadowOffsetX ?? 0}</b></label>
            <SliderNum
              min={-60} max={60} value={layer.shadowOffsetX ?? 0}
              onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture}
              onChange={(v, rec) => onChange({ shadowOffsetX: v } as LayerPatch, rec)}
            />
          </div>
          <div className="tb-grp">
            <label>Offset Y <b>{layer.shadowOffsetY ?? 6}</b></label>
            <SliderNum
              min={-60} max={60} value={layer.shadowOffsetY ?? 6}
              onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture}
              onChange={(v, rec) => onChange({ shadowOffsetY: v } as LayerPatch, rec)}
            />
          </div>
          <div className="tb-grp">
            <label>Opacity <b>{Math.round((layer.shadowOpacity ?? 0.5) * 100)}%</b></label>
            <DlSlider
              min={0} max={100} value={Math.round((layer.shadowOpacity ?? 0.5) * 100)}
              bubble={`${Math.round((layer.shadowOpacity ?? 0.5) * 100)}%`}
              onPointerDown={onBeginGesture}
              onChange={(v) => onChange({ shadowOpacity: v / 100 } as LayerPatch, false)}
              onPointerUp={onCommitGesture}
            />
          </div>
        </>
      )}
    </>
  );
}

function FrameProps({ layer, onChange, onBeginGesture, onCommitGesture }: { layer: Extract<Layer, { type: 'frame' }> } & ChangeProps) {
  return (
    <div className="tb-grp">
      <label>Hue tint <b>{Math.round(layer.tint * 100)}%</b></label>
      <DlSlider
        min={0} max={100} value={Math.round(layer.tint * 100)}
        bubble={`${Math.round(layer.tint * 100)}%`}
        onPointerDown={onBeginGesture}
        onChange={(v) => onChange({ tint: v / 100 }, false)}
        onPointerUp={onCommitGesture}
      />
      <div className="tb-hint">The frame art recolors toward the theme hue. Move/resize it on the artboard.</div>
    </div>
  );
}

function DiscProps({ layer, onChange, onBeginGesture, onCommitGesture }: { layer: Extract<Layer, { type: 'disc' }> } & ChangeProps) {
  return (
    <div className="tb-grp">
      <label>Interior darkness <b>{layer.opacity}%</b></label>
      <DlSlider
        min={0}
        max={100}
        value={layer.opacity}
        bubble={`${layer.opacity}%`}
        onPointerDown={onBeginGesture}
        onChange={(v) => onChange({ opacity: v }, false)}
        onPointerUp={onCommitGesture}
      />
    </div>
  );
}

function DecoProps({ layer, onChange }: { layer: Extract<Layer, { type: 'deco' }>; onChange: PropertiesPanelProps['onChange'] }) {
  return (
    <>
      <div className="tb-grp">
        <label>Asset</label>
        <input
          className="dl-input"
          placeholder="drop your corner PNG path here"
          value={layer.asset}
          onChange={(e: ChangeEvent<HTMLInputElement>) => onChange({ asset: e.target.value }, false)}
          onBlur={(e) => onChange({ asset: e.target.value }, true)}
        />
      </div>
      <div className="tb-grp">
        <label>Depth</label>
        <DlSegmented
          fill
          aria-label="Decoration depth"
          value={layer.z}
          onChange={(v) => onChange({ z: v as 'behind' | 'front' }, true)}
          options={[
            { value: 'behind', label: 'Behind models' },
            { value: 'front', label: 'In front' },
          ]}
        />
      </div>
    </>
  );
}

function EnvProps({ layer, onChange }: { layer: Extract<Layer, { type: 'env' }>; onChange: PropertiesPanelProps['onChange'] }) {
  const active = layer.variations.find(v => v.name === layer.activeVariation) ?? layer.variations[0];
  const slots = active ? Object.keys(active.textures) : [];

  const setSlotTexture = (slot: string, value: string) => {
    const variations = layer.variations.map(v =>
      v.name === active?.name ? { ...v, textures: { ...v.textures, [slot]: value } } : v,
    );
    onChange({ variations } as Partial<Layer>, true);
  };

  const browse = async (slot: string) => {
    const picked = await open({
      multiple: false,
      filters: [{ name: 'Image', extensions: ['webp', 'png', 'jpg', 'jpeg', 'tex', 'dds'] }],
    });
    if (typeof picked === 'string') setSlotTexture(slot, picked);
  };

  const addVariation = () => {
    const base = active ?? layer.variations[0];
    let n = layer.variations.length + 1;
    let name = `Variation ${n}`;
    while (layer.variations.some(v => v.name === name)) { n += 1; name = `Variation ${n}`; }
    const variations = [...layer.variations, { name, textures: { ...(base?.textures ?? {}) } }];
    onChange({ variations, activeVariation: name } as Partial<Layer>, true);
  };

  return (
    <>
      <div className="tb-grp">
        <label>Variation (chroma)</label>
        <div className="dl-row" style={{ gap: 6 }}>
          <select
            className="dl-select"
            style={{ flex: 1 }}
            value={active?.name ?? ''}
            onChange={(e) => onChange({ activeVariation: e.target.value } as Partial<Layer>, true)}
          >
            {layer.variations.map(v => <option key={v.name} value={v.name}>{v.name}</option>)}
          </select>
          <button className="dl-btn dl-btn--secondary dl-btn--sm" onClick={addVariation}>+ New</button>
        </div>
      </div>
      <div className="tb-grp">
        <label>Map textures</label>
        {slots.length === 0 && <div className="tb-hint">Map not loaded yet.</div>}
        {slots.map(slot => (
          <div key={slot} className="tb-env-slot">
            <span className="tb-env-slot__name" title={slot}>{slot.replace(/_MAT$/, '')}</span>
            <div className="dl-row" style={{ gap: 4 }}>
              <input
                className="dl-input"
                style={{ flex: 1, minWidth: 0 }}
                value={active?.textures[slot] ?? ''}
                onChange={(e: ChangeEvent<HTMLInputElement>) => setSlotTexture(slot, e.target.value)}
              />
              <button className="dl-btn dl-btn--ghost dl-btn--sm" onClick={() => browse(slot)}>…</button>
            </div>
          </div>
        ))}
      </div>
      <div className="tb-hint">The map's placement is fixed (environment). Only its textures / variations are editable.</div>
    </>
  );
}

const TITLES: Record<Layer['type'], string> = {
  text: 'Text',
  model: 'Model',
  disc: 'Black fill',
  deco: 'Corner texture',
  env: 'Map',
  frame: 'Frame',
};

const TITLE_ICON: Record<Layer['type'], Parameters<typeof DlIcon>[0]['name']> = {
  text: 'layerText',
  model: 'layerModel',
  disc: 'contrast',
  deco: 'picture',
  env: 'picture',
  frame: 'picture',
};

export function PropertiesPanel({ layer, onChange, onBeginGesture, onCommitGesture }: PropertiesPanelProps) {
  // Lock is driven entirely from the Layers panel's lock icon — no lock control
  // here (it was redundant and confusing). Properties shows only the layer's
  // own editable attributes.
  return (
    <div className="tb-side-sec tb-side-sec--props">
      <div className="tb-pane-h">
        {layer ? <><DlIcon name={TITLE_ICON[layer.type]} size={13} style={{ marginRight: 6 }} />{TITLES[layer.type]}</> : 'Properties'}
      </div>
      <div className="tb-prop tb-side-scroll">
        {!layer ? (
          <div className="tb-empty-prop">Select a layer to edit it.</div>
        ) : (
          <>
            {layer.type === 'text' && <TextProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
            {layer.type === 'model' && <ModelProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
            {layer.type === 'disc' && <DiscProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
            {layer.type === 'deco' && <DecoProps layer={layer} onChange={onChange} />}
            {layer.type === 'frame' && <FrameProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
            {layer.type === 'env' && <EnvProps layer={layer} onChange={onChange} />}
            {/* Drop-shadow layer style — every layer except the fixed map. */}
            {layer.type !== 'env' && <ShadowProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
          </>
        )}
      </div>
    </div>
  );
}
