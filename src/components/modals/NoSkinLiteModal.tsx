import React, { useEffect, useState } from 'react';
import { useModalStore, useNotificationStore, useProjectTabStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { fetchSkinSlots, skinLiteRange } from '../../lib/data/skinSlots';
import { liveChampionAlias } from '../../lib/data/datadragon';
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

const FALLBACK_MAX = 99;
const CEILING_MARGIN = 20;

export const NoSkinLiteModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const setFileTree = useProjectTabStore((s) => s.setFileTree);

    const isVisible = activeModal === 'noSkinLite';

    const activeTab = activeTabId ? openTabs.find((t) => t.id === activeTabId) : null;
    const project = activeTab?.project ?? null;
    const projectPath = activeTab?.projectPath ?? null;

    const [targets, setTargets] = useState<PortTarget[]>([]);
    const [selected, setSelected] = useState<Set<number>>(new Set());
    const [loading, setLoading] = useState(false);
    const [estimated, setEstimated] = useState(false);
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!isVisible || !project) return;
        let cancelled = false;

        setLoading(true);
        setTargets([]);
        setSelected(new Set());
        setEstimated(false);

        (async () => {
            const alias = liveChampionAlias(project.champion);
            const slots = await fetchSkinSlots(alias);
            if (cancelled) return;

            const range = skinLiteRange(slots, FALLBACK_MAX, CEILING_MARGIN)
                .filter((n) => n !== project.skin_id);

            setEstimated(!slots);
            setTargets(range.map((n) => ({ id: n, label: `skin${n}` })));
            setSelected(new Set(range));
            setLoading(false);
        })();

        return () => { cancelled = true; };
    }, [isVisible, project]);

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
            const outcome = await api.portProjectNoSkinLite(
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
                showToast('info', `Nothing to write — all ${skipped.length} slots already exist.`);
            } else {
                showToast(
                    'success',
                    `Cloned into ${written.length} slot${written.length === 1 ? '' : 's'}`
                    + (skipped.length > 0 ? ` (${skipped.length} already existed)` : '')
                    + (estimated ? ' — slot ceiling estimated, CommunityDragon was unreachable' : ''),
                );
            }
            closeModal();
        } catch (err) {
            const fe = err as api.FlintError;
            showToast('error', fe.getUserMessage?.() || `NoSkinLite failed: ${err}`);
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal open={isVisible} onClose={busy ? () => {} : closeModal}>
            {busy && <ModalLoading text="Running NoSkinLite" progress="Writing BIN files…" />}

            <ModalHeader title="NoSkinLite" onClose={closeModal} />

            <ModalBody>
                <p className="skin-port__intro">
                    Clones <code>skin{project?.skin_id ?? 0}.bin</code> into every other skin slot so
                    the mod applies whichever skin the player has selected. This writes
                    <strong> {selected.size} new files </strong>
                    into the project. Any slot that already has a BIN is skipped, never overwritten.
                </p>

                {estimated && !loading && (
                    <p className="skin-port__warn">
                        CommunityDragon was unreachable — the slot ceiling is a fallback estimate.
                    </p>
                )}

                {loading && (
                    <div className="skin-port__loading">
                        <Spinner size="sm" />
                        <span>Reading the champion&rsquo;s skin slots…</span>
                    </div>
                )}

                {!loading && targets.length > 0 && (
                    <TargetGrid
                        targets={targets}
                        selected={selected}
                        onToggle={toggle}
                        onSelectAll={() => setSelected(new Set(targets.map((t) => t.id)))}
                        onSelectNone={() => setSelected(new Set())}
                        variant="chip"
                        noun="slots"
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
                    {selected.size > 0 ? `Clone (${selected.size})` : 'Clone'}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
