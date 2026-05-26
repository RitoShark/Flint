/**
 * Flint - Chroma Port Modal
 *
 * Right-click on project root → "Port to Chromas…" opens this.
 * Fetches CDragon chroma data for the current project's skin, lets the user
 * pick which chromas to target, then calls portProjectToChromas.
 *
 * Handles two cases:
 *  - Base-skin project (skin_id = 1): shows all chromas of that skin.
 *  - Chroma project (skin_id = 61): finds the parent skin, shows sibling
 *    chromas plus a "Base" card. Port runs from skin61 → selected targets.
 */

import React, { useEffect, useState } from 'react';

/** Strip the skin name prefix and trailing "Chroma" word from a CDragon chroma name.
 *  "Coven Ahri Amethyst Chroma" + skinName "Coven Ahri" → "Amethyst" */
function chromaLabel(name: string | undefined, skinName: string, skinNum: number): string {
    if (!name) return `#${skinNum}`;
    const escaped = skinName.replace(/[.*+?^${}()|[\]\\]/g, '\\$&');
    return name
        .replace(new RegExp(`^${escaped}\\s*`, 'i'), '')
        .replace(/\s*Chroma\s*$/i, '')
        .trim() || `#${skinNum}`;
}
import { useModalStore, useNotificationStore, useProjectTabStore } from '../../lib/stores';
import * as api from '../../lib/api';
import {
    fetchChampions,
    fetchChampionSkins,
    getChromaImageUrl,
    resolveCDragonAsset,
} from '../../lib/data/datadragon';
import type { DDragonChroma } from '../../lib/data/datadragon';
import {
    Button,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    ModalLoading,
    Spinner,
} from '../ui';

