import React, { useMemo, useState } from 'react';
import { Icon } from '../../ui';
import { Section } from './Section';
import { useSectionDefault } from './sectionDefaults';
import * as api from '../../../lib/api';
import {
    TOON_BASE_NAME,
    TOON_DEFAULTS,
    findDiffusePaths,
    hasToonMaterial,
    insertToonMaterial,
    uniqueToonName,
    type Rgb,
} from '../../../lib/editor/binTools/toonShading';
import { insertMaterialOverrideEntry } from '../../../lib/editor/binTools/materialOverride';

interface ToonShadingSectionProps {
    content: string;
    filePath: string;
    onApply: (text: string) => void;
}

const toHex = (c: Rgb): string => {
    const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
    return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
};

const fromHex = (hex: string): Rgb => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return [1, 1, 1];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
};

export const ToonShadingSection: React.FC<ToonShadingSectionProps> = ({ content, filePath, onApply }) => {
    const [collapsed, setCollapsed] = useState(!useSectionDefault('Toon Shading'));
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false);

    const diffuseOptions = useMemo(() => findDiffusePaths(content), [content]);
    const [diffuse, setDiffuse] = useState('');
    const [submesh, setSubmesh] = useState('');

    const [shadePower, setShadePower] = useState(TOON_DEFAULTS.shadePower);
    const [outline, setOutline] = useState(TOON_DEFAULTS.outline);
    const [outlineWidth, setOutlineWidth] = useState(TOON_DEFAULTS.outlineWidth);
    const [outlineColor, setOutlineColor] = useState<Rgb>(TOON_DEFAULTS.outlineColor);
    const [rim, setRim] = useState(TOON_DEFAULTS.rim);
    const [rimColor, setRimColor] = useState<Rgb>(TOON_DEFAULTS.rimColor);
    const [rimStrength, setRimStrength] = useState(TOON_DEFAULTS.rimStrength);

    const exists = hasToonMaterial(content);
    const diffusePath = (diffuse || diffuseOptions[0] || '').trim();

    const handleInsert = async () => {
        if (!diffusePath) { setStatus('Pick the diffuse texture the material should use'); return; }
        setBusy(true);
        try {
            const install = await api.installToonRamps(filePath);
            const name = uniqueToonName(content, TOON_BASE_NAME);
            let text = insertToonMaterial(content, {
                name,
                diffusePath,
                shadePower,
                outline,
                outlineWidth,
                outlineColor,
                rim,
                rimColor,
                rimStrength,
            });
            if (text === content) {
                setStatus('No entries block in this bin — nothing was inserted');
                return;
            }
            if (submesh.trim()) {
                text = insertMaterialOverrideEntry(text, name, submesh.trim(), 'material');
            }
            onApply(text);
            const ramps = install.written.length ? ` (+${install.written.length} ramps)` : '';
            setStatus(`Inserted ${name}${ramps}`);
        } catch (e) {
            setStatus(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    return (
        <Section
            title="Toon Shading"
            badge={exists ? 'exists' : undefined}
            collapsed={collapsed}
            onToggle={() => setCollapsed(!collapsed)}
        >
            <div className="bin-tools__body">
                <input
                    className="dl-input"
                    list="flint-toon-diffuse"
                    placeholder={diffuseOptions[0] || 'assets/characters/.../maintexture.dds'}
                    value={diffuse}
                    onChange={e => setDiffuse(e.target.value)}
                    title="Diffuse texture the toon material samples"
                />
                <datalist id="flint-toon-diffuse">
                    {diffuseOptions.map(p => <option key={p} value={p} />)}
                </datalist>

                <input
                    className="dl-input"
                    placeholder="Submesh (optional — adds the override)"
                    value={submesh}
                    onChange={e => setSubmesh(e.target.value)}
                />

                <div className="bin-tools__row">
                    <span className="bin-tools__hint" style={{ flex: 1 }}>Shade power</span>
                    <input
                        type="range"
                        min={1}
                        max={16}
                        step={0.1}
                        value={shadePower}
                        onChange={e => setShadePower(parseFloat(e.target.value))}
                        style={{ flex: 2, minWidth: 0 }}
                    />
                    <span className="bin-tools__hint">{shadePower.toFixed(1)}</span>
                </div>

                <label className="bin-tools__check">
                    <input type="checkbox" checked={rim} onChange={e => setRim(e.target.checked)} />
                    Rim light
                </label>
                {rim && (
                    <div className="bin-tools__row">
                        <input
                            type="color"
                            value={toHex(rimColor)}
                            onChange={e => setRimColor(fromHex(e.target.value))}
                            style={{ width: 34, height: 26, border: 0, background: 'none', padding: 0, cursor: 'pointer' }}
                        />
                        <input
                            type="range"
                            min={0}
                            max={4}
                            step={0.05}
                            value={rimStrength}
                            onChange={e => setRimStrength(parseFloat(e.target.value))}
                            style={{ flex: 1, minWidth: 0 }}
                        />
                        <span className="bin-tools__hint">{rimStrength.toFixed(2)}</span>
                    </div>
                )}

                <label className="bin-tools__check">
                    <input type="checkbox" checked={outline} onChange={e => setOutline(e.target.checked)} />
                    Outline
                </label>
                {outline && (
                    <div className="bin-tools__row">
                        <input
                            type="color"
                            value={toHex(outlineColor)}
                            onChange={e => setOutlineColor(fromHex(e.target.value))}
                            style={{ width: 34, height: 26, border: 0, background: 'none', padding: 0, cursor: 'pointer' }}
                        />
                        <input
                            type="range"
                            min={0.05}
                            max={0.6}
                            step={0.01}
                            value={outlineWidth}
                            onChange={e => setOutlineWidth(parseFloat(e.target.value))}
                            style={{ flex: 1, minWidth: 0 }}
                        />
                        <span className="bin-tools__hint">{outlineWidth.toFixed(2)}</span>
                    </div>
                )}

                <button
                    className="dl-btn dl-btn--sm dl-btn--primary"
                    style={{ width: '100%' }}
                    onClick={handleInsert}
                    disabled={busy}
                >
                    <Icon className="bin-tools__glyph" name="plus" />
                    {busy ? 'Adding…' : 'Add toon material'}
                </button>

                {status && <div className="bin-tools__status" title={status}>{status}</div>}
            </div>
        </Section>
    );
};
