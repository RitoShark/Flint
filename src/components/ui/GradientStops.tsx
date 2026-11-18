import { useId } from 'react';
import { Radio } from './Radio';

interface Stop { color: string; position: number }
export function GradientStops({ stops, selected, onSelect, disabled, label = 'Color' }: {
    stops: Stop[]; selected: number; onSelect: (index: number) => void; disabled?: boolean; label?: string;
}) {
    const name = useId();
    const positions = stops.map(stop => Math.max(0, Math.min(1, stop.position)));
    const lanes: number[][] = [];
    const markers = positions.map(position => {
        let lane = lanes.findIndex(items => items.every(p => Math.abs(p - position) > .065));
        if (lane < 0) { lane = lanes.length; lanes.push([]); }
        lanes[lane].push(position);
        return lane;
    });
    const sorted = stops.map((stop, i) => ({ ...stop, position: positions[i] })).sort((a,b) => a.position - b.position);
    const gradient = sorted.length === 1 ? sorted[0].color : `linear-gradient(90deg, ${sorted.map(stop => `${stop.color} ${stop.position * 100}%`).join(', ')})`;
    return <div className="gradient-stops" role="radiogroup" aria-label={`${label} stops`} style={{ height: 28 + lanes.length * 24 }}>
        <div className="gradient-stops__ramp" style={{ background: gradient }} />
        {stops.map((stop, index) => <div key={index} className="gradient-stops__position" style={{ left: `${positions[index] * 100}%`, top: 26 + markers[index] * 24 }}>
            <Radio name={name} value={String(index)} checked={selected === index} disabled={disabled} onChange={() => onSelect(index)}
                className="gradient-stops__point" aria-label={`${label} ${index + 1}`} title={`${label} ${index + 1} at ${Math.round(positions[index] * 100)}%`}
                icon={<span className="gradient-stops__color" style={{ background: stop.color }} />} />
        </div>)}
    </div>;
}
