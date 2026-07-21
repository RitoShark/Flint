import React, { useCallback, useState, useMemo, useEffect } from 'react';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { save } from '@tauri-apps/plugin-dialog';
import { useProjectTabStore, useWadExtractStore, useWadExplorerStore, useNavigationStore, useConfigStore, useModalStore, useNotificationStore, useFileEditorStore } from '../../lib/stores';
import { navigationCoordinator } from '../../lib/stores/navigationCoordinator';
import { useCdnManifestStore } from '../../lib/stores/cdnManifestStore';
import { useArchiveTabStore } from '../../lib/stores/archiveTabStore';
import type { ArchiveTab as ArchiveTabModel } from '../../lib/stores/archiveTabStore';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import * as api from '../../lib/api';
import { sanitizeChampionName } from '../../lib/util/utils';
import type { ProjectTab, ExtractSession } from '../../lib/types';

const MinimizeIcon: React.FC = () => (
    <svg width="14" height="14" viewBox="0 0 14 14" fill="none">
        <path d="M2 7H12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
);

const MaximizeIcon: React.FC = () => (
    <svg width="12" height="12" viewBox="0 0 12 12" fill="none">
        <rect x="2" y="2" width="8" height="8" stroke="currentColor" strokeWidth="1.5" rx="1"/>
    </svg>
);

const CloseIcon: React.FC = () => (
    <svg width="16" height="16" viewBox="0 0 16 16" fill="none">
        <path d="M4 4L12 12M12 4L4 12" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round"/>
    </svg>
);

const SettingsIcon: React.FC = () => (
    <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
        <path d="M12 15C13.6569 15 15 13.6569 15 12C15 10.3431 13.6569 9 12 9C10.3431 9 9 10.3431 9 12C9 13.6569 10.3431 15 12 15Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
        <path d="M19.4 15C19.2669 15.3016 19.2272 15.6362 19.286 15.9606C19.3448 16.285 19.4995 16.5843 19.73 16.82L19.79 16.88C19.976 17.0657 20.1235 17.2863 20.2241 17.5291C20.3248 17.7719 20.3766 18.0322 20.3766 18.295C20.3766 18.5578 20.3248 18.8181 20.2241 19.0609C20.1235 19.3037 19.976 19.5243 19.79 19.71C19.6043 19.896 19.3837 20.0435 19.1409 20.1441C18.8981 20.2448 18.6378 20.2966 18.375 20.2966C18.1122 20.2966 17.8519 20.2448 17.6091 20.1441C17.3663 20.0435 17.1457 19.896 16.96 19.71L16.9 19.65C16.6643 19.4195 16.365 19.2648 16.0406 19.206C15.7162 19.1472 15.3816 19.1869 15.08 19.32C14.7842 19.4468 14.532 19.6572 14.3543 19.9255C14.1766 20.1938 14.0813 20.5082 14.08 20.83V21C14.08 21.5304 13.8693 22.0391 13.4942 22.4142C13.1191 22.7893 12.6104 23 12.08 23C11.5496 23 11.0409 22.7893 10.6658 22.4142C10.2907 22.0391 10.08 21.5304 10.08 21V20.91C10.0723 20.579 9.96512 20.258 9.77251 19.9887C9.5799 19.7194 9.31074 19.5143 9 19.4C8.69838 19.2669 8.36381 19.2272 8.03941 19.286C7.71502 19.3448 7.41568 19.4995 7.18 19.73L7.12 19.79C6.93425 19.976 6.71368 20.1235 6.47088 20.2241C6.22808 20.3248 5.96783 20.3766 5.705 20.3766C5.44217 20.3766 5.18192 20.3248 4.93912 20.2241C4.69632 20.1235 4.47575 19.976 4.29 19.79C4.10405 19.6043 3.95653 19.3837 3.85588 19.1409C3.75523 18.8981 3.70343 18.6378 3.70343 18.375C3.70343 18.1122 3.75523 17.8519 3.85588 17.6091C3.95653 17.3663 4.10405 17.1457 4.29 16.96L4.35 16.9C4.58054 16.6643 4.73519 16.365 4.794 16.0406C4.85282 15.7162 4.81312 15.3816 4.68 15.08C4.55324 14.7842 4.34276 14.532 4.07447 14.3543C3.80618 14.1766 3.49179 14.0813 3.17 14.08H3C2.46957 14.08 1.96086 13.8693 1.58579 13.4942C1.21071 13.1191 1 12.6104 1 12.08C1 11.5496 1.21071 11.0409 1.58579 10.6658C1.96086 10.2907 2.46957 10.08 3 10.08H3.09C3.42099 10.0723 3.742 9.96512 4.0113 9.77251C4.28059 9.5799 4.48572 9.31074 4.6 9C4.73312 8.69838 4.77282 8.36381 4.714 8.03941C4.65519 7.71502 4.50054 7.41568 4.27 7.18L4.21 7.12C4.02405 6.93425 3.87653 6.71368 3.77588 6.47088C3.67523 6.22808 3.62343 5.96783 3.62343 5.705C3.62343 5.44217 3.67523 5.18192 3.77588 4.93912C3.87653 4.69632 4.02405 4.47575 4.21 4.29C4.39575 4.10405 4.61632 3.95653 4.85912 3.85588C5.10192 3.75523 5.36217 3.70343 5.625 3.70343C5.88783 3.70343 6.14808 3.75523 6.39088 3.85588C6.63368 3.95653 6.85425 4.10405 7.04 4.29L7.1 4.35C7.33568 4.58054 7.63502 4.73519 7.95941 4.794C8.28381 4.85282 8.61838 4.81312 8.92 4.68H9C9.29577 4.55324 9.54802 4.34276 9.72569 4.07447C9.90337 3.80618 9.99872 3.49179 10 3.17V3C10 2.46957 10.2107 1.96086 10.5858 1.58579C10.9609 1.21071 11.4696 1 12 1C12.5304 1 13.0391 1.21071 13.4142 1.58579C13.7893 1.96086 14 2.46957 14 3V3.09C14.0013 3.41179 14.0966 3.72618 14.2743 3.99447C14.452 4.26276 14.7042 4.47324 15 4.6C15.3016 4.73312 15.6362 4.77282 15.9606 4.714C16.285 4.65519 16.5843 4.50054 16.82 4.27L16.88 4.21C17.0657 4.02405 17.2863 3.87653 17.5291 3.77588C17.7719 3.67523 18.0322 3.62343 18.295 3.62343C18.5578 3.62343 18.8181 3.67523 19.0609 3.77588C19.3037 3.87653 19.5243 4.02405 19.71 4.21C19.896 4.39575 20.0435 4.61632 20.1441 4.85912C20.2448 5.10192 20.2966 5.36217 20.2966 5.625C20.2966 5.88783 20.2448 6.14808 20.1441 6.39088C20.0435 6.63368 19.896 6.85425 19.71 7.04L19.65 7.1C19.4195 7.33568 19.2648 7.63502 19.206 7.95941C19.1472 8.28381 19.1869 8.61838 19.32 8.92V9C19.4468 9.29577 19.6572 9.54802 19.9255 9.72569C20.1938 9.90337 20.5082 9.99872 20.83 10H21C21.5304 10 22.0391 10.2107 22.4142 10.5858C22.7893 10.9609 23 11.4696 23 12C23 12.5304 22.7893 13.0391 22.4142 13.4142C22.0391 13.7893 21.5304 14 21 14H20.91C20.5882 14.0013 20.2738 14.0966 20.0055 14.2743C19.7372 14.452 19.5268 14.7042 19.4 15Z" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
    </svg>
);

