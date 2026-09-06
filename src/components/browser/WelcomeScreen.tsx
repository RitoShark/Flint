import { Button } from '../ui/Button';
import { Icon } from '../ui/Icon';
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

const RECENT_DEFAULT_LIMIT = 5;

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
                console.debug('[Welcome] recent-project validity check failed:', error);
            }
        })();
        return () => { cancelled = true; };
    }, []);

    const handleDroppedFolder = useCallback(async (path: string) => {
        const outcome = await openOrImportFolder(path);
        if (outcome.kind === 'rejected') {
            showToast('error', outcome.reason);
        } else if (outcome.kind === 'imported') {
            showToast('success', `Imported ${outcome.project.display_name || outcome.project.name}`);
        }
    }, [showToast]);

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

    const handleRemoveRecent = (e: React.MouseEvent, projectPath: string) => {
        e.stopPropagation();
        useConfigStore.getState().setRecentProjects(
            recentProjects.filter(p => !isSameProjectPath(p.path, projectPath)),
        );
    };

    const total = recentProjects.length;
    const visible = recentProjects.slice(0, showAllRecent ? total : RECENT_DEFAULT_LIMIT);
    const hidden = total - visible.length;

    return (
        <div className={`welcome ${dragOver ? 'welcome--drag-over' : ''}`} ref={dropZoneRef}>
            {dragOver && (
                <div className="welcome__drop-overlay">
                    <span className="welcome__drop-icon" dangerouslySetInnerHTML={{ __html: getIcon('folderOpen2') }} />
                    <span className="welcome__drop-title">{t('welcome.dropTitle')}</span>
                    <span className="welcome__drop-hint">{t('welcome.dropHint')}</span>
                </div>
            )}

            <section className="welcome__hero">
                <p className="welcome__greeting">{t(greetingKey)},</p>
                <h1 className="welcome__creator-name">{creatorName}</h1>
                <p className="welcome__subtitle">{t('welcome.subtitle')}</p>

                <div className="welcome__tiles">
                    <Button variant="primary" layout="tile" icon="plus" data-action="create-project" onClick={() => openModal('newProject')}>
                        <span className="btn__label">
                            <span className="btn__title">{t('welcome.createProject')}</span>
                            <span className="btn__sub">{t('welcome.createProjectSub')}</span>
                        </span>
                    </Button>
                    <Button layout="tile" icon="wad" data-action="wad-explorer" onClick={() => navigationCoordinator.openWadExplorer()}>
                        <span className="btn__label">
                            <span className="btn__title">{t('welcome.wadExplorer')}</span>
                            <span className="btn__sub">{t('welcome.wadExplorerSub')}</span>
                        </span>
                    </Button>
                    <Button layout="tile" icon="folderOpen2" data-action="open-mods" onClick={() => openModal('projectList')}>
                        <span className="btn__label">
                            <span className="btn__title">{t('welcome.openMods')}</span>
                            <span className="btn__sub">{t('welcome.openModsSub')}</span>
                        </span>
                    </Button>
                    <Button layout="tile" icon="package" data-action="browse-wad" onClick={() => openModal('browseWad')}>
                        <span className="btn__label">
                            <span className="btn__title">{t('welcome.browseWadFile')}</span>
                            <span className="btn__sub">{t('welcome.browseWadFileSub')}</span>
                        </span>
                    </Button>
                </div>
            </section>

            <aside className="welcome__recent">
                {total > 0 && (
                    <>
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
                                    <Icon name="folder" className="welcome__recent-icon" />
                                    <span className="welcome__recent-info">
                                        <span className="welcome__recent-name">{project.name}</span>
                                        <span className="welcome__recent-path">{project.path}</span>
                                    </span>
                                    <span className="welcome__recent-actions">
                                        <span className="welcome__recent-date">
                                            {formatRelativeTime(project.lastOpened)}
                                        </span>
                                        <Button
                                            className="welcome__recent-delete" variant="ghost" size="sm" iconOnly
                                            onClick={(e) => handleRemoveRecent(e, project.path)}
                                            title={t('welcome.removeRecent')}
                                        >
                                            <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                                                <path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" />
                                            </svg>
                                        </Button>
                                    </span>
                                </div>
                            ))}
                        </div>
                        {total > RECENT_DEFAULT_LIMIT && (
                            <Button
                                className="welcome__recent-toggle" variant="ghost" size="sm"
                                onClick={() => setShowAllRecent((v) => !v)}
                            >
                                {showAllRecent
                                    ? t('welcome.showFewer')
                                    : t('welcome.showAll', { count: hidden })}
                                <svg width="12" height="12" viewBox="0 0 16 16" fill="none" style={{ transform: showAllRecent ? 'rotate(180deg)' : 'none', transition: 'transform 220ms ease' }}>
                                    <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                                </svg>
                            </Button>
                        )}
                    </>
                )}
                <div className="welcome__drop-note">
                    <Icon name="import" className="welcome__drop-note-icon" />
                    <span>
                        <strong>{t('welcome.dropTitle')}</strong>
                        {t('welcome.dropHint')}
                    </span>
                </div>
            </aside>
        </div>
    );
};
