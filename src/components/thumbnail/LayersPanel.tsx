import { Ref } from 'react';
import { Layer } from '../../lib/thumbnail/layers';
import { DlIcon, type DlIconName } from '../ui/design-lab';

interface LayerGroup {
  title: string;
  items: Layer[];
}

function groupLayers(layers: Layer[]): LayerGroup[] {
  return [
    {
      title: 'Foreground',
      items: layers.filter(l => l.type === 'text' || (l.type === 'deco' && l.z === 'front')),
    },
    {
      title: 'Models & fills',
      items: layers.filter(l => l.type === 'model' || l.type === 'disc'),
    },
    {
      title: 'Behind models',
      items: layers.filter(l => l.type === 'deco' && l.z === 'behind'),
    },
  ];
}

function iconFor(type: Layer['type']): DlIconName {
  switch (type) {
    case 'text': return 'text';
    case 'model': return 'model';
    case 'disc': return 'contrast';
    case 'deco': return 'picture';
    default: return 'image';
  }
}

interface LayerRowProps {
  layer: Layer;
  selected: boolean;
  onSelect: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onToggleLock: (id: string) => void;
  onDelete: (id: string) => void;
}

function LayerRow({ layer, selected, onSelect, onToggleHidden, onToggleLock, onDelete }: LayerRowProps) {
  return (
    <div
      className={`tb-layer${selected ? ' tb-layer--sel' : ''}${layer.hidden ? ' tb-layer--hidden' : ''}`}
      onClick={() => onSelect(layer.id)}
    >
      <button
        type="button"
        className="tb-layer__btn tb-layer__eye"
        title={layer.hidden ? 'Hidden — click to show' : 'Visible — click to hide'}
        onClick={(e) => { e.stopPropagation(); onToggleHidden(layer.id); }}
      >
        <DlIcon name={layer.hidden ? 'eye-off' : 'eye'} size={14} />
      </button>
      <span className="tb-layer__ic"><DlIcon name={iconFor(layer.type)} size={14} /></span>
      <span className="tb-layer__nm">{layer.name}</span>
      <button
        type="button"
        className={`tb-layer__btn tb-layer__lock${layer.locked ? ' tb-layer__lock--on' : ''}`}
        title={layer.locked ? 'Locked — click to unlock' : 'Click to lock placement'}
        onClick={(e) => { e.stopPropagation(); onToggleLock(layer.id); }}
      >
        <DlIcon name={layer.locked ? 'lockClosed' : 'lockOpen'} size={14} />
      </button>
      <button
        type="button"
        className="tb-layer__btn tb-layer__del"
        title="Delete layer"
        onClick={(e) => { e.stopPropagation(); onDelete(layer.id); }}
      >
        <DlIcon name="close" size={14} />
      </button>
    </div>
  );
}

export interface LayersPanelProps {
  layers: Layer[];
  selId: string | null;
  onSelect: (id: string | null) => void;
  onToggleHidden: (id: string) => void;
  onToggleLock: (id: string) => void;
  onDelete: (id: string) => void;
  /** Forwarded to the section root so the host can measure it for the draggable divider. */
  sectionRef?: Ref<HTMLDivElement>;
}

export function LayersPanel({ layers, selId, onSelect, onToggleHidden, onToggleLock, onDelete, sectionRef }: LayersPanelProps) {
  const groups = groupLayers(layers);

  return (
    <div className="tb-side-sec tb-side-sec--layers" ref={sectionRef}>
      <div className="tb-pane-h">Layers</div>
      <div className="tb-side-scroll">
        {groups.map(group => (
          group.items.length === 0 ? null : (
            <div key={group.title}>
              <div className="tb-lgroup">{group.title}</div>
              {group.items.map(layer => (
                <LayerRow
                  key={layer.id}
                  layer={layer}
                  selected={layer.id === selId}
                  onSelect={onSelect}
                  onToggleHidden={onToggleHidden}
                  onToggleLock={onToggleLock}
                  onDelete={onDelete}
                />
              ))}
            </div>
          )
        ))}
        <div>
          <div className="tb-lgroup">Background</div>
          <div className="tb-layer tb-layer--env">
            <span className="tb-layer__btn tb-layer__eye"><DlIcon name="eye" size={14} /></span>
            <span className="tb-layer__ic"><DlIcon name="picture" size={14} /></span>
            <span className="tb-layer__nm">Environment</span>
          </div>
        </div>
      </div>
    </div>
  );
}