const FlintLogo: React.FC = () => (
    <svg width="16" height="16" viewBox="0 0 24 24" fill="currentColor">
        <path
            d="M12 2C8.5 6 8 10 8 12c0 3.5 1.5 6 4 8 2.5-2 4-4.5 4-8 0-2-.5-6-4-10z"
        />
        <path
            d="M12 5c-2 3-2.5 5.5-2.5 7 0 2 .8 3.5 2.5 5 1.7-1.5 2.5-3 2.5-5 0-1.5-.5-4-2.5-7z"
            fill="var(--bg-primary)"
        />
        <path
            d="M12 8c-1 1.5-1.5 3-1.5 4 0 1.2.5 2.2 1.5 3 1-.8 1.5-1.8 1.5-3 0-1-.5-2.5-1.5-4z"
        />
    </svg>
);

interface TabProps {
    tab: ProjectTab;
    isActive: boolean;
    onSwitch: () => void;
    onClose: (e: React.MouseEvent) => void;
}

/** Matches the CSS .titlebar__tab--closing keyframe duration so the close
 *  animation has time to play before the tab unmounts. */
const TAB_CLOSE_MS = 180;

const Tab: React.FC<TabProps> = ({ tab, isActive, onSwitch, onClose }) => {
    const [closing, setClosing] = useState(false);

    const triggerClose = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (closing) return;
        setClosing(true);
        setTimeout(() => onClose(e), TAB_CLOSE_MS);
    }, [onClose, closing]);

    const handleMiddleClick = useCallback((e: React.MouseEvent) => {
        if (e.button === 1) {
            e.preventDefault();
            triggerClose(e);
        }
    }, [triggerClose]);

    const projectName = tab.project.display_name || tab.project.name;

    return (
        <div
            className={`titlebar__tab ${isActive ? 'titlebar__tab--active' : ''}${closing ? ' titlebar__tab--closing' : ''}`}
            onClick={closing ? undefined : onSwitch}
            onMouseDown={handleMiddleClick}
            title={`${projectName}\n${tab.projectPath}`}
            data-tauri-drag-region="false"
            data-project-tab={tab.projectPath}
            data-project-name={projectName}
        >
            <span
                className="titlebar__tab-icon"
                dangerouslySetInnerHTML={{ __html: getIcon('folder') }}
            />
            <span className="titlebar__tab-name">
                {projectName}
            </span>
            <button
                className="titlebar__tab-close"
                onClick={triggerClose}
                title="Close Tab"
            >
                <svg viewBox="0 0 16 16" width="12" height="12">
                    <path
                        d="M4.5 4.5l7 7m0-7l-7 7"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        fill="none"
                    />
                </svg>
            </button>
        </div>
    );
};

