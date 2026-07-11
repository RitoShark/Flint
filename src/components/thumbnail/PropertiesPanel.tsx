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
}

type ChangeProps = { onChange: PropertiesPanelProps['onChange']; onBeginGesture: PropertiesPanelProps['onBeginGesture']; onCommitGesture: PropertiesPanelProps['onCommitGesture'] };

/**
 * Placement lock — the SAME state the eye/lock icons in the Layers panel drive
 * (both read/write `layer.locked`). Shown at the top so the current lock state
 * is unambiguous, and the editing controls below are disabled/dimmed while
 * locked so a locked layer never *looks* editable.
 */
function LockRow({ layer, onChange }: { layer: Layer } & Pick<ChangeProps, 'onChange'>) {
  return (
    <div className="tb-grp">
      <label>Placement</label>
      <DlSegmented
        fill
        aria-label="Placement lock"
        value={layer.locked ? 'locked' : 'editable'}
        onChange={(v) => onChange({ locked: v === 'locked' } as LayerPatch, true)}
        options={[
          { value: 'editable', label: 'Editable', icon: 'lockOpen' },
          { value: 'locked', label: 'Locked', icon: 'lockClosed' },
        ]}
      />
      <div className="tb-hint">
        {layer.locked
          ? 'Locked — pinned in place. It can be selected but not moved or resized. Switch to Editable to reposition it.'
          : 'Editable — drag or resize it on the artboard.'}
      </div>
    </div>
  );
}

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

function ModelProps({ layer, onChange, onBeginGesture, onCommitGesture, onOpenModelStudio }: { layer: Extract<Layer, { type: 'model' }> } & ChangeProps & { onOpenModelStudio?: () => void }) {
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
          max={300}
          value={layer.scale}
          bubble={`${(layer.scale / 100).toFixed(2)}×`}
          onPointerDown={onBeginGesture}
          onChange={(v) => onChange({ scale: v }, false)}
          onPointerUp={onCommitGesture}
        />
      </div>
      <div className="tb-grp">
        <label>Orbit <b>{layer.orbit}&deg;</b></label>
        <DlSlider
          min={-180}
          max={180}
          value={layer.orbit}
          bubble={`${layer.orbit}°`}
          onPointerDown={onBeginGesture}
          onChange={(v) => onChange({ orbit: v }, false)}
          onPointerUp={onCommitGesture}
        />
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

export function PropertiesPanel({ layer, onChange, onBeginGesture, onCommitGesture, onOpenModelStudio }: PropertiesPanelProps) {
  // The Placement lock at the top reflects the SAME `layer.locked` the Layers
  // panel toggles — so lock state reads identically in both places (the user's
  // "is it locked or editable?" confusion came from those two controls not
  // obviously being the same thing). Locking gates on-artboard move/resize
  // only; content (text, font, animation, opacity) stays editable.
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
            <LockRow layer={layer} onChange={onChange} />
            {layer.type === 'text' && <TextProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
            {layer.type === 'model' && <ModelProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} onOpenModelStudio={onOpenModelStudio} />}
            {layer.type === 'disc' && <DiscProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
            {layer.type === 'deco' && <DecoProps layer={layer} onChange={onChange} />}
          </>
        )}
      </div>
    </div>
  );
}
