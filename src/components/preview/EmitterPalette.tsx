/**
 * Emitter Palette — left-side panel listing ritobin blocks copied out of a BIN
 * editor. Each row is dragged (via pointer-drag, NOT HTML5 — WebView2's native
 * drag-drop blocks HTML5 DnD) into the Monaco editor of any open BIN. On release
 * over a `.bin-editor__content`, a `flint:emitter-drop` CustomEvent carrying the
 * block id + drop coords is dispatched; the BinEditor listens and splices the
 * block in with correct nesting.
 */

import React from 'react';
import { Button } from '../ui';
import { beginPointerDrag } from '../../lib/pointerDrag';
import { useEmitterPaletteStore, type CopiedBlock } from '../../lib/stores/emitterPaletteStore';
import '../../styles/emitterPalette.css';

/** DOM event a palette drop dispatches onto the target `.bin-editor__content`. */
export const EMITTER_DROP_EVENT = 'flint:emitter-drop';
export interface EmitterDropDetail { blockId: string; clientX: number; clientY: number; }

interface EmitterPaletteProps {
    onClose: () => void;
}

const PaletteRow: React.FC<{ block: CopiedBlock; onRemove: (id: string) => void }> = ({ block, onRemove }) => {
    const handlePointerDown = (e: React.PointerEvent<HTMLDivElement>) => {
        beginPointerDrag(e, {
            label: block.label,
            onDrop: ({ clientX, clientY }) => {
                const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
                const editorEl = el?.closest('.bin-editor__content') as HTMLElement | null;
                if (!editorEl) return;
                const detail: EmitterDropDetail = { blockId: block.id, clientX, clientY };
                editorEl.dispatchEvent(new CustomEvent(EMITTER_DROP_EVENT, { detail, bubbles: true }));
            },
        });
    };

    return (
        <div
            className="emitter-palette__item"
            onPointerDown={handlePointerDown}
            title={`Drag into a BIN editor to insert\n\n${block.text}`}
        >
            <span className="emitter-palette__drag-handle" aria-hidden>⠿</span>
            <div className="emitter-palette__item-body">
                <span className="emitter-palette__item-label">{block.label}</span>
                <span className="emitter-palette__item-class">{block.className}</span>
            </div>
            <button
                className="emitter-palette__item-remove"
                onClick={(e) => { e.stopPropagation(); onRemove(block.id); }}
                title="Remove from palette"
                aria-label="Remove"
            >
                ✕
            </button>
        </div>
    );
};

export const EmitterPalette: React.FC<EmitterPaletteProps> = ({ onClose }) => {
    const blocks = useEmitterPaletteStore((s) => s.blocks);
    const remove = useEmitterPaletteStore((s) => s.remove);
    const clear = useEmitterPaletteStore((s) => s.clear);

    return (
        <div className="emitter-palette">
            <div className="emitter-palette__header">
                <span className="emitter-palette__title">Block Palette</span>
                <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                    {blocks.length > 0 && <span className="emitter-palette__count">{blocks.length}</span>}
                    <button
                        className="emitter-palette__item-remove"
                        onClick={onClose}
                        title="Hide palette"
                        aria-label="Hide palette"
                    >
                        ✕
                    </button>
                </div>
            </div>

            <div className="emitter-palette__list">
                {blocks.length === 0 ? (
                    <div className="emitter-palette__empty">
                        No copied blocks yet.<br />
                        Right-click an <code>emitter</code> or VFX block in a BIN editor and choose
                        “Copy emitter block”, then drag it from here into any open BIN.
                    </div>
                ) : (
                    blocks.map((b) => <PaletteRow key={b.id} block={b} onRemove={remove} />)
                )}
            </div>

            {blocks.length > 0 && (
                <div className="emitter-palette__footer">
                    <Button variant="secondary" size="sm" fullWidth onClick={clear}>
                        Clear all
                    </Button>
                </div>
            )}
        </div>
    );
};