interface ExtractTabProps {
    session: ExtractSession;
    isActive: boolean;
    onSwitch: () => void;
    onClose: (e: React.MouseEvent) => void;
}

const ExtractTab: React.FC<ExtractTabProps> = ({ session, isActive, onSwitch, onClose }) => {
    const [closing, setClosing] = useState(false);

    const triggerClose = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (closing) return;
        setClosing(true);
        setTimeout(() => onClose(e), TAB_CLOSE_MS);
    }, [onClose, closing]);

    const handleMiddleClick = useCallback((e: React.MouseEvent) => {
        if (e.button === 1) {
            e.preventDefault();
            triggerClose(e);
        }
    }, [triggerClose]);

    return (
        <div
            className={`titlebar__tab ${isActive ? 'titlebar__tab--active' : ''}${closing ? ' titlebar__tab--closing' : ''}`}
            onClick={closing ? undefined : onSwitch}
            onMouseDown={handleMiddleClick}
            title={session.wadPath}
            data-tauri-drag-region="false"
        >
            <span
                className="titlebar__tab-icon"
                dangerouslySetInnerHTML={{ __html: getIcon('wad') }}
            />
            <span className="titlebar__tab-name">{session.wadName}</span>
            {session.loading && (
                <span style={{ marginLeft: '4px', fontSize: '10px', opacity: 0.6 }}>···</span>
            )}
            <button
                className="titlebar__tab-close"
                onClick={triggerClose}
                title="Close Tab"
            >
                <svg viewBox="0 0 16 16" width="12" height="12">
                    <path
                        d="M4.5 4.5l7 7m0-7l-7 7"
                        stroke="currentColor"
                        strokeWidth="1.5"
                        strokeLinecap="round"
                        fill="none"
                    />
                </svg>
            </button>
        </div>
    );
};

interface ManifestTabProps {
    label: string;
    isActive: boolean;
    onSwitch: () => void;
    onClose: (e: React.MouseEvent) => void;
}

const ManifestTab: React.FC<ManifestTabProps> = ({ label, isActive, onSwitch, onClose }) => {
    const [closing, setClosing] = useState(false);
    const triggerClose = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (closing) return;
        setClosing(true);
        setTimeout(() => onClose(e), TAB_CLOSE_MS);
    }, [onClose, closing]);
    const handleMiddleClick = useCallback((e: React.MouseEvent) => {
        if (e.button === 1) { e.preventDefault(); triggerClose(e); }
    }, [triggerClose]);
    return (
        <div
            className={`titlebar__tab ${isActive ? 'titlebar__tab--active' : ''}${closing ? ' titlebar__tab--closing' : ''}`}
            onClick={closing ? undefined : onSwitch}
            onMouseDown={handleMiddleClick}
            title={`CDN manifest: ${label}`}
            data-tauri-drag-region="false"
        >
            <span className="titlebar__tab-icon" dangerouslySetInnerHTML={{ __html: getIcon('package') }} />
            <span className="titlebar__tab-name">{label}</span>
            <button className="titlebar__tab-close" onClick={triggerClose} title="Close Tab">
                <svg viewBox="0 0 16 16" width="12" height="12">
                    <path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
                </svg>
            </button>
        </div>
    );
};

interface ArchiveTabProps {
    tab: ArchiveTabModel;
    isActive: boolean;
    onSwitch: () => void;
    onClose: (e: React.MouseEvent) => void;
}

