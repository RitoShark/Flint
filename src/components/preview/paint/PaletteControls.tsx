import { GradientStops } from '../../ui/GradientStops';
import { DlSelect } from '../../ui/design-lab/DlSelect';
import { Input } from '../../ui/FormField';
import { ColorSurface } from './ColorSurface';
import { useState } from 'react';
import { Button } from '../../ui/Button';
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
    const [selectedStop, setSelectedStop] = useState(0);
    const activeStop = Math.min(selectedStop, palette.length - 1);
    const [error, setError] = useState('');
    const persist = (next: Preset[]) => { try { localStorage.setItem(key, JSON.stringify(next)); setPresets(next); setError(''); } catch (e) { setError(String(e)); } };
    return <div className="paint-palette-controls">
        <div className="paint-control-field"><span>Mode</span><DlSelect title="Recolor mode" width="100%" value={mode} onChange={onMode} options={modes.map(([value, label]) => ({ value, label }))} /></div>
        {mode === 'shift' && <div className="paint-color-editor__channels">{['Hue shift', 'Saturation shift', 'Lightness shift'].map((label, index) => <label key={label}>{label}<Input type="number" min={index === 0 ? -360 : -100} max={index === 0 ? 360 : 100} value={shift[index]} onChange={e => onShift(shift.map((v,i) => i === index ? Number(e.target.value) : v) as [number, number, number])} /></label>)}</div>}
        {mode !== 'shift-hue' && mode !== 'shift' && <>
            <GradientStops label="Palette color" stops={palette.map(stop => ({ color: vec4ToHex(stop.vec4), position: stop.time }))} selected={activeStop} onSelect={setSelectedStop} />
            {palette[activeStop] && <>
                <ColorSurface hex={vec4ToHex(palette[activeStop].vec4)} onChange={hex => { const rgb = hexToVec4(hex); if (rgb) onPalette(palette.map((s,i) => i === activeStop ? { ...s, vec4: [rgb[0],rgb[1],rgb[2],s.vec4[3]] } : s)); }} />
                <div className="paint-palette-controls__stop">
                    <label>Position<Input aria-label="Palette position" type="number" min={0} max={1} step={0.05} value={palette[activeStop].time} onChange={e => onPalette(palette.map((s,i) => i === activeStop ? { ...s, time: Math.max(0, Math.min(1, Number(e.target.value))) } : s))} /></label>
                    <label>Alpha<Input aria-label="Palette alpha" type="number" min={0} max={1} step={0.05} value={palette[activeStop].vec4[3]} onChange={e => onPalette(palette.map((s,i) => i === activeStop ? { ...s, vec4: [s.vec4[0],s.vec4[1],s.vec4[2],Number(e.target.value)] } : s))} /></label>
                    <Button size="sm" variant="ghost" disabled={palette.length <= 1} onClick={() => onPalette(palette.filter((_,i) => i !== activeStop))}>Remove</Button>
                </div>
            </>}
            <Button size="sm" onClick={() => onPalette([...palette, { vec4: [1,1,1,1], time: 1 }])}>Add color</Button>
            <details className="paint-presets"><summary>Saved palettes</summary><div className="paint-palette-controls__saved"><Input aria-label="Palette name" placeholder="Palette name" value={name} onChange={e => setName(e.target.value)} />
                <Button size="sm" disabled={!name.trim()} onClick={() => persist([...presets.filter(p => p.name !== name.trim()), { name: name.trim(), mode, palette }])}>Save palette</Button>
                <DlSelect title="Saved palette" placeholder="Load palette..." width="100%" value={null} resetAfterSelect options={presets.map(p => ({ value: p.name, label: p.name }))} onChange={name => { const p = presets.find(p => p.name === name); if (p) { onPalette(p.palette); onMode(p.mode); setName(p.name); } }} />
                <Button size="sm" variant="ghost" disabled={!presets.some(p => p.name === name)} onClick={() => persist(presets.filter(p => p.name !== name))}>Delete saved</Button>
            </div></details>
        </>}
        {error && <p role="alert">{error}</p>}
    </div>;
}
