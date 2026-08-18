import React, { useState, useEffect, useRef, useCallback } from 'react';
import { useConfigStore, useModalStore, useAppMetadataStore, useNotificationStore } from '../../lib/stores';
import { navigationCoordinator } from '../../lib/stores/navigationCoordinator';
import { formatRelativeTime } from '../../lib/util/utils';
import * as api from '../../lib/api';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { useFolderDrop } from '../../lib/folderDrop';
import { openOrImportFolder, openProjectAt, isSameProjectPath } from '../../lib/projectOpen';
import type { RecentProject } from '../../lib/types';
import { useTranslation } from '../../lib/i18n';

const ClockIcon: React.FC = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <circle cx="12" cy="12" r="10" stroke="currentColor" strokeWidth="2" />
        <path d="M12 6v6l4 2" stroke="currentColor" strokeWidth="2" strokeLinecap="round" />
    </svg>
);


// =============================================================================
// Welcome Screen
// =============================================================================

/** How many recent projects to show before "Show all" is clicked. */
const RECENT_DEFAULT_LIMIT = 3;

export const WelcomeScreen: React.FC = () => {
    const { t } = useTranslation();
    const recentProjects = useConfigStore((s) => s.recentProjects);
    const creatorName = useConfigStore((s) => s.creatorName) || 'Creator';
    const openModal = useModalStore((s) => s.openModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const setWorking = useAppMetadataStore((s) => s.setWorking);
    const setReady = useAppMetadataStore((s) => s.setReady);
    const setError = useAppMetadataStore((s) => s.setError);
    const showToast = useNotificationStore((s) => s.showToast);
    const [greetingKey, setGreetingKey] = useState('welcome.greeting.morning');
    const [showAllRecent, setShowAllRecent] = useState(false);
    const dropZoneRef = useRef<HTMLDivElement>(null);

    // Drop recents whose folder is gone. App.tsx also sweeps once ~3s after
    // launch, but a project deleted while Flint is running would otherwise sit
    // in the list until the next restart — so re-check whenever the list is
    // actually shown. Reads the store directly instead of depending on
    // `recentProjects`, which would re-run the effect on every prune.
    useEffect(() => {
        let cancelled = false;
        (async () => {
            const recent = useConfigStore.getState().recentProjects;
            if (recent.length === 0) return;
            try {
                const validity = await api.projectsPathValid(recent.map((p) => p.path));
                if (cancelled) return;
                const valid = recent.filter((_, i) => validity[i]);
                if (valid.length !== recent.length) {
                    useConfigStore.getState().setRecentProjects(valid);
                }
            } catch (error) {
                // Non-fatal: a failed check just leaves the list as-is.
                console.debug('[Welcome] recent-project validity check failed:', error);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    // Drop a Flint project folder to open it, or an extracted WAD folder to
    // import it. The whole welcome surface is the target.
    const handleDroppedFolder = useCallback(async (path: string) => {
        const outcome = await openOrImportFolder(path);
        if (outcome.kind === 'rejected') {
            showToast('error', outcome.reason);
        } else if (outcome.kind === 'imported') {
            showToast('success', `Imported ${outcome.project.display_name || outcome.project.name}`);
        }
    }, [showToast]);

    // Stand down while any modal is open — the project list renders its own
    // drop zone on top, and both listeners would otherwise fire for one drop.
    const dragOver = useFolderDrop(handleDroppedFolder, {
        zoneRef: dropZoneRef,
        enabled: activeModal === null,
    });

    useEffect(() => {
        const getGreetingKey = () => {
            const hour = new Date().getHours();
            if (hour >= 7 && hour < 12) return 'welcome.greeting.morning';
            if (hour >= 12 && hour < 18) return 'welcome.greeting.afternoon';
            if (hour >= 18 && hour < 22) return 'welcome.greeting.evening';
            return 'welcome.greeting.night';
        };
        setGreetingKey(getGreetingKey());

        const interval = setInterval(() => setGreetingKey(getGreetingKey()), 60000);
        return () => clearInterval(interval);
    }, []);

    const openRecentProject = async (projectPath: string) => {
        try {
            setWorking('Opening project...');
            await openProjectAt(projectPath);
            setReady();
        } catch (error) {
            console.error('Failed to open project:', error);
            const flintError = error as api.FlintError;
            setError(flintError.getUserMessage?.() || 'Failed to open project');
        }
    };

    const handleOpenProject = () => {
        openModal('projectList');
    };

    const handleRemoveRecent = (e: React.MouseEvent, projectPath: string) => {
        e.stopPropagation();
        useConfigStore.getState().setRecentProjects(
            recentProjects.filter(p => !isSameProjectPath(p.path, projectPath)),
        );
    };

    const handleOpenWadExplorer = () => {
        navigationCoordinator.openWadExplorer();
    };

    return (
        <div className={`welcome ${dragOver ? 'welcome--drag-over' : ''}`} ref={dropZoneRef}>
            {dragOver && (
                <div className="welcome__drop-overlay">
                    <span className="welcome__drop-icon" dangerouslySetInnerHTML={{ __html: getIcon('folderOpen2') }} />
                    <span className="welcome__drop-title">{t('welcome.dropTitle')}</span>
                    <span className="welcome__drop-hint">{t('welcome.dropHint')}</span>
                </div>
            )}
            <div className="welcome__header">
                <h1 className="welcome__greeting">
                    {t(greetingKey)}, <span className="welcome__creator-name">{creatorName}</span>
                </h1>
                <p className="welcome__subtitle">{t('welcome.subtitle')}</p>
            </div>

            <div className="welcome__columns">
                <div className="welcome__column welcome__column--left">
                    <h2 className="welcome__column-title">{t('welcome.folders')}</h2>

                    <div className="welcome__actions">
                        <button className="btn btn--primary btn--large" onClick={() => openModal('newProject')}>
                            <span>{t('welcome.createProject')}</span>
                            <span dangerouslySetInnerHTML={{ __html: getIcon('plus') }} />
                        </button>

                        <button className="btn btn--secondary btn--large" onClick={handleOpenProject}>
                            <span>{t('welcome.openMods')}</span>
                            <span dangerouslySetInnerHTML={{ __html: getIcon('folderOpen2') }} />
                        </button>
                    </div>

                    {recentProjects.length > 0 && (() => {
                        const total = recentProjects.length;
                        const limit = showAllRecent ? total : RECENT_DEFAULT_LIMIT;
                        const visible = recentProjects.slice(0, limit);
                        const hidden = total - visible.length;
                        return (
                            <div className="welcome__recent">
                                <h3 className="welcome__recent-title">
                                    <ClockIcon />
                                    <span>{t('welcome.recentFolders')}</span>
                                    <span className="welcome__recent-count">{total}</span>
                                </h3>
                                <div className="welcome__recent-list">
                                    {visible.map((project: RecentProject) => (
                                         <div
                                            key={project.path}
                                            className="welcome__recent-item"
                                            onClick={() => openRecentProject(project.path)}
                                        >
                                            <div className="welcome__recent-info">
                                                <span className="welcome__recent-icon" dangerouslySetInnerHTML={{ __html: getIcon('folder') }} />
                                                <span className="welcome__recent-name">
                                                    {project.name}
                                                </span>
                                            </div>
                                            <div className="welcome__recent-actions">
                                                <span className="welcome__recent-date">
                                                    {formatRelativeTime(project.lastOpened)}
                                                </span>
                                                <button
                                                    className="welcome__recent-delete"
                                                    onClick={(e) => handleRemoveRecent(e, project.path)}
                                                    title={t('welcome.removeRecent')}
                                                >
                                                    <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                                        <path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                                    </svg>
                                                </button>
                                            </div>
                                        </div>
                                    ))}
                                </div>
                                {(hidden > 0 || showAllRecent) && total > RECENT_DEFAULT_LIMIT && (
                                    <button
                                        type="button"
                                        className="welcome__recent-toggle"
                                        onClick={() => setShowAllRecent((v) => !v)}
                                    >
                                        {showAllRecent
                                            ? t('welcome.showFewer')
                                            : t('welcome.showAll', { count: hidden })}
                                        <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ transform: showAllRecent ? 'rotate(180deg)' : 'none', transition: 'transform 220ms ease' }}>
                                            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                        </svg>
                                    </button>
                                )}
                            </div>
                        );
                    })()}
                </div>

                <div className="welcome__divider"></div>

                <div className="welcome__column welcome__column--right">
                    <h2 className="welcome__column-title">{t('welcome.exploreFiles')}</h2>

                    <div className="welcome__actions">
                        <button className="btn btn--secondary btn--large" onClick={() => openModal('browseWad')}>
                            <span dangerouslySetInnerHTML={{ __html: getIcon('package') }} />
                            <span>{t('welcome.browseWadFile')}</span>
                        </button>

                        <button className="btn btn--secondary btn--large" onClick={handleOpenWadExplorer}>
                            <svg width="16" height="16" viewBox="0 0 24 24" fill="none" xmlns="http://www.w3.org/2000/svg">
                                <rect x="3" y="5" width="18" height="14" rx="2" stroke="currentColor" strokeWidth="2" />
                                <path d="M3 9h18M8 5V3m8 2V3" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                            </svg>
                            <span>{t('welcome.wadExplorer')}</span>
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
