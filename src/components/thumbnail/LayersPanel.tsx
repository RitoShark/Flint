import { Ref, useRef, useState } from 'react';
import { Layer } from '../../lib/thumbnail/layers';
import { DlIcon, type DlIconName } from '../ui/design-lab';

/** A human category label for a layer, used ONLY as a visual header in the flat
 *  list (not a drop boundary). Layers can still be dragged across categories. */
function categoryOf(layer: Layer): string {
  switch (layer.type) {
    case 'text': return 'Text';
    case 'deco': return 'Decorations';
    case 'model': return 'Models';
    case 'disc': return 'Fills';
    case 'env': return 'Environment';
    default: return 'Other';
  }
}

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
  /** Move a whole category run (`ids`) before `beforeId` (null = end). */
  onReorderGroup: (ids: string[], beforeId: string | null) => void;
  /** Forwarded to the section root so the host can measure it for the draggable divider. */
  sectionRef?: Ref<HTMLDivElement>;
}

/**
 * Flat, drag-reorderable layer list. The array order IS the z-order (top of the
 * list = front of the artboard), so dragging a row restacks the layers. Uses
 * pointer events (NOT HTML5 DnD — WebView2 blocks in-app HTML5 drag; see
 * CLAUDE.md), hit-testing rows via elementFromPoint.
 */
export function LayersPanel({ layers, selId, onSelect, onToggleHidden, onToggleLock, onDelete, onReorder, onReorderGroup, sectionRef }: LayersPanelProps) {
  const listRef = useRef<HTMLDivElement>(null);
  // Ids currently being dragged: one for a row, the whole category run for a
  // group-header drag.
  const [dragIds, setDragIds] = useState<string[]>([]);
  // The layer id we'd drop BEFORE (null = drop at the very end).
  const [dropBeforeId, setDropBeforeId] = useState<string | null>(null);

  // Shared pointer-drag for a set of ids (row = [id]; group = the run). Commits
  // via onReorder (single) or onReorderGroup (many). Hit-tests row midpoints,
  // skipping the rows being dragged so the target excludes the moving set.
  const beginDrag = (e: React.PointerEvent, ids: string[]) => {
    e.preventDefault();
    e.stopPropagation();
    const moving = new Set(ids);
    setDragIds(ids);
    setDropBeforeId(null);
    const move = (ev: PointerEvent) => {
      const list = listRef.current;
      if (!list) return;
      const rows = Array.from(list.querySelectorAll<HTMLElement>('[data-layer-id]'));
      let before: string | null = null;
      for (const row of rows) {
        const rid = row.dataset.layerId;
        if (!rid || moving.has(rid)) continue; // skip the dragged rows
        const r = row.getBoundingClientRect();
        if (ev.clientY < r.top + r.height / 2) { before = rid; break; }
      }
      setDropBeforeId(before);
    };
    const up = () => {
      window.removeEventListener('pointermove', move);
      window.removeEventListener('pointerup', up);
      setDropBeforeId(target => {
        if (ids.length === 1) onReorder(ids[0], target);
        else onReorderGroup(ids, target);
        return null;
      });
      setDragIds([]);
    };
    window.addEventListener('pointermove', move);
    window.addEventListener('pointerup', up);
  };

  const onDragStart = (e: React.PointerEvent, id: string) => beginDrag(e, [id]);

  return (
    <div className="tb-side-sec tb-side-sec--layers" ref={sectionRef}>
      <div className="tb-pane-h">Layers</div>
      <div className="tb-side-scroll" ref={listRef}>
        {layers.map((layer, i) => {
          // Visual grouping: show a draggable category label above the first
          // layer of a run of the same category. Dragging the HEADER moves the
          // whole group; dragging a ROW moves just that layer. The list stays a
          // flat array — rows can be dragged across categories freely.
          const cat = categoryOf(layer);
          const prevCat = i > 0 ? categoryOf(layers[i - 1]) : null;
          const isNewGroup = cat !== prevCat;
          // The run of layer ids in this contiguous category group.
          const groupIds = isNewGroup
            ? (() => {
                const out: string[] = [];
                for (let j = i; j < layers.length && categoryOf(layers[j]) === cat; j++) out.push(layers[j].id);
                return out;
              })()
            : [];
          return (
            <div key={layer.id}>
              {isNewGroup && (
                <div
                  className="tb-lgroup tb-lgroup--drag"
                  title="Drag to move the whole group"
                  onPointerDown={(e) => beginDrag(e, groupIds)}
                >
                  <span className="tb-lgroup__grip" />
                  {cat}
                </div>
              )}
              <LayerRow
                layer={layer}
                selected={layer.id === selId}
                dropBefore={dragIds.length > 0 && dropBeforeId === layer.id}
                dragging={dragIds.includes(layer.id)}
                onSelect={onSelect}
                onToggleHidden={onToggleHidden}
                onToggleLock={onToggleLock}
                onDelete={onDelete}
                onDragStart={onDragStart}
              />
            </div>
          );
        })}
      </div>
    </div>
  );
}
