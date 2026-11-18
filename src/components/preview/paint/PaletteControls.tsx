import { useEffect, useRef, useState } from 'react';
import { Modal, ModalHeader, ModalBody, ModalFooter } from '../../ui/Modal';
import { PaletteSwatches } from '../../ui/PaletteSwatches';
import { DlSelect } from '../../ui/design-lab/DlSelect';
import { DlSlider } from '../../ui/design-lab/DlSlider';
import { Input } from '../../ui/FormField';
import { Button, IconButton } from '../../ui/Button';
import { openColorPicker, cleanupColorPickers, hexToHsv, hsvToHex } from '../../common/ColorPicker';
import type { PaletteStopInput, RecolorModeId } from '../../../lib/api/paint';
import { hexToVec4, vec4ToHex } from '../../../lib/paint/colorMath';
interface Preset { name: string; mode: RecolorModeId; palette: PaletteStopInput[] }
const modes: Array<[RecolorModeId, string]> = [['shift-hue', 'Target hue'], ['linear', 'Palette gradient'], ['random', 'Random per emitter'], ['random-keyframe', 'Random per color'], ['shift', 'HSL shift'], ['materials', 'Material palette']];
const key = 'flint.paint.palettes.v1';
function readPresets(): Preset[] {
    try {
        const items: unknown = JSON.parse(localStorage.getItem(key) || '[]');
        if (!Array.isArray(items)) return [];
        return items.filter(p => p && typeof p.name === 'string' && modes.some(([mode]) => mode === p.mode) && Array.isArray(p.palette) && p.palette.length > 0 && p.palette.every((s: PaletteStopInput) => Array.isArray(s.vec4) && s.vec4.length === 4 && s.vec4.every(Number.isFinite) && Number.isFinite(s.time)));
    } catch { return []; }
}
export function PaletteControls({ mode, onMode, palette, onPalette, shift, onShift }: {
    mode: RecolorModeId; onMode: (mode: RecolorModeId) => void; palette: PaletteStopInput[]; onPalette: (value: PaletteStopInput[]) => void;
    shift: [number, number, number]; onShift: (value: [number, number, number]) => void;
}) {
    const [presets, setPresets] = useState(readPresets);
    const [name, setName] = useState('');
    const [managerOpen, setManagerOpen] = useState(false);
    const [error, setError] = useState('');
    const current = useRef({ palette, onPalette });
    current.current = { palette, onPalette };
    useEffect(() => () => cleanupColorPickers(), []);
    const persist = (next: Preset[]) => { try { localStorage.setItem(key, JSON.stringify(next)); setPresets(next); setError(''); } catch (e) { setError(String(e)); } };
    const resize = (count: number) => {
        cleanupColorPickers();
        const next = palette.slice(0, count).map(stop => ({ ...stop, vec4: [...stop.vec4] as PaletteStopInput['vec4'] }));
        while (next.length < count) {
            const previous = next.at(-1)?.vec4 ?? [0.925, 0.725, 0.416, 1];
            const [h, s, v] = hexToHsv(vec4ToHex(previous));
            next.push({ vec4: hexToVec4(hsvToHex((h + 43.2) % 360, Math.max(.4, s), Math.max(.4, v)), previous[3])!, time: 0 });
        }
        onPalette(next.map((stop, index) => ({ ...stop, time: count === 1 ? 0 : index / (count - 1) })));
    };
    const pick = (index: number, event: React.MouseEvent<HTMLButtonElement>) => {
        const update = (mutate: (stop: PaletteStopInput) => PaletteStopInput) => {
            const { palette: latest, onPalette: change } = current.current;
            if (latest[index]) change(latest.map((stop, i) => i === index ? mutate(stop) : stop));
        };
        openColorPicker(event, vec4ToHex(palette[index].vec4), hex => update(stop => ({ ...stop, vec4: hexToVec4(hex, stop.vec4[3])! })),
            { alpha: palette[index].vec4[3], onAlpha: alpha => update(stop => ({ ...stop, vec4: [stop.vec4[0], stop.vec4[1], stop.vec4[2], alpha] })) });
    };
    return <div className="paint-palette-controls">
        <PaletteSwatches colors={palette.map(stop => vec4ToHex(stop.vec4))} onPick={pick} />
        <div className="paint-palette-toolbar">
            <div className="paint-palette-count"><span>Colors: {palette.length}</span><DlSlider aria-label="Palette color count" min={1} max={20} step={1} value={palette.length} onChange={resize} /></div>
            <div className="paint-palette-toolbar__actions"><Button size="md" onClick={() => { cleanupColorPickers(); setManagerOpen(true); }}>Palette Manager</Button><span>Mode</span><DlSelect title="Recolor mode" width={150} value={mode} onChange={onMode} options={modes.map(([value, label]) => ({ value, label }))} /></div>
        </div>
        {mode === 'shift' && <div className="paint-color-editor__channels">{['Hue shift', 'Saturation shift', 'Lightness shift'].map((label, index) => <label key={label}>{label}<Input type="number" min={index === 0 ? -360 : -100} max={index === 0 ? 360 : 100} value={shift[index]} onChange={e => onShift(shift.map((v,i) => i === index ? Number(e.target.value) : v) as [number, number, number])} /></label>)}</div>}
        {managerOpen && <Modal open onClose={() => setManagerOpen(false)}><ModalHeader title="Palette Manager" /><ModalBody><div className="paint-palette-manager">
            <div className="paint-palette-library__save"><Input aria-label="Palette name" placeholder="Palette name" value={name} onChange={e => setName(e.target.value)} /><Button size="md" disabled={!name.trim()} onClick={() => persist([...presets.filter(p => p.name !== name.trim()), { name: name.trim(), mode, palette }])}>Save palette</Button></div>
            {error && <p role="alert">{error}</p>}
            {!presets.length && <p className="form-hint">Save the current palette to reuse it later.</p>}
            {presets.map(preset => <div key={preset.name} className="paint-palette-library__row">
                <div className="paint-palette-library__info"><strong>{preset.name}</strong><div className="paint-palette-library__preview">{preset.palette.map((stop, i) => <span key={i} style={{ background: vec4ToHex(stop.vec4) }} />)}</div></div>
                <Button size="sm" onClick={() => { onPalette(preset.palette.map(stop => ({ ...stop, vec4: [...stop.vec4] }))); onMode(preset.mode); setName(preset.name); setManagerOpen(false); }}>Load</Button>
                <IconButton size="sm" variant="ghost" icon="trash" title={`Delete ${preset.name}`} onClick={() => persist(presets.filter(p => p.name !== preset.name))} />
            </div>)}
        </div></ModalBody><ModalFooter><Button onClick={() => setManagerOpen(false)}>Close</Button></ModalFooter></Modal>}
    </div>;
}
