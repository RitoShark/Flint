import React, { useEffect, useMemo, useState } from 'react';
import * as api from '../../../lib/api';
import { useProjectTabStore } from '../../../lib/stores';
import {
    TOON_DEFAULTS,
    hasToonMaterial,
    insertToonMaterial,
    toonMaterialName,
    type Rgb,
} from '../../../lib/editor/binTools/toonShading';
import { insertMaterialOverrideEntry } from '../../../lib/editor/binTools/materialOverride';

interface ToonShadingFormProps {
    content: string;
    filePath: string;
    onApply: (text: string) => void;
    onDone: () => void;
}

type Step = 'mesh' | 'texture' | 'settings';

const toHex = (c: Rgb): string => {
    const h = (n: number) => Math.round(Math.max(0, Math.min(1, n)) * 255).toString(16).padStart(2, '0');
    return `#${h(c[0])}${h(c[1])}${h(c[2])}`;
};

const fromHex = (hex: string): Rgb => {
    const m = /^#?([0-9a-f]{2})([0-9a-f]{2})([0-9a-f]{2})$/i.exec(hex);
    if (!m) return [1, 1, 1];
    return [parseInt(m[1], 16) / 255, parseInt(m[2], 16) / 255, parseInt(m[3], 16) / 255];
};

const tail = (path: string) => path.split('/').pop() || path;