const ArchiveTab: React.FC<ArchiveTabProps> = ({ tab, isActive, onSwitch, onClose }) => {
    const [closing, setClosing] = useState(false);

    const triggerClose = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        if (closing) return;
        setClosing(true);
        setTimeout(() => onClose(e), TAB_CLOSE_MS);
    }, [onClose, closing]);

    const handleMiddleClick = useCallback((e: React.MouseEvent) => {
        if (e.button === 1) {
            e.preventDefault();
            triggerClose(e);
        }
    }, [triggerClose]);

    return (
        <div
            className={`titlebar__tab ${isActive ? 'titlebar__tab--active' : ''}${closing ? ' titlebar__tab--closing' : ''}`}
            onClick={closing ? undefined : onSwitch}
            onMouseDown={handleMiddleClick}
            title={`${tab.kind.toUpperCase()} archive: ${tab.filePath}`}
            data-tauri-drag-region="false"
        >
            <span className="titlebar__tab-icon" dangerouslySetInnerHTML={{ __html: getIcon('package') }} />
            <span className="titlebar__tab-name">
                {tab.name}
                {tab.isDirty && <span style={{ color: 'var(--accent-primary)', marginLeft: 3 }}>●</span>}
            </span>
            <button className="titlebar__tab-close" onClick={triggerClose} title="Close Tab">
                <svg viewBox="0 0 16 16" width="12" height="12">
                    <path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
                </svg>
            </button>
        </div>
    );
};

/** Text-button styling for the map PSD actions (titlebar__button is icon-sized). */
const psdBtnStyle = (disabled: boolean): React.CSSProperties => ({
    height: 26,
    padding: '0 10px',
    marginRight: 6,
    display: 'inline-flex',
    alignItems: 'center',
    whiteSpace: 'nowrap',
    fontSize: 12,
    borderRadius: 6,
    border: '1px solid var(--border, #444)',
    background: 'var(--bg-secondary, #2a2a2a)',
    color: disabled ? 'var(--text-muted, #888)' : 'var(--text-primary, #ddd)',
    cursor: disabled ? 'default' : 'pointer',
    opacity: disabled ? 0.6 : 1,
});

