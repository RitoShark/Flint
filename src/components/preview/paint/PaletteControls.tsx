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
        <label>Mode <select aria-label="Recolor mode" value={mode} onChange={e => onMode(e.target.value as RecolorModeId)}>{modes.map(([id, title]) => <option key={id} value={id}>{title}</option>)}</select></label>
        {mode === 'shift' && <div className="paint-color-editor__channels">{['Hue shift', 'Saturation shift', 'Lightness shift'].map((label, index) => <label key={label}>{label}<input type="number" min={index === 0 ? -360 : -100} max={index === 0 ? 360 : 100} value={shift[index]} onChange={e => onShift(shift.map((v,i) => i === index ? Number(e.target.value) : v) as [number, number, number])} /></label>)}</div>}
        {mode !== 'shift-hue' && mode !== 'shift' && <>
            <div className="paint-palette-controls__gradient" style={{ background: `linear-gradient(90deg, ${[...palette].sort((a,b) => a.time - b.time).map(s => `${vec4ToHex(s.vec4)} ${s.time * 100}%`).join(', ')})` }} />
            <div className="paint-palette-controls__stops">{palette.map((stop, index) => <Button key={index} size="sm" active={index === activeStop} aria-label={`Palette color ${index + 1}`} onClick={() => setSelectedStop(index)}><span className="paint-color-editor__swatch" style={{ background: vec4ToHex(stop.vec4) }} />{index + 1}</Button>)}</div>
            {palette[activeStop] && <>
                <ColorSurface hex={vec4ToHex(palette[activeStop].vec4)} onChange={hex => { const rgb = hexToVec4(hex); if (rgb) onPalette(palette.map((s,i) => i === activeStop ? { ...s, vec4: [rgb[0],rgb[1],rgb[2],s.vec4[3]] } : s)); }} />
                <div className="paint-palette-controls__stop">
                    <label>Position<input aria-label="Palette position" type="number" min={0} max={1} step={0.05} value={palette[activeStop].time} onChange={e => onPalette(palette.map((s,i) => i === activeStop ? { ...s, time: Math.max(0, Math.min(1, Number(e.target.value))) } : s))} /></label>
                    <label>Alpha<input aria-label="Palette alpha" type="number" min={0} max={1} step={0.05} value={palette[activeStop].vec4[3]} onChange={e => onPalette(palette.map((s,i) => i === activeStop ? { ...s, vec4: [s.vec4[0],s.vec4[1],s.vec4[2],Number(e.target.value)] } : s))} /></label>
                    <Button size="sm" variant="ghost" disabled={palette.length <= 1} onClick={() => onPalette(palette.filter((_,i) => i !== activeStop))}>Remove</Button>
                </div>
            </>}
            <Button size="sm" onClick={() => onPalette([...palette, { vec4: [1,1,1,1], time: 1 }])}>Add color</Button>
            <details className="paint-presets"><summary>Saved palettes</summary><div className="paint-palette-controls__saved"><input aria-label="Palette name" placeholder="Palette name" value={name} onChange={e => setName(e.target.value)} />
                <Button size="sm" disabled={!name.trim()} onClick={() => persist([...presets.filter(p => p.name !== name.trim()), { name: name.trim(), mode, palette }])}>Save palette</Button>
                <select aria-label="Saved palette" value="" onChange={e => { const p = presets.find(p => p.name === e.target.value); if (p) { onPalette(p.palette); onMode(p.mode); setName(p.name); } }}><option value="">Load palette...</option>{presets.map(p => <option key={p.name}>{p.name}</option>)}</select>
                <Button size="sm" variant="ghost" disabled={!presets.some(p => p.name === name)} onClick={() => persist(presets.filter(p => p.name !== name))}>Delete saved</Button>
            </div></details>
        </>}
        {error && <p role="alert">{error}</p>}
    </div>;
}