export const ToonShadingForm: React.FC<ToonShadingFormProps> = ({ content, filePath, onApply, onDone }) => {
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const project = openTabs.find((t) => t.id === activeTabId)?.project ?? null;

    const [step, setStep] = useState<Step>('mesh');
    const [meshes, setMeshes] = useState<api.SkinMeshEntry[] | null>(null);
    const [meshError, setMeshError] = useState<string | null>(null);

    const [submesh, setSubmesh] = useState('');
    const [texture, setTexture] = useState('');
    const [status, setStatus] = useState('');
    const [busy, setBusy] = useState(false);

    const [shadePower, setShadePower] = useState(TOON_DEFAULTS.shadePower);
    const [outline, setOutline] = useState(TOON_DEFAULTS.outline);
    const [outlineWidth, setOutlineWidth] = useState(TOON_DEFAULTS.outlineWidth);
    const [outlineColor, setOutlineColor] = useState<Rgb>(TOON_DEFAULTS.outlineColor);
    const [rim, setRim] = useState(TOON_DEFAULTS.rim);
    const [rimColor, setRimColor] = useState<Rgb>(TOON_DEFAULTS.rimColor);
    const [rimStrength, setRimStrength] = useState(TOON_DEFAULTS.rimStrength);

    useEffect(() => {
        let cancelled = false;
        api.listSkinMeshes(filePath)
            .then((list) => { if (!cancelled) setMeshes(list); })
            .catch((e) => {
                if (!cancelled) setMeshError(e instanceof Error ? e.message : String(e));
            });
        return () => { cancelled = true; };
    }, [filePath]);

    const otherTextures = useMemo(() => {
        const seen = new Set<string>();
        for (const m of meshes ?? []) if (m.texture) seen.add(m.texture);
        return [...seen];
    }, [meshes]);

    const pickMesh = (entry: api.SkinMeshEntry) => {
        setSubmesh(entry.submesh);
        setTexture(entry.texture ?? '');
        setStep('texture');
    };

    const materialName = toonMaterialName(
        project?.champion ?? '',
        project?.name ?? project?.display_name ?? 'Mod',
        submesh,
        content,
    );

    const handleInsert = async () => {
        if (!texture.trim()) { setStatus('Pick the texture the material samples'); return; }
        setBusy(true);
        try {
            const install = await api.installToonRamps(filePath);
            let text = insertToonMaterial(content, {
                name: materialName,
                diffusePath: texture.trim(),
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
            text = insertMaterialOverrideEntry(text, materialName, submesh, 'material');
            onApply(text);
            const ramps = install.written.length ? ` (+${install.written.length} ramps)` : '';
            setStatus(`Inserted ${tail(materialName)}${ramps}`);
            onDone();
        } catch (e) {
            setStatus(e instanceof Error ? e.message : String(e));
        } finally {
            setBusy(false);
        }
    };

    if (step === 'mesh') {
        return (
            <div className="bin-tools__body">
                <div className="bin-tools__hint">
                    {hasToonMaterial(content) ? 'This bin already has a toon material. ' : ''}
                    Pick the mesh to shade:
                </div>
                {meshError && <div className="bin-tools__status" title={meshError}>{meshError}</div>}
                {!meshes && !meshError && <div className="bin-tools__hint">Reading the mesh…</div>}
                {meshes?.length === 0 && <div className="bin-tools__hint">The mesh reported no submeshes.</div>}
                {meshes?.map((m) => (
                    <button
                        key={m.submesh}
                        className="dl-btn dl-btn--sm bin-tools__mesh"
                        onClick={() => pickMesh(m)}
                        title={m.texture ?? 'No texture resolved for this submesh'}
                    >
                        <span className="bin-tools__mesh-name">{m.submesh}</span>
                        <span className="bin-tools__mesh-tex">{m.texture ? tail(m.texture) : 'no texture'}</span>
                    </button>
                ))}
                {(meshError || meshes?.length === 0) && (
                    <>
                        <input
                            className="dl-input"
                            placeholder="Submesh name"
                            value={submesh}
                            onChange={(e) => setSubmesh(e.target.value)}
                        />
                        <button
                            className="dl-btn dl-btn--sm"
                            disabled={!submesh.trim()}
                            onClick={() => setStep('texture')}
                        >
                            Continue
                        </button>
                    </>
                )}
                <button className="dl-btn dl-btn--sm" onClick={onDone}>Cancel</button>
            </div>
        );
    }

    if (step === 'texture') {
        return (
            <div className="bin-tools__body">
                <div className="bin-tools__hint">Base texture for {submesh}:</div>
                <input
                    className="dl-input"
                    list="flint-toon-textures"
                    value={texture}
                    onChange={(e) => setTexture(e.target.value)}
                    placeholder="assets/characters/.../maintexture.dds"
                />
                <datalist id="flint-toon-textures">
                    {otherTextures.map((t) => <option key={t} value={t} />)}
                </datalist>
                <div className="bin-tools__row">
                    <button className="dl-btn dl-btn--sm" style={{ flex: 1 }} onClick={() => setStep('mesh')}>Back</button>
                    <button
                        className="dl-btn dl-btn--sm dl-btn--primary"
                        style={{ flex: 1 }}
                        disabled={!texture.trim()}
                        onClick={() => setStep('settings')}
                    >
                        Next
                    </button>
                </div>
            </div>
        );
    }

    return (
        <div className="bin-tools__body">
            <div className="bin-tools__hint" title={materialName}>{submesh} · {tail(texture)}</div>

            <div className="bin-tools__row">
                <span className="bin-tools__hint" style={{ flex: 1 }}>Shade power</span>
                <input
                    type="range"
                    min={1}
                    max={16}
                    step={0.1}
                    value={shadePower}
                    onChange={(e) => setShadePower(parseFloat(e.target.value))}
                    style={{ flex: 2, minWidth: 0 }}
                />
                <span className="bin-tools__hint">{shadePower.toFixed(1)}</span>
            </div>

            <label className="bin-tools__check">
                <input type="checkbox" checked={rim} onChange={(e) => setRim(e.target.checked)} />
                Rim light
            </label>
            {rim && (
                <div className="bin-tools__row">
                    <input
                        type="color"
                        className="bin-tools__color"
                        value={toHex(rimColor)}
                        onChange={(e) => setRimColor(fromHex(e.target.value))}
                    />
                    <input
                        type="range"
                        min={0}
                        max={4}
                        step={0.05}
                        value={rimStrength}
                        onChange={(e) => setRimStrength(parseFloat(e.target.value))}
                        style={{ flex: 1, minWidth: 0 }}
                    />
                    <span className="bin-tools__hint">{rimStrength.toFixed(2)}</span>
                </div>
            )}

            <label className="bin-tools__check">
                <input type="checkbox" checked={outline} onChange={(e) => setOutline(e.target.checked)} />
                Outline
            </label>
            {outline && (
                <div className="bin-tools__row">
                    <input
                        type="color"
                        className="bin-tools__color"
                        value={toHex(outlineColor)}
                        onChange={(e) => setOutlineColor(fromHex(e.target.value))}
                    />
                    <input
                        type="range"
                        min={0.05}
                        max={0.6}
                        step={0.01}
                        value={outlineWidth}
                        onChange={(e) => setOutlineWidth(parseFloat(e.target.value))}
                        style={{ flex: 1, minWidth: 0 }}
                    />
                    <span className="bin-tools__hint">{outlineWidth.toFixed(2)}</span>
                </div>
            )}

            <div className="bin-tools__row">
                <button className="dl-btn dl-btn--sm" style={{ flex: 1 }} onClick={() => setStep('texture')}>Back</button>
                <button
                    className="dl-btn dl-btn--sm dl-btn--primary"
                    style={{ flex: 1 }}
                    onClick={handleInsert}
                    disabled={busy}
                >
                    {busy ? 'Adding…' : 'Add material'}
                </button>
            </div>

            {status && <div className="bin-tools__status" title={status}>{status}</div>}
        </div>
    );
};
