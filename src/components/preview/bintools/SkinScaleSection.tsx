import React, { useEffect, useRef, useState } from 'react';
import { Icon } from '../../ui';
import { Section } from './Section';
import { applySkinScaleToText, parseSkinScale } from '../../../lib/editor/binTools/skinScale';

interface SkinScaleSectionProps {
    content: string;
    onApply: (text: string) => void;
}

export const SkinScaleSection: React.FC<SkinScaleSectionProps> = ({ content, onApply }) => {
    const [collapsed, setCollapsed] = useState(false);
    const [value, setValue] = useState('1.0');
    const [pct, setPct] = useState('100');
    const [exists, setExists] = useState(false);
    const [status, setStatus] = useState('');
    const originalRef = useRef(1.0);
    const pctUpdatingRef = useRef(false);

    useEffect(() => {
        const sk = parseSkinScale(content);
        setValue(sk.value);
        setExists(sk.exists);
        if (sk.exists) originalRef.current = parseFloat(sk.value) || 1.0;
        setPct('100');
    }, [content]);

    const handleValueChange = (val: string) => {
        setValue(val);
        const p = parseFloat(val);
        if (!isNaN(p) && originalRef.current !== 0) {
            setPct(((p / originalRef.current) * 100).toFixed(0));
        }
    };

    const handlePctChange = (val: string) => {
        setPct(val);
        if (pctUpdatingRef.current) return;
        const parsed = parseFloat(val);
        if (!isNaN(parsed)) {
            pctUpdatingRef.current = true;
            setValue((originalRef.current * (parsed / 100)).toFixed(4));
            pctUpdatingRef.current = false;
        }
    };

    const handleApply = () => {
        const v = value.trim();
        if (!v) return;
        onApply(applySkinScaleToText(content, v));
        setStatus(`Applied: ${v}`);
        const parsed = parseFloat(v);
        if (!isNaN(parsed)) { originalRef.current = parsed; setPct('100'); }
    };

    return (
        <Section title="Skin Scale" collapsed={collapsed} onToggle={() => setCollapsed(!collapsed)}>
            <div className="bin-tools__body">
                <div className="bin-tools__row">
                    <input
                        className="dl-input"
                        style={{ flex: 2, minWidth: 0, fontFamily: 'var(--font-mono)' }}
                        value={value}
                        onChange={e => handleValueChange(e.target.value)}
                        placeholder="1.0"
                        title="skinScale value"
                    />
                    <div className="bin-tools__row" style={{ flex: 1, gap: 3 }}>
                        <input
                            className="dl-input"
                            style={{ minWidth: 0, fontFamily: 'var(--font-mono)' }}
                            value={pct}
                            onChange={e => handlePctChange(e.target.value)}
                            placeholder="100"
                            title="% of original"
                        />
                        <span style={{ flexShrink: 0, color: 'var(--text-muted)', fontSize: 11 }}>%</span>
                    </div>
                    <button
                        className="dl-btn dl-btn--sm dl-btn--icon"
                        onClick={handleApply}
                        title={exists ? 'Apply value' : 'Add skinScale property'}
                    >
                        <Icon className="bin-tools__glyph" name={exists ? 'check' : 'plus'} />
                    </button>
                </div>
                {status && <div className="bin-tools__status">{status}</div>}
            </div>
        </Section>
    );
};
