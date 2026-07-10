import { ChangeEvent } from 'react';
import { Layer } from '../../lib/thumbnail/layers';

const ANIMS = ['idle1.anm', 'idle_in.anm', 'recall.anm', 'run.anm', 'spell1.anm'];

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

function LockRow({ layer, onChange }: { layer: Layer } & Pick<ChangeProps, 'onChange'>) {
  return (
    <div className="tb-grp">
      <label>Placement</label>
      <div className="seg">
        <div className={layer.locked ? '' : 'on'} onClick={() => onChange({ locked: false } as LayerPatch, true)}>
          Editable
        </div>
        <div className={layer.locked ? 'on' : ''} onClick={() => onChange({ locked: true } as LayerPatch, true)}>
          🔒 Locked
        </div>
      </div>
      <div className="tb-hint">Locked = pinned in place; it can be selected but not moved or resized.</div>
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
        <input
          className="rng"
          type="range"
          min={8}
          max={120}
          value={layer.size}
          onPointerDown={onBeginGesture}
          onChange={(e) => onChange({ size: Number(e.target.value) }, false)}
          onPointerUp={onCommitGesture}
        />
      </div>
      <div className="tb-grp">
        <label>Letter spacing <b>{layer.spacing}px</b></label>
        <input
          className="rng"
          type="range"
          min={0}
          max={16}
          value={layer.spacing}
          onPointerDown={onBeginGesture}
          onChange={(e) => onChange({ spacing: Number(e.target.value) }, false)}
          onPointerUp={onCommitGesture}
        />
      </div>
      <div className="tb-grp">
        <label>Style</label>
        <div className="seg">
          <div className={layer.italic ? '' : 'on'} onClick={() => onChange({ italic: false }, true)}>Regular</div>
          <div className={layer.italic ? 'on' : ''} onClick={() => onChange({ italic: true }, true)}>Italic</div>
        </div>
      </div>
    </>
  );
}

function ModelProps({ layer, onChange, onBeginGesture, onCommitGesture }: { layer: Extract<Layer, { type: 'model' }> } & ChangeProps) {
  return (
    <>
      <div className="tb-grp">
        <label>Animation</label>
        <select
          className="dl-select"
          value={layer.anim}
          onChange={(e) => onChange({ anim: e.target.value }, true)}
        >
          {(ANIMS.includes(layer.anim) ? ANIMS : [layer.anim, ...ANIMS]).map(a => (
            <option key={a} value={a}>{a}</option>
          ))}
        </select>
      </div>
      <div className="tb-grp">
        <label>Frame <b>{layer.frame} / {layer.maxFrame}</b></label>
        <input
          className="rng"
          type="range"
          min={0}
          max={layer.maxFrame}
          value={layer.frame}
          onPointerDown={onBeginGesture}
          onChange={(e) => onChange({ frame: Number(e.target.value) }, false)}
          onPointerUp={onCommitGesture}
        />
      </div>
      <div className="tb-grp">
        <label>Scale <b>{(layer.scale / 100).toFixed(2)}&times;</b></label>
        <input
          className="rng"
          type="range"
          min={20}
          max={300}
          value={layer.scale}
          onPointerDown={onBeginGesture}
          onChange={(e) => onChange({ scale: Number(e.target.value) }, false)}
          onPointerUp={onCommitGesture}
        />
      </div>
      <div className="tb-grp">
        <label>Orbit <b>{layer.orbit}&deg;</b></label>
        <input
          className="rng"
          type="range"
          min={-180}
          max={180}
          value={layer.orbit}
          onPointerDown={onBeginGesture}
          onChange={(e) => onChange({ orbit: Number(e.target.value) }, false)}
          onPointerUp={onCommitGesture}
        />
      </div>
    </>
  );
}

function DiscProps({ layer, onChange, onBeginGesture, onCommitGesture }: { layer: Extract<Layer, { type: 'disc' }> } & ChangeProps) {
  return (
    <div className="tb-grp">
      <label>Opacity <b>{layer.opacity}%</b></label>
      <input
        className="rng"
        type="range"
        min={0}
        max={100}
        value={layer.opacity}
        onPointerDown={onBeginGesture}
        onChange={(e) => onChange({ opacity: Number(e.target.value) }, false)}
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
        <div className="seg">
          <div className={layer.z === 'behind' ? 'on' : ''} onClick={() => onChange({ z: 'behind' }, true)}>Behind models</div>
          <div className={layer.z === 'front' ? 'on' : ''} onClick={() => onChange({ z: 'front' }, true)}>In front</div>
        </div>
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

export function PropertiesPanel({ layer, onChange, onBeginGesture, onCommitGesture }: PropertiesPanelProps) {
  return (
    <div className="tb-side-sec tb-side-sec--props">
      <div className="tb-pane-h">{layer ? TITLES[layer.type] : 'Properties'}</div>
      <div className="tb-prop tb-side-scroll">
        {!layer ? (
          <div className="tb-empty-prop">Select a layer to edit it.</div>
        ) : (
          <>
            {layer.type === 'text' && <TextProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
            {layer.type === 'model' && <ModelProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
            {layer.type === 'disc' && <DiscProps layer={layer} onChange={onChange} onBeginGesture={onBeginGesture} onCommitGesture={onCommitGesture} />}
            {layer.type === 'deco' && <DecoProps layer={layer} onChange={onChange} />}
            <LockRow layer={layer} onChange={onChange} />
          </>
        )}
      </div>
    </div>
  );
}