export const TitleBar: React.FC = () => {
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const extractSessions = useWadExtractStore((s) => s.extractSessions);
    const activeExtractId = useWadExtractStore((s) => s.activeExtractId);
    const cdnSessions = useCdnManifestStore((s) => s.sessions);
    const activeManifestId = useNavigationStore((s) => s.activeManifestId);
    const openArchiveTabs = useArchiveTabStore((s) => s.openArchiveTabs);
    const activeArchiveTabId = useArchiveTabStore((s) => s.activeArchiveTabId);
    const wadExplorerOpen = useWadExplorerStore((s) => s.isOpen);
    const currentView = useNavigationStore((s) => s.currentView);
    const leaguePath = useConfigStore((s) => s.leaguePath);
    const ltkManagerModPath = useConfigStore((s) => s.ltkManagerModPath);
    const celestialModPath = useConfigStore((s) => s.celestialModPath);
    const preferredLauncher = useConfigStore((s) => s.preferredLauncher);
    const creatorName = useConfigStore((s) => s.creatorName);
    const openModal = useModalStore((s) => s.openModal);
    const showToast = useNotificationStore((s) => s.showToast);

    const [dropdownOpen, setDropdownOpen] = useState(false);
    const [isExporting, setIsExporting] = useState(false);
    const [isSyncing, setIsSyncing] = useState(false);
    const [isRebuildingLoadscreen, setIsRebuildingLoadscreen] = useState(false);
    const [closingWindow, setClosingWindow] = useState(false);
    const [wadExplorerClosing, setWadExplorerClosing] = useState(false);

    const activeTab = useMemo(() => {
        if (!activeTabId) return null;
        return openTabs.find(t => t.id === activeTabId) || null;
    }, [activeTabId, openTabs]);

    const currentProject = activeTab?.project || null;
    const currentProjectPath = activeTab?.projectPath || null;

    const handleMinimize = async () => {
        try {
            await getCurrentWindow().minimize();
        } catch (err) {
            console.error('Failed to minimize window:', err);
        }
    };

    const handleMaximize = async () => {
        try {
            await getCurrentWindow().toggleMaximize();
        } catch (err) {
            console.error('Failed to maximize window:', err);
        }
    };

    const handleClose = async () => {
        setClosingWindow(true);
        await new Promise((r) => setTimeout(r, 160));
        try {
            await getCurrentWindow().close();
        } catch (err) {
            console.error('Failed to close window:', err);
            setClosingWindow(false);
        }
    };

    const handleSettings = () => {
        openModal('settings');
    };

    const toggleDropdown = useCallback((e: React.MouseEvent) => {
        e.stopPropagation();
        setDropdownOpen(prev => !prev);
    }, []);

    const launcherTarget = useMemo<{ name: string; path: string; kind: 'ltk' | 'celestial' } | null>(() => {
        if (preferredLauncher === 'celestial' && celestialModPath) return { name: 'Celestial', path: celestialModPath, kind: 'celestial' };
        if (preferredLauncher === 'ltk' && ltkManagerModPath) return { name: 'LTK Manager', path: ltkManagerModPath, kind: 'ltk' };
        if (celestialModPath) return { name: 'Celestial', path: celestialModPath, kind: 'celestial' };
        if (ltkManagerModPath) return { name: 'LTK Manager', path: ltkManagerModPath, kind: 'ltk' };
        return null;
    }, [preferredLauncher, ltkManagerModPath, celestialModPath]);

    const handleSyncToLauncher = useCallback(async () => {
        if (!currentProjectPath || !currentProject) return;
        if (!launcherTarget) {
            showToast('error', 'No launcher configured. Set one in Settings.');
            return;
        }

        setIsSyncing(true);

        try {
            if (launcherTarget.kind === 'celestial') {
                await api.syncProjectToCelestial(currentProjectPath);
                showToast('success', 'Sent to Celestial — check its Creator Hub.');
            } else {
                const modId = await api.syncProjectToLauncher(currentProjectPath, launcherTarget.path);
                showToast('success', `Synced to ${launcherTarget.name}! Mod ID: ${modId}`);
            }

            api.createCheckpoint(currentProjectPath, `Auto-checkpoint: Synced to ${launcherTarget.name}`).catch(e => {
                console.warn('Auto-checkpoint failed:', e);
            });

        } catch (err) {
            console.error('Sync to launcher failed:', err);
            const flintError = err as api.FlintError;
            showToast('error', flintError.getUserMessage?.() || `Failed to sync to ${launcherTarget.name}`);
        } finally {
            setIsSyncing(false);
        }
    }, [currentProject, currentProjectPath, launcherTarget, showToast]);

    const handleRebuildLoadscreen = useCallback(async () => {
        if (!currentProjectPath) return;
        if (!leaguePath) {
            showToast('error', 'League path is not configured. Set it in Settings.');
            return;
        }
        setIsRebuildingLoadscreen(true);
        try {
            await api.rebuildLoadingScreenBin(currentProjectPath, leaguePath);
            showToast('success', 'Loadscreen rebuilt from the live game uibase.');
        } catch (err) {
            const flintError = err as api.FlintError;
            showToast('error', flintError.getUserMessage?.() || 'Failed to rebuild loadscreen');
        } finally {
            setIsRebuildingLoadscreen(false);
        }
    }, [currentProjectPath, leaguePath, showToast]);

    const handleExportAs = useCallback(async (format: 'fantome' | 'modpkg') => {
        setDropdownOpen(false);

        if (!currentProjectPath || !currentProject) return;

        const ext = format;
        const projectName = currentProject?.display_name || currentProject?.name || 'mod';

        const outputPath = await save({
            title: `Export as .${ext}`,
            defaultPath: `${projectName}.${ext}`,
            filters: [{ name: `${ext.toUpperCase()} Package`, extensions: [ext] }],
        });

        if (!outputPath) return;

        setIsExporting(true);

        try {
            const result = await api.exportProject({
                projectPath: currentProjectPath,
                outputPath,
                format,
                champion: sanitizeChampionName(currentProject.champion),
                metadata: {
                    name: currentProject.name,
                    author: currentProject.creator || creatorName || 'Unknown',
                    version: currentProject.version || '1.0.0',
                    description: currentProject.description || '',
                },
            });

            showToast('success', `Exported to ${result.path}`);

            api.createCheckpoint(currentProjectPath, `Auto-checkpoint: Exported to ${format}`).catch(e => {
                console.warn('Auto-checkpoint failed:', e);
            });

        } catch (err) {
            console.error('Export failed:', err);
            const flintError = err as api.FlintError;
            showToast('error', flintError.getUserMessage?.() || 'Export failed');
        } finally {
            setIsExporting(false);
        }
    }, [currentProject, currentProjectPath, creatorName, showToast]);


    useEffect(() => {
        if (!dropdownOpen) return;

        const handleClickOutside = () => setDropdownOpen(false);
        document.addEventListener('click', handleClickOutside);
        return () => document.removeEventListener('click', handleClickOutside);
    }, [dropdownOpen]);

    const handleSwitchTab = useCallback((tabId: string) => {
        useProjectTabStore.getState().switchTab(tabId);
        useNavigationStore.getState().setView('preview');
    }, []);

    const handleCloseTab = useCallback((e: React.MouseEvent, tabId: string) => {
        e.stopPropagation();
        navigationCoordinator.removeTabWithFallback(tabId);
    }, []);

    const handleSwitchExtract = useCallback((sessionId: string) => {
        useWadExtractStore.getState().switchSession(sessionId);
        useNavigationStore.getState().setView('extract');
    }, []);

    const handleCloseExtract = useCallback((e: React.MouseEvent, sessionId: string) => {
        e.stopPropagation();
        navigationCoordinator.closeExtractSessionWithFallback(sessionId);
    }, []);

    const handleSwitchManifest = useCallback((sessionId: string) => {
        useNavigationStore.getState().setActiveManifest(sessionId);
        useNavigationStore.getState().setView('manifest');
    }, []);

    const handleCloseManifest = useCallback((e: React.MouseEvent, sessionId: string) => {
        e.stopPropagation();
        const nav = useNavigationStore.getState();
        const cdn = useCdnManifestStore.getState();
        api.cdnCloseSession(sessionId).catch(() => {});
        cdn.removeSession(sessionId);
        // Fall back to another manifest, else leave the manifest view.
        const remaining = Object.keys(cdn.sessions).filter((id) => id !== sessionId);
        if (nav.activeManifestId === sessionId) {
            if (remaining.length > 0) {
                nav.setActiveManifest(remaining[0]);
            } else {
                nav.setActiveManifest(null);
                nav.setView('welcome');
            }
        }
    }, []);

    const handleSwitchArchive = useCallback((tabId: string) => {
        useArchiveTabStore.getState().switchArchiveTab(tabId);
        useNavigationStore.getState().setView('archive-editor');
    }, []);

    const handleCloseArchive = useCallback((e: React.MouseEvent, tabId: string) => {
        e.stopPropagation();
        navigationCoordinator.closeArchiveTabWithFallback(tabId);
    }, []);

    const fileEditorTabs = useFileEditorStore((s) => s.tabs);
    const fileEditorActiveId = useFileEditorStore((s) => s.activeId);
    const openConfirmDialog = useModalStore((s) => s.openConfirmDialog);

    const isWadExplorerOpen = wadExplorerOpen;
    const isWadExplorerActive = currentView === 'wad-explorer';
    const isProjectActive = currentView === 'preview';
    const isExtractActive = currentView === 'extract';
    const isFileEditorActive = currentView === 'file-editor';
    const isManifestActive = currentView === 'manifest';
    const isArchiveActive = currentView === 'archive-editor';
    const manifestList = Object.values(cdnSessions);

    const handleSwitchFileEditor = useCallback((tabId: string) => {
        useFileEditorStore.getState().switchTab(tabId);
        useNavigationStore.getState().setView('file-editor');
    }, []);

    const handleCloseFileEditor = useCallback((e: React.MouseEvent, tabId: string) => {
        e.stopPropagation();
        const tab = useFileEditorStore.getState().tabs.find((t) => t.id === tabId);
        const doClose = () => navigationCoordinator.closeFileEditorTabWithFallback(tabId);
        if (tab?.dirty) {
            openConfirmDialog({
                title: 'Discard changes?',
                message: 'You have unsaved changes. Are you sure you want to discard them?',
                confirmLabel: 'Discard',
                danger: true,
                onConfirm: doClose,
            });
        } else {
            doClose();
        }
    }, [openConfirmDialog]);

    const hasTabs = openTabs.length > 0 || extractSessions.length > 0 || manifestList.length > 0 || openArchiveTabs.length > 0 || isWadExplorerOpen || fileEditorTabs.length > 0;

    return (
        <div className="titlebar" data-tauri-drag-region>
            <div className="titlebar__left" data-tauri-drag-region>
                <div
                    className="titlebar__logo"
                    onClick={() => useNavigationStore.getState().setView('welcome')}
                    style={{ cursor: 'pointer' }}
                    title="Go to Home"
                    data-tauri-drag-region="false"
                >
                    <FlintLogo />
                    <span className="titlebar__app-name">Flint</span>
                </div>
            </div>

            <div className="titlebar__center" data-tauri-drag-region>
                {hasTabs && (
                    <div className="titlebar__tabs">
                        {isWadExplorerOpen && (
                            <div
                                className={`titlebar__tab ${isWadExplorerActive ? 'titlebar__tab--active' : ''}${wadExplorerClosing ? ' titlebar__tab--closing' : ''}`}
                                onClick={wadExplorerClosing ? undefined : () => navigationCoordinator.openWadExplorer()}
                                title="WAD Explorer — unified game asset browser"
                                data-tauri-drag-region="false"
                            >
                                <span
                                    className="titlebar__tab-icon"
                                    dangerouslySetInnerHTML={{ __html: getIcon('wad') }}
                                />
                                <span className="titlebar__tab-name">WAD Explorer</span>
                                <button
                                    className="titlebar__tab-close"
                                    onClick={e => {
                                        e.stopPropagation();
                                        if (wadExplorerClosing) return;
                                        setWadExplorerClosing(true);
                                        setTimeout(() => {
                                            navigationCoordinator.closeWadExplorerWithFallback();
                                            setWadExplorerClosing(false);
                                        }, 180);
                                    }}
                                    title="Close WAD Explorer"
                                >
                                    <svg viewBox="0 0 16 16" width="12" height="12">
                                        <path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
                                    </svg>
                                </button>
                            </div>
                        )}

                        {fileEditorTabs.map((tab) => (
                            <div
                                key={tab.id}
                                className={`titlebar__tab ${tab.id === fileEditorActiveId && isFileEditorActive ? 'titlebar__tab--active' : ''}`}
                                onClick={() => handleSwitchFileEditor(tab.id)}
                                onMouseDown={(e) => { if (e.button === 1) handleCloseFileEditor(e, tab.id); }}
                                title={tab.target.filePath}
                                data-tauri-drag-region="false"
                            >
                                <span className="titlebar__tab-icon" dangerouslySetInnerHTML={{ __html: getIcon('bin') }} />
                                <span className="titlebar__tab-name">
                                    {tab.target.filePath.split(/[/\\]/).pop()}
                                    {tab.dirty && <span style={{ color: 'var(--accent-primary)', marginLeft: 3 }}>●</span>}
                                </span>
                                <button
                                    className="titlebar__tab-close"
                                    onClick={(e) => handleCloseFileEditor(e, tab.id)}
                                    title="Close file"
                                >
                                    <svg viewBox="0 0 16 16" width="12" height="12">
                                        <path d="M4.5 4.5l7 7m0-7l-7 7" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" fill="none" />
                                    </svg>
                                </button>
                            </div>
                        ))}

                        {openTabs.map(tab => (
                            <Tab
                                key={tab.id}
                                tab={tab}
                                isActive={tab.id === activeTabId && isProjectActive}
                                onSwitch={() => handleSwitchTab(tab.id)}
                                onClose={(e) => handleCloseTab(e, tab.id)}
                            />
                        ))}
                        {extractSessions.map(session => (
                            <ExtractTab
                                key={session.id}
                                session={session}
                                isActive={session.id === activeExtractId && isExtractActive}
                                onSwitch={() => handleSwitchExtract(session.id)}
                                onClose={(e) => handleCloseExtract(e, session.id)}
                            />
                        ))}
                        {manifestList.map(s => (
                            <ManifestTab
                                key={s.sessionId}
                                label={s.label}
                                isActive={s.sessionId === activeManifestId && isManifestActive}
                                onSwitch={() => handleSwitchManifest(s.sessionId)}
                                onClose={(e) => handleCloseManifest(e, s.sessionId)}
                            />
                        ))}
                        {openArchiveTabs.map(tab => (
                            <ArchiveTab
                                key={tab.id}
                                tab={tab}
                                isActive={tab.id === activeArchiveTabId && isArchiveActive}
                                onSwitch={() => handleSwitchArchive(tab.id)}
                                onClose={(e) => handleCloseArchive(e, tab.id)}
                            />
                        ))}
                    </div>
                )}
            </div>

            <div className="titlebar__controls" data-tauri-drag-region="false">
                {currentView === 'preview' && currentProject?.kind === 'map' && (
                    <button
                        style={psdBtnStyle(false)}
                        onClick={() => openModal('map-textures')}
                        title="Combine / apply map texture PSDs (ground, walls, camps, …)"
                        data-tauri-drag-region="false"
                    >Map Textures</button>
                )}

                {currentView === 'preview' && currentProject?.kind === 'loading-screen' && (
                    <button
                        style={psdBtnStyle(isRebuildingLoadscreen)}
                        onClick={handleRebuildLoadscreen}
                        disabled={isRebuildingLoadscreen}
                        title="Re-extract the current game's uibase and re-inject the animation config — no need to redo the spritesheet after a patch"
                        data-tauri-drag-region="false"
                    >{isRebuildingLoadscreen ? 'Rebuilding…' : 'Rebuild'}</button>
                )}

                {currentView === 'preview' && currentProject && launcherTarget && (
                    <button
                        className="titlebar__button titlebar__button--sync"
                        onClick={handleSyncToLauncher}
                        disabled={isSyncing}
                        title={`Sync to ${launcherTarget.name}`}
                        data-tauri-drag-region="false"
                    >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path d="M13.65 2.35A7 7 0 1014.25 8h-1.5a5.5 5.5 0 11-1.1-3.4l1.1 1.1.9-2.35z" fill="currentColor"/>
                        </svg>
                    </button>
                )}

                {currentView === 'preview' && currentProject && (
                    <button
                        className="titlebar__button titlebar__button--timeline"
                        onClick={() => openModal('checkpoint')}
                        title="Project Timeline"
                        data-tauri-drag-region="false"
                    >
                        <svg width="14" height="14" viewBox="0 0 16 16" fill="none">
                            <path d="M8 1.5a6.5 6.5 0 106.5 6.5H13a5 5 0 11-5-5V4l3-3-3-3v2.5z" fill="currentColor"/>
                        </svg>
                    </button>
                )}

                {currentView === 'preview' && currentProject && (
                    <div className="titlebar__dropdown" style={{ position: 'relative', display: 'inline-block' }}>
                        <button
                            className="titlebar__button titlebar__button--export"
                            onClick={toggleDropdown}
                            disabled={isExporting}
                            title="Export Mod"
                            data-tauri-drag-region="false"
                        >
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none">
                                <path d="M21 15v4a2 2 0 0 1-2 2H5a2 2 0 0 1-2-2v-4M7 10l5 5 5-5M12 15V3" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                        </button>
                        {dropdownOpen && (
                            <div className="titlebar__dropdown-menu" style={{
                                position: 'absolute',
                                right: 0,
                                top: '100%',
                                marginTop: '4px',
                                background: 'var(--bg-secondary)',
                                border: '1px solid var(--border)',
                                borderRadius: '4px',
                                padding: '4px',
                                minWidth: '180px',
                                zIndex: 1000,
                                boxShadow: '0 4px 12px rgba(0,0,0,0.3)'
                            }}>
                                <button
                                    onClick={() => handleExportAs('fantome')}
                                    style={{
                                        width: '100%',
                                        padding: '8px 12px',
                                        background: 'transparent',
                                        border: 'none',
                                        color: 'var(--text-primary)',
                                        textAlign: 'left',
                                        cursor: 'pointer',
                                        borderRadius: '2px',
                                        fontSize: '13px'
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
                                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                >
                                    Export as .fantome
                                </button>
                                <button
                                    onClick={() => handleExportAs('modpkg')}
                                    style={{
                                        width: '100%',
                                        padding: '8px 12px',
                                        background: 'transparent',
                                        border: 'none',
                                        color: 'var(--text-primary)',
                                        textAlign: 'left',
                                        cursor: 'pointer',
                                        borderRadius: '2px',
                                        fontSize: '13px'
                                    }}
                                    onMouseEnter={(e) => e.currentTarget.style.background = 'var(--bg-hover)'}
                                    onMouseLeave={(e) => e.currentTarget.style.background = 'transparent'}
                                >
                                    Export as .modpkg
                                </button>
                            </div>
                        )}
                    </div>
                )}

                <button
                    className="titlebar__button titlebar__button--skinfixer"
                    onClick={() => openModal('skinFixer')}
                    title="Skin Fixer — detect & fix broken skins"
                    data-tauri-drag-region="false"
                >
                    <svg width="15" height="15" viewBox="0 0 24 24" fill="none">
                        <path d="M14.7 6.3a4 4 0 00-5.2 5.2l-5.6 5.6a1.6 1.6 0 002.3 2.3l5.6-5.6a4 4 0 005.2-5.2l-2.7 2.7-2-.5-.5-2 2.6-2.5z" stroke="currentColor" strokeWidth="1.6" strokeLinejoin="round"/>
                    </svg>
                </button>

                <button
                    className="titlebar__button titlebar__button--settings"
                    onClick={handleSettings}
                    title="Settings"
                    data-tauri-drag-region="false"
                >
                    <SettingsIcon />
                </button>
                <button
                    className="titlebar__button"
                    onClick={handleMinimize}
                    title="Minimize"
                    data-tauri-drag-region="false"
                >
                    <MinimizeIcon />
                </button>
                <button
                    className="titlebar__button"
                    onClick={handleMaximize}
                    title="Maximize"
                    data-tauri-drag-region="false"
                >
                    <MaximizeIcon />
                </button>
                <button
                    className={`titlebar__button titlebar__button--close${closingWindow ? ' titlebar__button--closing' : ''}`}
                    onClick={handleClose}
                    title="Close"
                    data-tauri-drag-region="false"
                    disabled={closingWindow}
                >
                    <CloseIcon />
                </button>
            </div>
        </div>
    );
};
