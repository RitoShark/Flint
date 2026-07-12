import { ChangeEvent } from 'react';
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
    </>
  );
}

function ModelProps({ layer, onChange, onBeginGesture, onCommitGesture }: { layer: Extract<Layer, { type: 'model' }> } & ChangeProps) {
  const hiddenCount = layer.hiddenMeshes?.length ?? 0;
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

const DEG = 180 / Math.PI;

function EnvProps({ layer, onChange, onBeginGesture, onCommitGesture }: { layer: Extract<Layer, { type: 'env' }> } & ChangeProps) {
  const active = layer.variations.find(v => v.name === layer.activeVariation) ?? layer.variations[0];
  const slots = active ? Object.keys(active.textures) : [];

  const [rx, ry, rz] = layer.rotation;
  const [px, py, pz] = layer.position;
  const setPos = (i: number, v: number, record: boolean) => {
    const position = [...layer.position] as [number, number, number];
    position[i] = v;
    onChange({ position } as Partial<Layer>, record);
  };
  // Rotation is stored in RADIANS (Babylon-native) but shown/edited in DEGREES.
  const setRotDeg = (i: number, deg: number, record: boolean) => {
    const rotation = [...layer.rotation] as [number, number, number];
    rotation[i] = deg / DEG;
    onChange({ rotation } as Partial<Layer>, record);
  };
  const round1 = (n: number) => Math.round(n * 10) / 10;

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
        <label>Position X <b>{round1(px)}</b></label>
        <SliderNum min={-50} max={50} step={0.5} value={round1(px)} onChange={(v, r) => setPos(0, v, r)} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />
      </div>
      <div className="tb-grp">
        <label>Position Y <b>{round1(py)}</b></label>
        <SliderNum min={-50} max={50} step={0.5} value={round1(py)} onChange={(v, r) => setPos(1, v, r)} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />
      </div>
      <div className="tb-grp">
        <label>Position Z <b>{round1(pz)}</b></label>
        <SliderNum min={-50} max={50} step={0.5} value={round1(pz)} onChange={(v, r) => setPos(2, v, r)} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />
      </div>
      <div className="tb-grp">
        <label>Rotation X <b>{Math.round(rx * DEG)}°</b></label>
        <SliderNum min={-180} max={180} suffix="°" value={Math.round(rx * DEG)} onChange={(v, r) => setRotDeg(0, v, r)} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />
      </div>
      <div className="tb-grp">
        <label>Rotation Y <b>{Math.round(ry * DEG)}°</b></label>
        <SliderNum min={-180} max={180} suffix="°" value={Math.round(ry * DEG)} onChange={(v, r) => setRotDeg(1, v, r)} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />
      </div>
      <div className="tb-grp">
        <label>Rotation Z <b>{Math.round(rz * DEG)}°</b></label>
        <SliderNum min={-180} max={180} suffix="°" value={Math.round(rz * DEG)} onChange={(v, r) => setRotDeg(2, v, r)} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />
      </div>
      <div className="tb-grp">
        <label>Scale <b>{round1(layer.mapScale)}</b></label>
        <SliderNum min={0.1} max={10} step={0.1} value={round1(layer.mapScale)} onChange={(v, r) => onChange({ mapScale: v } as Partial<Layer>, r)} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />
      </div>
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
      <div className="tb-hint">Pose the map with the values above, then send me the numbers to bake as the default.</div>
    </>
  );
}

const TITLES: Record<Layer['type'], string> = {
  text: 'Text',
  model: 'Model',
  disc: 'Black fill',
  deco: 'Corner texture',
  env: 'Map',
};

const TITLE_ICON: Record<Layer['type'], Parameters<typeof DlIcon>[0]['name']> = {
  text: 'layerText',
  model: 'layerModel',
  disc: 'contrast',
  deco: 'picture',
  env: 'picture',
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
            {layer.type === 'env' && <EnvProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
          </>
        )}
      </div>
    </div>
  );
}