export const ChromaPortModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);

    const isVisible = activeModal === 'chromaPort';

    const activeTab = activeTabId
        ? openTabs.find((t) => t.id === activeTabId)
        : null;
    const project = activeTab?.project ?? null;
    const projectPath = activeTab?.projectPath ?? null;

    const [chromas, setChromas] = useState<DDragonChroma[]>([]);
    const [champId, setChampId] = useState<number | null>(null);
    const [parentSkinName, setParentSkinName] = useState('');
    const [loading, setLoading] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [busy, setBusy] = useState(false);
    const [imgErrors, setImgErrors] = useState<Set<number>>(new Set());

    // Base-skin card — only populated when the project is itself a chroma
    const [baseSkinNum, setBaseSkinNum] = useState<number | null>(null);
    const [baseSkinTileUrl, setBaseSkinTileUrl] = useState<string | null>(null);
    const [baseSkinName, setBaseSkinName] = useState<string | null>(null);
    const [baseImgError, setBaseImgError] = useState(false);

    useEffect(() => {
        if (!isVisible || !project) return;
        let cancelled = false;

        setLoading(true);
        setFetchError(null);
        setChromas([]);
        setSelected(new Set());
        setChampId(null);
        setParentSkinName('');
        setImgErrors(new Set());
        setBaseSkinNum(null);
        setBaseSkinTileUrl(null);
        setBaseSkinName(null);
        setBaseImgError(false);

        (async () => {
            try {
                const champions = await fetchChampions();
                const champ = champions.find(
                    (c) => c.alias.toLowerCase() === project.champion.toLowerCase(),
                );
                if (!champ) throw new Error(`Champion "${project.champion}" not found in CDragon`);

                const skins = await fetchChampionSkins(champ.id, champ.alias);

                // First try: project.skin_id is a base skin num
                let skin = skins.find((s) => s.num === project.skin_id);
                let excludeSkinNum: number | null = null;

                if (!skin) {
                    // Chroma project — find the parent skin that owns this chroma
                    skin = skins.find((s) =>
                        s.chromas?.some((c) => c.skinNum === project.skin_id),
                    );
                    if (skin) excludeSkinNum = project.skin_id;
                }

                if (!skin) {
                    throw new Error(`Skin ${project.skin_id} not found for ${project.champion}`);
                }

                if (cancelled) return;

                const skinChromas = (skin.chromas ?? []).filter(
                    (c) => c.skinNum !== excludeSkinNum,
                );

                let bsNum: number | null = null;
                let bsUrl: string | null = null;
                let bsName: string | null = null;
                if (excludeSkinNum !== null) {
                    bsNum = skin.num;
                    bsUrl = skin.tilePath ? resolveCDragonAsset(skin.tilePath) : null;
                    bsName = skin.name;
                }

                if (skinChromas.length === 0 && bsNum === null) {
                    setFetchError('This skin has no chromas in CDragon data.');
                    return;
                }

                const initialSelected = new Set(skinChromas.map((c) => c.skinNum));
                if (bsNum !== null) initialSelected.add(bsNum);

                setChampId(champ.id);
                setParentSkinName(skin.name);
                setChromas(skinChromas);
                setBaseSkinNum(bsNum);
                setBaseSkinTileUrl(bsUrl);
                setBaseSkinName(bsName);
                setSelected(initialSelected);
            } catch (e) {
                if (!cancelled) setFetchError((e as Error).message ?? String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [isVisible, project]);

    const toggle = (skinNum: number) =>
        setSelected((prev) => {
            const next = new Set(prev);
            next.has(skinNum) ? next.delete(skinNum) : next.add(skinNum);
            return next;
        });

    const totalOptions = chromas.length + (baseSkinNum !== null ? 1 : 0);

    const selectAll = () => {
        const all = new Set(chromas.map((c) => c.skinNum));
        if (baseSkinNum !== null) all.add(baseSkinNum);
        setSelected(all);
    };
    const selectNone = () => setSelected(new Set());

    const handleConfirm = async () => {
        if (!project || !projectPath || selected.size === 0) return;
        setBusy(true);
        try {
            const count = await api.portProjectToChromas(
                projectPath,
                project.champion,
                project.skin_id,
                Array.from(selected),
            );
            const n = selected.size;
            showToast(
                'success',
                `Ported ${count} BIN${count === 1 ? '' : 's'} to ${n} target${n === 1 ? '' : 's'}`,
            );
            closeModal();
        } catch (err) {
            const fe = err as api.FlintError;
            showToast('error', fe.getUserMessage?.() || `Port failed: ${err}`);
        } finally {
            setBusy(false);
        }
    };

    const canConfirm = !busy && !loading && selected.size > 0 && totalOptions > 0;

    return (
        <Modal open={isVisible} onClose={busy ? () => {} : closeModal}>
            {busy && <ModalLoading text="Porting to Chromas" progress="Writing BIN files…" />}

            <ModalHeader title="Port to Chromas" onClose={closeModal} />

            <ModalBody>
                {loading && (
                    <div className="chroma-port-loading">
                        <Spinner size="sm" />
                        <span>Loading chroma data…</span>
                    </div>
                )}

                {!loading && fetchError && (
                    <p className="chroma-port-error">{fetchError}</p>
                )}

                {!loading && !fetchError && totalOptions > 0 && (
                    <>
                        <div className="chroma-port-toolbar">
                            <button
                                className="dl-btn dl-btn--ghost dl-btn--sm"
                                onClick={selectAll}
                                disabled={selected.size === totalOptions}
                            >
                                All
                            </button>
                            <button
                                className="dl-btn dl-btn--ghost dl-btn--sm"
                                onClick={selectNone}
                                disabled={selected.size === 0}
                            >
                                None
                            </button>
                            <span className="chroma-port-count">
                                {selected.size} / {totalOptions} selected
                            </span>
                        </div>

                        <div className="chroma-port-gallery">
                            <div className="chroma-port-grid">

                                {/* Base skin card — only for chroma projects */}
                                {baseSkinNum !== null && (() => {
                                    const isSel = selected.has(baseSkinNum);
                                    return (
                                        <button
                                            className={`chroma-port-card${isSel ? ' chroma-port-card--selected' : ''}`}
                                            onClick={() => toggle(baseSkinNum)}
                                            title={baseSkinName ?? `Skin ${baseSkinNum}`}
                                        >
                                            {!baseImgError && baseSkinTileUrl ? (
                                                <img
                                                    className="chroma-port-card__img"
                                                    src={baseSkinTileUrl}
                                                    alt={baseSkinName ?? ''}
                                                    onError={() => setBaseImgError(true)}
                                                />
                                            ) : (
                                                <div className="chroma-port-card__swatch chroma-port-card__swatch--base" />
                                            )}
                                            <div className="chroma-port-card__label">
                                                <span className="chroma-port-card__name chroma-port-card__name--base">
                                                    Base
                                                </span>
                                            </div>
                                            {isSel && <span className="chroma-port-card__check">✓</span>}
                                        </button>
                                    );
                                })()}

                                {/* Chroma cards */}
                                {chromas.map((chroma) => {
                                    const isSel = selected.has(chroma.skinNum);
                                    const c1 = chroma.colors[0] ?? '#888888';
                                    const c2 = chroma.colors[1];
                                    const label = chromaLabel(chroma.name, parentSkinName, chroma.skinNum);
                                    const showImg = champId !== null && !imgErrors.has(chroma.id);
                                    return (
                                        <button
                                            key={chroma.skinNum}
                                            className={`chroma-port-card${isSel ? ' chroma-port-card--selected' : ''}`}
                                            onClick={() => toggle(chroma.skinNum)}
                                            title={chroma.name ?? `Skin ${chroma.skinNum}`}
                                        >
                                            {showImg ? (
                                                <img
                                                    className="chroma-port-card__img"
                                                    src={getChromaImageUrl(champId!, chroma.id)}
                                                    alt={chroma.name ?? ''}
                                                    onError={() =>
                                                        setImgErrors((p) => new Set(p).add(chroma.id))
                                                    }
                                                />
                                            ) : (
                                                <div
                                                    className="chroma-port-card__swatch"
                                                    style={{
                                                        background: c2
                                                            ? `linear-gradient(135deg, ${c1} 50%, ${c2} 50%)`
                                                            : c1,
                                                    }}
                                                />
                                            )}
                                            <div className="chroma-port-card__label">
                                                <span className="chroma-port-card__name">{label}</span>
                                            </div>
                                            {isSel && (
                                                <span className="chroma-port-card__check">✓</span>
                                            )}
                                        </button>
                                    );
                                })}

                            </div>
                        </div>
                    </>
                )}
            </ModalBody>

            <ModalFooter>
                <Button variant="secondary" onClick={closeModal} disabled={busy}>
                    Cancel
                </Button>
                <Button variant="primary" onClick={handleConfirm} disabled={!canConfirm}>
                    {selected.size > 0 ? `Port (${selected.size})` : 'Port'}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
