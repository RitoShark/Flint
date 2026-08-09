import React, { useEffect, useState } from 'react';
import { useModalStore, useNotificationStore, useProjectTabStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { fetchSkinSlots } from '../../lib/data/skinSlots';
import {
    CLASSIC_SKIN_NUM_MIN,
    fetchChampionSkins,
    fetchJadeChampions,
    isJadeAlias,
    liveChampionAlias,
    resolveCDragonAsset,
} from '../../lib/data/datadragon';
import {
    Button,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    ModalLoading,
    Spinner,
} from '../ui';
import { TargetGrid, type PortTarget } from './skin-port/TargetGrid';

function jadeAlias(champion: string): string {
    return isJadeAlias(champion) ? champion : `Jade_${champion}`;
}

export const PortToJadeModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const setFileTree = useProjectTabStore((s) => s.setFileTree);

    const isVisible = activeModal === 'portToJade';

    const activeTab = activeTabId ? openTabs.find((t) => t.id === activeTabId) : null;
    const project = activeTab?.project ?? null;
    const projectPath = activeTab?.projectPath ?? null;

    const [targets, setTargets] = useState<PortTarget[]>([]);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [loading, setLoading] = useState(false);
    const [fetchError, setFetchError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!isVisible || !project) return;
        let cancelled = false;

        setLoading(true);
        setFetchError(null);
        setTargets([]);
        setSelected(new Set());

        (async () => {
            try {
                const alias = jadeAlias(liveChampionAlias(project.champion));
                const slots = await fetchSkinSlots(alias);
                if (cancelled) return;
                if (!slots || slots.length === 0) {
                    setFetchError(
                        `CommunityDragon lists no skin BINs for ${alias}. This champion may not be in League Classic yet.`,
                    );
                    return;
                }

                const artByNum = new Map<number, { name: string; tile?: string }>();
                try {
                    const jadeChamps = await fetchJadeChampions();
                    const champ = jadeChamps.find(
                        (c) => c.alias.toLowerCase() === alias.toLowerCase(),
                    );
                    if (champ) {
                        for (const skin of await fetchChampionSkins(champ.id, champ.alias)) {
                            artByNum.set(skin.num, {
                                name: skin.name,
                                tile: skin.tilePath ? resolveCDragonAsset(skin.tilePath) : undefined,
                            });
                        }
                    }
                } catch {
                    // Artwork is decoration; the directory listing is the authority
                    // on which slots exist.
                }
                if (cancelled) return;

                setTargets(
                    slots.map((num) => {
                        const art = artByNum.get(num);
                        return {
                            id: num,
                            label: art?.name ?? `Skin ${num}`,
                            imageUrl: art?.tile ?? null,
                        };
                    }),
                );
                setSelected(new Set(slots));
            } catch (e) {
                if (!cancelled) setFetchError((e as Error).message ?? String(e));
            } finally {
                if (!cancelled) setLoading(false);
            }
        })();

        return () => { cancelled = true; };
    }, [isVisible, project]);

    const classicSlots = targets
        .map((t) => t.id)
        .filter((id) => id >= CLASSIC_SKIN_NUM_MIN);

    const toggle = (id: number) =>
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });

    const handleConfirm = async () => {
        if (!project || !projectPath || selected.size === 0) return;
        setBusy(true);
        try {
            const outcome = await api.portProjectToJade(
                projectPath,
                liveChampionAlias(project.champion),
                project.skin_id,
                [...selected].sort((a, b) => a - b),
            );
            if (activeTabId) {
                try {
                    setFileTree(activeTabId, await api.listProjectFiles(projectPath));
                } catch {
                    // Tree catches up on the next natural refresh.
                }
            }
            const { written, skipped } = outcome;
            if (written.length === 0) {
                showToast('info', `Nothing to write — all ${skipped.length} targets already exist.`);
            } else {
                showToast(
                    'success',
                    `Ported to ${written.length} Classic skin${written.length === 1 ? '' : 's'}`
                    + (skipped.length > 0 ? ` (${skipped.length} already existed)` : ''),
                );
            }
            closeModal();
        } catch (err) {
            const fe = err as api.FlintError;
            showToast('error', fe.getUserMessage?.() || `Port to Jade failed: ${err}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal open={isVisible} onClose={busy ? () => {} : closeModal}>
            {busy && <ModalLoading text="Porting to Jade" progress="Writing BIN files…" />}

            <ModalHeader title="Port to Jade" onClose={closeModal} />

            <ModalBody>
                <p className="skin-port__intro">
                    Writes this mod into the League Classic character folder as its own
                    <code> skin&lt;N&gt;.bin </code>
                    per selected slot. Existing files are never overwritten.
                </p>

                {loading && (
                    <div className="skin-port__loading">
                        <Spinner size="sm" />
                        <span>Reading Classic skin slots…</span>
                    </div>
                )}

                {!loading && fetchError && <p className="skin-port__error">{fetchError}</p>}

                {!loading && !fetchError && targets.length > 0 && (
                    <TargetGrid
                        targets={targets}
                        selected={selected}
                        onToggle={toggle}
                        onSelectAll={() => setSelected(new Set(targets.map((t) => t.id)))}
                        onSelectNone={() => setSelected(new Set())}
                        variant="art"
                        noun="slots"
                        preset={{
                            label: 'Classic only',
                            title: 'Select just the Classic skin and its chromas',
                            onSelect: () => setSelected(new Set(classicSlots)),
                            disabled: classicSlots.length === 0,
                        }}
                    />
                )}
            </ModalBody>

            <ModalFooter>
                <Button variant="secondary" onClick={closeModal} disabled={busy}>
                    Cancel
                </Button>
                <Button
                    variant="primary"
                    onClick={handleConfirm}
                    disabled={busy || loading || selected.size === 0}
                >
                    {selected.size > 0 ? `Port (${selected.size})` : 'Port'}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
