/**
 * Flint - Chroma Port Modal
 *
 * Right-click on project root → "Port to Chromas…" opens this.
 * Fetches CDragon chroma data for the current project's skin, lets the user
 * pick which chromas to target, then calls portProjectToChromas.
 */

import React, { useEffect, useState } from 'react';
import { useAppState } from '../../lib/stores';
import * as api from '../../lib/api';
import { fetchChampions, fetchChampionSkins } from '../../lib/datadragon';
import type { DDragonChroma } from '../../lib/datadragon';
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
    const { state, closeModal, showToast } = useAppState();

    const isVisible = state.activeModal === 'chromaPort';

    const activeTab = state.activeTabId
        ? state.openTabs.find((t) => t.id === state.activeTabId)
        : null;
    const project = activeTab?.project ?? null;
    const projectPath = activeTab?.projectPath ?? null;

    const [chromas, setChromas] = useState<DDragonChroma[]>([]);
    const [loading, setLoading] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!isVisible || !project) return;
        let cancelled = false;

        setLoading(true);
        setFetchError(null);
        setChromas([]);
        setSelected(new Set());

        (async () => {
            try {
                const champions = await fetchChampions();
                const champ = champions.find(
                    (c) => c.alias.toLowerCase() === project.champion.toLowerCase(),
                );
                if (!champ) throw new Error(`Champion "${project.champion}" not found in CDragon`);

                const skins = await fetchChampionSkins(champ.id, champ.alias);
                const skin = skins.find((s) => s.num === project.skin_id);
                if (!skin)
                    throw new Error(
                        `Skin ${project.skin_id} not found for ${project.champion}`,
                    );

                if (cancelled) return;
                const skinChromas = skin.chromas ?? [];
                if (skinChromas.length === 0) {
                    setFetchError('This skin has no chromas in CDragon data.');
                } else {
                    setChromas(skinChromas);
                    setSelected(new Set(skinChromas.map((c) => c.skinNum)));
                }
            } catch (e) {
                if (!cancelled) setFetchError((e as Error).message ?? String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => {
            cancelled = true;
        };
    }, [isVisible, project]);

    const toggle = (skinNum: number) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(skinNum)) next.delete(skinNum);
            else next.add(skinNum);
            return next;
        });

    const selectAll = () => setSelected(new Set(chromas.map((c) => c.skinNum)));
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
                `Ported ${count} BIN${count === 1 ? '' : 's'} to ${n} chroma${n === 1 ? '' : 's'}`,
            );
            closeModal();
        } catch (err) {
            const fe = err as api.FlintError;
            showToast('error', fe.getUserMessage?.() || `Port failed: ${err}`);
        } finally {
            setBusy(false);
        }
    };

    const canConfirm = !busy && !loading && selected.size > 0 && chromas.length > 0;

    return (
        <Modal open={isVisible} onClose={busy ? () => {} : closeModal}>
            {busy && <ModalLoading text="Porting to Chromas" progress="Writing BIN files…" />}

            <ModalHeader title="Port to Chromas" onClose={closeModal} />

            <ModalBody>
                {loading && (
                    <div
                        style={{
                            display: 'flex',
                            alignItems: 'center',
                            gap: 8,
                            padding: '12px 0',
                        }}
                    >
                        <Spinner size="sm" />
                        <span style={{ color: 'var(--text-secondary)', fontSize: 13 }}>
                            Loading chroma data…
                        </span>
                    </div>
                )}

                {!loading && fetchError && (
                    <p style={{ color: 'var(--status-error, #e05252)', margin: 0, fontSize: 13 }}>
                        {fetchError}
                    </p>
                )}

                {!loading && !fetchError && chromas.length > 0 && (
                    <>
                        <p style={{ margin: '0 0 10px', color: 'var(--text-secondary)', fontSize: 13 }}>
                            Each selected chroma gets its own BIN set with the correct skin path.
                        </p>

                        <div
                            style={{
                                display: 'flex',
                                gap: 6,
                                marginBottom: 10,
                            }}
                        >
                            <button
                                className="btn btn--ghost btn--sm"
                                onClick={selectAll}
                                disabled={selected.size === chromas.length}
                            >
                                All
                            </button>
                            <button
                                className="btn btn--ghost btn--sm"
                                onClick={selectNone}
                                disabled={selected.size === 0}
                            >
                                None
                            </button>
                            <span
                                style={{
                                    marginLeft: 'auto',
                                    fontSize: 11,
                                    color: 'var(--text-muted)',
                                    alignSelf: 'center',
                                }}
                            >
                                {selected.size} / {chromas.length} selected
                            </span>
                        </div>

                        <div className="chroma-port-grid">
                            {chromas.map((chroma) => {
                                const isSel = selected.has(chroma.skinNum);
                                const c1 = chroma.colors[0] ?? '#888888';
                                const c2 = chroma.colors[1];
                                const label =
                                    chroma.name?.replace(/^.*?Chroma\s*/i, '').trim() ||
                                    `Skin ${chroma.skinNum}`;
                                return (
                                    <button
                                        key={chroma.skinNum}
                                        className={`chroma-port-card${isSel ? ' chroma-port-card--selected' : ''}`}
                                        onClick={() => toggle(chroma.skinNum)}
                                        title={chroma.name ?? `Skin ${chroma.skinNum}`}
                                    >
                                        <div
                                            className="chroma-port-card__swatch"
                                            style={{
                                                background: c2
                                                    ? `linear-gradient(135deg, ${c1} 50%, ${c2} 50%)`
                                                    : c1,
                                            }}
                                        />
                                        <span className="chroma-port-card__name">{label}</span>
                                        {isSel && (
                                            <span className="chroma-port-card__check">✓</span>
                                        )}
                                    </button>
                                );
                            })}
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
