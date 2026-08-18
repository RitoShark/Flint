import React, { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalStore, useProjectTabStore, useConfigStore, useNotificationStore, useNavigationStore } from '../../lib/stores';
import { navigationCoordinator } from '../../lib/stores/navigationCoordinator';
import * as api from '../../lib/api';
import { useTranslation } from '../../lib/i18n';

export const RenameProjectModal: React.FC = () => {
    const { t } = useTranslation();
    const closeModal = useModalStore((s) => s.closeModal);
    const modalOptions = useModalStore((s) => s.modalOptions) as { projectPath?: string } | null;
    const showToast = useNotificationStore((s) => s.showToast);
    const projectPath = modalOptions?.projectPath ?? '';

    const tab = useProjectTabStore((s) => s.openTabs.find((t) => t.projectPath === projectPath));
    const current = tab?.project.display_name || tab?.project.name || '';

    const [name, setName] = useState(current);
    const [busy, setBusy] = useState(false);
    const inputRef = useRef<HTMLInputElement>(null);

    useEffect(() => { setName(current); }, [current]);
    useEffect(() => { inputRef.current?.focus(); inputRef.current?.select(); }, []);
    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !busy) closeModal(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [busy, closeModal]);

    const trimmed = name.trim();
    const canSave = !!tab && trimmed.length > 0 && trimmed !== current && !busy;

    const save = async () => {
        if (!tab || !canSave) return;
        const oldTabId = tab.id;
        setBusy(true);
        try {
            // Windows refuses to rename a directory the preview watcher holds open.
            await api.stopPreviewWatcher().catch(() => {});

            const result = await api.hardRenameProject(tab.project, projectPath, trimmed);

            const { project, fileTree } = await api.openProjectWithTree(result.new_project_path);
            useProjectTabStore.getState().addTab(project, result.new_project_path);
            const newTabId = useProjectTabStore.getState().activeTabId;
            if (newTabId) useProjectTabStore.getState().setFileTree(newTabId, fileTree);
            useNavigationStore.getState().setView('preview');
            navigationCoordinator.removeTabWithFallback(oldTabId);

            const cfg = useConfigStore.getState();
            cfg.setSavedProjects(cfg.savedProjects.map((p) =>
                p.path === projectPath ? { ...p, path: result.new_project_path, name: trimmed } : p,
            ));

            showToast(
                'success',
                `Renamed to “${trimmed}” — ${result.strings_changed} path${result.strings_changed === 1 ? '' : 's'} in ${result.bins_changed} bin${result.bins_changed === 1 ? '' : 's'}, ${result.folders_renamed} folder${result.folders_renamed === 1 ? '' : 's'}`,
            );
            if (result.skipped_bins.length > 0) {
                showToast('warning', `${result.skipped_bins.length} BIN(s) couldn’t be parsed and were left unchanged`);
            }
            closeModal();
        } catch (err) {
            // Rename failed — restore the preview watcher stopped above.
            api.startPreviewWatcher(projectPath).catch(() => {});
            const fe = err as api.FlintError;
            showToast('error', fe.getUserMessage?.() || 'Failed to rename project');
        } finally {
            setBusy(false);
        }
    };

    return createPortal(
        <div
            className="dl-modal-backdrop"
            onMouseDown={(e) => { if (e.target === e.currentTarget && !busy) closeModal(); }}
        >
            <div className="dl-modal" role="dialog" aria-modal="true" style={{ maxWidth: 420 }}>
                <div className="dl-modal__head">
                    <h3 className="dl-modal__title">{t('renameProject.title')}</h3>
                </div>

                <div className="dl-modal__body">
                    <label style={{ display: 'grid', gap: 6 }}>
                        <span style={{
                            fontSize: 10.5, fontWeight: 600, letterSpacing: '.05em',
                            textTransform: 'uppercase', color: 'var(--text-muted)',
                        }}>
                            {t('renameProject.label')}
                        </span>
                        <input
                            ref={inputRef}
                            className="dl-input"
                            value={name}
                            onChange={(e) => setName(e.target.value)}
                            onKeyDown={(e) => { if (e.key === 'Enter' && canSave) save(); }}
                            placeholder={t('renameProject.placeholder')}
                            disabled={busy}
                        />
                    </label>

                    <p style={{ margin: 0, fontSize: 12, lineHeight: 1.5, color: 'var(--text-muted)' }}>
                        {t('renameProject.desc')}
                    </p>
                </div>

                <div className="dl-modal__foot" style={{ justifyContent: 'flex-end' }}>
                    <button className="dl-btn dl-btn--ghost" onClick={closeModal} disabled={busy}>
                        {t('common.cancel')}
                    </button>
                    <button
                        className={`dl-btn dl-btn--primary${busy ? ' dl-btn--loading' : ''}`}
                        onClick={save}
                        disabled={!canSave}
                    >
                        {t('common.save')}
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};
