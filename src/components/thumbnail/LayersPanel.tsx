import { Ref, useRef, useState } from 'react';
import { Layer } from '../../lib/thumbnail/layers';
import { DlIcon, type DlIconName } from '../ui/design-lab';

function iconFor(type: Layer['type']): DlIconName {
  switch (type) {
    case 'text': return 'layerText';
    case 'model': return 'layerModel';
    case 'disc': return 'contrast';
    case 'deco': return 'picture';
    case 'env': return 'picture';
    default: return 'image';
  }
}

interface LayerRowProps {
  layer: Layer;
  selected: boolean;
  dropBefore: boolean;
  dragging: boolean;
  onSelect: (id: string) => void;
  onToggleHidden: (id: string) => void;
  onToggleLock: (id: string) => void;
  onDelete: (id: string) => void;
  onDragStart: (e: React.PointerEvent, id: string) => void;
}

function LayerRow({ layer, selected, dropBefore, dragging, onSelect, onToggleHidden, onToggleLock, onDelete, onDragStart }: LayerRowProps) {
  return (
    <div
      className={`tb-layer${selected ? ' tb-layer--sel' : ''}${layer.hidden ? ' tb-layer--hidden' : ''}${dropBefore ? ' tb-layer--dropbefore' : ''}${dragging ? ' tb-layer--dragging' : ''}`}
      data-layer-id={layer.id}
      onClick={() => onSelect(layer.id)}
    >
      {/* Drag handle — reorders the layer (array order = z-order). The grip
          dots are drawn in CSS (no dedicated icon in the set). */}
      <span
        className="tb-layer__grip"
        title="Drag to reorder"
        aria-label="Drag to reorder"
        onPointerDown={(e) => { e.stopPropagation(); onDragStart(e, layer.id); }}
      />
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
  /** Move `id` to just before `beforeId` (null = to the end / bottom). */
  onReorder: (id: string, beforeId: string | null) => void;
  /** Forwarded to the section root so the host can measure it for the draggable divider. */
  sectionRef?: Ref<HTMLDivElement>;
}

/**
 * Flat, drag-reorderable layer list. The array order IS the z-order (top of the
 * list = front of the artboard), so dragging a row restacks the layers. Uses
 * pointer events (NOT HTML5 DnD — WebView2 blocks in-app HTML5 drag; see
 * CLAUDE.md), hit-testing rows via elementFromPoint.
 */
export function LayersPanel({ layers, selId, onSelect, onToggleHidden, onToggleLock, onDelete, onReorder, sectionRef }: LayersPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  const [dragId, setDragId] = useState<string | null>(null);
  // The layer id we'd drop BEFORE (null = drop at the very end).
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);

  const onDragStart = (e: React.PointerEvent, id: string) => {
    e.preventDefault();
    setDragId(id);
    setDropBeforeId(id);
    const move = (ev: PointerEvent) => {
      const list = listRef.current;
      if (!list) return;
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-layer-id]'));
      let before: string | null = null;
      for (const row of rows) {
        const r = row.getBoundingClientRect();
        // Drop before the first row whose vertical midpoint is below the cursor.
        if (ev.clientY < r.top + r.height / 2) { before = row.dataset.layerId ?? null; break; }
      }
      setDropBeforeId(before);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDragId(cur => {
        setDropBeforeId(target => {
          // Commit only if it actually changes position.
          if (cur && target !== cur) onReorder(cur, target);
          return null;
        });
        return null;
      });
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  return (
    <div className="tb-side-sec tb-side-sec--layers" ref={sectionRef}>
      <div className="tb-pane-h">Layers</div>
      <div className="tb-side-scroll" ref={listRef}>
        {layers.map(layer => (
          <LayerRow
            key={layer.id}
            layer={layer}
            selected={layer.id === selId}
            dropBefore={dragId !== null && dropBeforeId === layer.id}
            dragging={dragId === layer.id}
            onSelect={onSelect}
            onToggleHidden={onToggleHidden}
            onToggleLock={onToggleLock}
            onDelete={onDelete}
            onDragStart={onDragStart}
          />
        ))}
      </div>
    </div>
  );
}
