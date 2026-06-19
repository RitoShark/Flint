import React, { useState, useEffect, useCallback } from 'react';
import { useModalStore, useNotificationStore, useProjectTabStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { Modal, ModalHeader, ModalBody } from '../ui';
import type { MapTextureSection, CombineMode } from '../../lib/api';

export const MapTexturesModal: React.FC = () => {
    const activeModal = useModalStore((s) => s.activeModal);
    const closeModal = useModalStore((s) => s.closeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);

    const isVisible = activeModal === 'map-textures';
    const projectPath = (activeTabId ? openTabs.find((t) => t.id === activeTabId) : null)?.projectPath || null;

    const [sections, setSections] = useState<MapTextureSection[]>([]);
    const [mode, setMode] = useState<CombineMode>('Combined');
    const [busy, setBusy] = useState<string | null>(null);

    const refresh = useCallback(async () => {
        if (!projectPath) return;
        try {
            setSections(await api.listMapTextureSections(projectPath));
        } catch (e) {
            showToast('error', `Could not list texture sections: ${(e as Error).message || e}`);
        }
    }, [projectPath, showToast]);

    useEffect(() => {
        if (isVisible) void refresh();
    }, [isVisible, refresh]);

    const onCombine = useCallback(async (section: MapTextureSection) => {
        if (!projectPath) return;
        if (section.exists && !window.confirm(`${section.name} PSD already exists. Regenerate and overwrite it?`)) return;
        try {
            setBusy(section.name);
            const psd = await api.combineSection(projectPath, section.name, mode);
            await api.openWithDefaultApp(psd.replace(/\//g, '\\'));
            showToast('success', `${section.name} PSD created`);
            await refresh();
        } catch (e) {
            showToast('error', `Combine ${section.name} failed: ${(e as Error).message || e}`);
        } finally {
            setBusy(null);
        }
    }, [projectPath, mode, showToast, refresh]);

    const onOpen = useCallback(async (section: MapTextureSection) => {
        if (!projectPath) return;
        try {
            await api.openWithDefaultApp(api.sectionPsdPath(projectPath, section.name).replace(/\//g, '\\'));
        } catch (e) {
            showToast('error', `Open ${section.name} failed: ${(e as Error).message || e}`);
        }
    }, [projectPath, showToast]);

    const onApply = useCallback(async (section: MapTextureSection) => {
        if (!projectPath) return;
        try {
            setBusy(section.name);
            const r = await api.applySection(projectPath, section.name);
            showToast('success', `Applied ${section.name}: ${r.written} written` +
                (r.skipped.length ? `, ${r.skipped.length} skipped` : '') +
                (r.errors.length ? `, ${r.errors.length} errors` : ''));
        } catch (e) {
            showToast('error', `Apply ${section.name} failed: ${(e as Error).message || e}`);
        } finally {
            setBusy(null);
        }
    }, [projectPath, showToast]);

    return (
        <Modal open={isVisible} onClose={closeModal} size="wide">
            <ModalHeader title="Map Textures" onClose={closeModal} />
            <ModalBody>
                <p style={{ color: 'var(--text-secondary)', fontSize: 13, marginTop: 0 }}>
                    Combine a section's textures into a layered PSD, edit it in GIMP/Photoshop,
                    then apply it back. Files live in <code>textures-psd/</code>. The bin is never touched.
                </p>

                <div style={{ display: 'flex', alignItems: 'center', gap: 10, margin: '6px 0 14px' }}>
                    <span style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Layout:</span>
                    {(['Combined', 'Split'] as CombineMode[]).map((m) => (
                        <label key={m} style={{ display: 'flex', alignItems: 'center', gap: 4, fontSize: 13, cursor: 'pointer' }}>
                            <input type="radio" name="combine-mode" checked={mode === m} onChange={() => setMode(m)} />
                            {m}
                            <span style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                {m === 'Combined' ? '(one big paintable picture)' : '(one layer per texture)'}
                            </span>
                        </label>
                    ))}
                </div>

                {sections.length === 0 && (
                    <div style={{ color: 'var(--text-muted)', fontSize: 13 }}>No texture sections found.</div>
                )}

                <div style={{ display: 'flex', flexDirection: 'column', gap: 6 }}>
                    {sections.map((s) => {
                        const isBusy = busy === s.name;
                        const anyBusy = busy !== null;
                        const empty = s.tile_count === 0;
                        return (
                            <div
                                key={s.name}
                                style={{
                                    display: 'flex', alignItems: 'center', gap: 10,
                                    padding: '8px 10px', borderRadius: 6,
                                    background: 'var(--bg-secondary)', border: '1px solid var(--border)',
                                    opacity: empty ? 0.5 : 1,
                                }}
                            >
                                <div style={{ flex: 1, minWidth: 0 }}>
                                    <div style={{ fontWeight: 600, fontSize: 13 }}>{s.name}</div>
                                    <div style={{ fontSize: 11, color: 'var(--text-muted)' }}>
                                        {s.tile_count} tile{s.tile_count === 1 ? '' : 's'}
                                        {s.exists ? ' · PSD ready' : ' · not generated'}
                                    </div>
                                </div>
                                <button className="btn btn--sm" disabled={anyBusy || empty} onClick={() => onCombine(s)}>
                                    {isBusy ? '…' : s.exists ? 'Regenerate' : 'Combine'}
                                </button>
                                <button className="btn btn--sm" disabled={anyBusy || !s.exists} onClick={() => onOpen(s)}>Open</button>
                                <button className="btn btn--sm" disabled={anyBusy || !s.exists} onClick={() => onApply(s)}>Apply</button>
                            </div>
                        );
                    })}
                </div>
            </ModalBody>
        </Modal>
    );
};
