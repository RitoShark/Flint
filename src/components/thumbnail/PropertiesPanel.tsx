import { ChangeEvent } from 'react';
import { Layer } from '../../lib/thumbnail/layers';
import { DlIcon, DlSegmented, DlButton, DlSlider } from '../ui/design-lab';

export type LayerPatch = Partial<Layer>;

export interface PropertiesPanelProps {
  layer: Layer | null;
  onChange: (patch: LayerPatch, record: boolean) => void;
  /** Snapshot the pre-gesture baseline (call at slider pointerdown, before the first input). */
  onBeginGesture: () => void;
  /** Record the gesture (baseline vs. final state) onto the undo stack (call on slider pointerup). */
  onCommitGesture: () => void;
  /** Open the mesh & animation studio popup for the current model layer. */
  onOpenModelStudio?: () => void;
  /** Auto-rotate the current model layer so its face points at the camera. */
  onFaceCamera?: () => void;
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

function ModelProps({ layer, onChange, onBeginGesture, onCommitGesture, onOpenModelStudio, onFaceCamera }: { layer: Extract<Layer, { type: 'model' }> } & ChangeProps & { onOpenModelStudio?: () => void; onFaceCamera?: () => void }) {
  const hiddenCount = layer.hiddenMeshes?.length ?? 0;
  return (
    <>
      <div className="tb-grp">
        <label>Meshes &amp; animation</label>
        <DlButton fullWidth variant="secondary" icon="settings" onClick={onOpenModelStudio}>
          Edit meshes &amp; animation…
        </DlButton>
        <div className="tb-hint">
          {layer.anim ? `Clip: ${layer.anim.split(/[\\/]/).pop()} · frame ${layer.frame}/${layer.maxFrame}` : 'No animation selected'}
          {hiddenCount > 0 ? ` · ${hiddenCount} mesh${hiddenCount === 1 ? '' : 'es'} hidden` : ''}
        </div>
      </div>
      <div className="tb-grp">
        <label>Scale <b>{(layer.scale / 100).toFixed(2)}&times;</b></label>
        <DlSlider
          min={20}
          max={600}
          value={layer.scale}
          bubble={`${(layer.scale / 100).toFixed(2)}×`}
          onPointerDown={onBeginGesture}
          onChange={(v) => onChange({ scale: v }, false)}
          onPointerUp={onCommitGesture}
        />
      </div>
      <div className="tb-grp">
        <label>Turn — Y <b>{layer.orbit}&deg;</b></label>
        <DlSlider
          min={-180}
          max={180}
          value={layer.orbit}
          bubble={`${layer.orbit}°`}
          onPointerDown={onBeginGesture}
          onChange={(v) => onChange({ orbit: v }, false)}
          onPointerUp={onCommitGesture}
        />
        <DlButton fullWidth size="sm" variant="ghost" icon="target" onClick={onFaceCamera} title="Auto-rotate so the character's face points at the camera">
          Face camera
        </DlButton>
        <div className="tb-hint">Rotate the character left/right — straighten a diagonal pose to face front. “Face camera” auto-turns them toward you.</div>
      </div>
      <div className="tb-grp">
        <label>Tilt — X <b>{layer.tiltX ?? 0}&deg;</b></label>
        <DlSlider
          min={-180}
          max={180}
          value={layer.tiltX ?? 0}
          bubble={`${layer.tiltX ?? 0}°`}
          onPointerDown={onBeginGesture}
          onChange={(v) => onChange({ tiltX: v }, false)}
          onPointerUp={onCommitGesture}
        />
        <div className="tb-hint">Lean the character forward/back.</div>
      </div>
      <div className="tb-grp">
        <label>Roll — Z <b>{layer.rollZ ?? 0}&deg;</b></label>
        <DlSlider
          min={-180}
          max={180}
          value={layer.rollZ ?? 0}
          bubble={`${layer.rollZ ?? 0}°`}
          onPointerDown={onBeginGesture}
          onChange={(v) => onChange({ rollZ: v }, false)}
          onPointerUp={onCommitGesture}
        />
        <div className="tb-hint">Spin the character in the picture plane (roll). Ctrl+left-drag in edit mode does the same.</div>
      </div>
    </>
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

const TITLES: Record<Layer['type'], string> = {
  text: 'Text',
  model: 'Model',
  disc: 'Black fill',
  deco: 'Corner texture',
};

const TITLE_ICON: Record<Layer['type'], Parameters<typeof DlIcon>[0]['name']> = {
  text: 'layerText',
  model: 'layerModel',
  disc: 'contrast',
  deco: 'picture',
};

export function PropertiesPanel({ layer, onChange, onBeginGesture, onCommitGesture, onOpenModelStudio, onFaceCamera }: PropertiesPanelProps) {
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
            {layer.type === 'model' && <ModelProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} onOpenModelStudio={onOpenModelStudio} onFaceCamera={onFaceCamera} />}
            {layer.type === 'disc' && <DiscProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
            {layer.type === 'deco' && <DecoProps layer={layer} onChange={onChange} />}
          </>
        )}
      </div>
    </div>
  );
}
