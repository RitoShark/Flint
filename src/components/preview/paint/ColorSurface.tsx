import { useEffect, useState } from 'react';
import { hexToHsv, hsvToHex } from '../../common/ColorPicker';

export function ColorSurface({ hex, onChange, disabled = false }: { hex: string; onChange: (hex: string) => void; disabled?: boolean }) {
    const [hsv, setHsv] = useState(() => hexToHsv(hex));
    const [text, setText] = useState(hex);
    useEffect(() => {
        setText(hex);
        setHsv(previous => hsvToHex(...previous).toLowerCase() === hex.toLowerCase() ? previous : hexToHsv(hex));
    }, [hex]);
    const change = (next: [number, number, number]) => { setHsv(next); const color = hsvToHex(...next); setText(color); onChange(color); };
    const pointer = (event: React.PointerEvent<HTMLDivElement>) => {
        if (disabled) return;
        const bounds = event.currentTarget.getBoundingClientRect();
        change([hsv[0], Math.max(0, Math.min(1, (event.clientX - bounds.left) / bounds.width)), Math.max(0, Math.min(1, 1 - (event.clientY - bounds.top) / bounds.height))]);
    };
    return <div className="paint-picker">
        <div className="paint-picker__surface" role="slider" tabIndex={disabled ? -1 : 0} aria-label="Saturation and brightness" aria-disabled={disabled} aria-valuemin={0} aria-valuemax={100} aria-valuenow={Math.round(hsv[1] * 100)} aria-valuetext={`${Math.round(hsv[1] * 100)}% saturation, ${Math.round(hsv[2] * 100)}% brightness`}
            style={{ backgroundColor: `hsl(${hsv[0]}, 100%, 50%)` }}
            onPointerDown={e => { e.currentTarget.setPointerCapture(e.pointerId); pointer(e); }}
            onPointerMove={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) pointer(e); }}
            onPointerUp={e => { if (e.currentTarget.hasPointerCapture(e.pointerId)) e.currentTarget.releasePointerCapture(e.pointerId); }}
            onKeyDown={e => {
                if (disabled || !['ArrowLeft','ArrowRight','ArrowUp','ArrowDown'].includes(e.key)) return;
                e.preventDefault();
                change([hsv[0], Math.max(0, Math.min(1, hsv[1] + (e.key === 'ArrowRight' ? .01 : e.key === 'ArrowLeft' ? -.01 : 0))), Math.max(0, Math.min(1, hsv[2] + (e.key === 'ArrowUp' ? .01 : e.key === 'ArrowDown' ? -.01 : 0)))]);
            }}><span style={{ left: `${hsv[1] * 100}%`, top: `${(1-hsv[2]) * 100}%`, background: hex }} /></div>
        <input className="paint-picker__hue" aria-label="Color hue" type="range" min={0} max={359} value={hsv[0]} disabled={disabled} onChange={e => change([Number(e.target.value), hsv[1], hsv[2]])} />
        <label className="paint-picker__hex"><span style={{ background: hex }} />Hex<input aria-label="Hex color" value={text} disabled={disabled} maxLength={7} onChange={e => { const next = e.target.value; setText(next); if (/^#[0-9a-f]{6}$/i.test(next)) { setHsv(hexToHsv(next)); onChange(next); } }} onBlur={() => setText(hex)} /></label>
    </div>;
}
