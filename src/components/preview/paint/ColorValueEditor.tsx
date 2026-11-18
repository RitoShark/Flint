import { ColorSurface } from './ColorSurface';
import { useState } from 'react';
import { Modal, ModalBody, ModalFooter, ModalHeader } from '../../ui/Modal';
import { Button } from '../../ui/Button';
import { hexToVec4, vec4ToHex, type Vec4 } from '../../../lib/paint/colorMath';
import type { ColorKeyframe } from '../../../lib/api/paint';

export function ColorValueEditor({ colors, title, onApply, onClose }: {
    colors: ColorKeyframe[]; title: string; onApply: (index: number, color: Vec4) => Promise<void>; onClose: () => void;
}) {
    const [index, setIndex] = useState(0);
    const [value, setValue] = useState<Vec4>([...colors[0].rgba]);
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState('');
    return <Modal open onClose={onClose} closeOnEscape={!busy} closeOnOverlay={!busy}>
        <ModalHeader title={title} />
        <ModalBody>
            <div className="paint-color-editor">
                <div className="paint-color-editor__ramp" style={{ background: `linear-gradient(90deg, ${colors.map(c => vec4ToHex(c.rgba)).join(", ")})` }} />
                <div className="paint-color-editor__stops">
                    {colors.map((color, i) => <Button key={i} aria-label={`Color ${i + 1}`} title={`Keyframe ${i + 1}, time ${color.time}`} size="sm" variant={i === index ? 'primary' : 'secondary'} disabled={busy}
                        onClick={() => { setIndex(i); setValue([...color.rgba]); }}>
                        <span className="paint-color-editor__swatch" style={{ background: vec4ToHex(color.rgba) }} />Color {i + 1}
                    </Button>)}
                </div>
                <ColorSurface hex={vec4ToHex(value)} disabled={busy} onChange={hex => { const rgb = hexToVec4(hex); if (rgb) setValue([rgb[0], rgb[1], rgb[2], value[3]]); }} />
                <label className="paint-color-editor__alpha">Opacity <input aria-label="Opacity" type="range" min={0} max={1} step={0.01} value={value[3]} disabled={busy} onChange={e => setValue(previous => [previous[0], previous[1], previous[2], Number(e.target.value)])} /><output>{Math.round(value[3] * 100)}%</output></label>
                <div className="paint-color-editor__channels">
                    {['Red', 'Green', 'Blue', 'Alpha'].map((label, i) => <label key={label}>{label}
                        <input type="number" step="0.01" value={Number(value[i].toFixed(4))} disabled={busy} onChange={e => {
                            const number = Number(e.target.value); if (!Number.isFinite(number)) return;
                            setValue(previous => previous.map((v, channel) => channel === i ? number : v) as Vec4);
                        }} />
                    </label>)}
                </div>
                {error && <p role="alert">{error}</p>}
            </div>
        </ModalBody>
        <ModalFooter><Button variant="ghost" disabled={busy} onClick={onClose}>Close</Button>
            <Button variant="primary" disabled={busy} onClick={async () => {
                setBusy(true); setError('');
                try { await onApply(index, value); } catch (e) { setError(String(e)); } finally { setBusy(false); }
            }}>{busy ? 'Applying...' : 'Apply color'}</Button></ModalFooter>
    </Modal>;
}
