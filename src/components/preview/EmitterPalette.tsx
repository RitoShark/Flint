/**
 * Emitter Palette — left-side panel listing ritobin blocks copied out of a BIN
 * editor. Each row is HTML5-draggable into the Monaco editor of any open BIN;
 * the editor's drop handler reads the block id from the drag payload, resolves
 * it from `emitterPaletteStore`, and splices it in with correct nesting.
 */

import React from 'react';
import { Button } from '../ui';
import { useEmitterPaletteStore, type CopiedBlock } from '../../lib/stores/emitterPaletteStore';
import '../../styles/emitterPalette.css';

/** MIME type used as the drag payload key for a copied block id. */
export const EMITTER_DND_MIME = 'application/x-flint-emitter';

interface EmitterPaletteProps {
    onClose: () => void;
}

const PaletteRow: React.FC<{ block: CopiedBlock; onRemove: (id: string) => void }> = ({ block, onRemove }) => {
    const handleDragStart = (e: React.DragEvent<HTMLDivElement>) => {
        e.dataTransfer.setData(EMITTER_DND_MIME, block.id);
        // Plain-text fallback so the block can also be pasted as text elsewhere.
        e.dataTransfer.setData('text/plain', block.text);
        e.dataTransfer.effectAllowed = 'copy';
    };

    return (
        <div
            className="emitter-palette__item"
            draggable
            onDragStart={handleDragStart}
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
