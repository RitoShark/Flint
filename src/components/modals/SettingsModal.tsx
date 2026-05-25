/**
 * Flint - Settings Modal Component
 * Left sidebar navigation + content panels.
 */

import React, { useState, useEffect } from 'react';
import { useAppState, useConfigStore, useUxStore } from '../../lib/stores';
import * as api from '../../lib/api';
import type { FileAssocStatus } from '../../lib/api';
import * as updater from '../../lib/util/updater';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import {
    Button,
    Checkbox,
    Icon,
    type IconName,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    DesignLab,
} from '../ui';
import { triggerTutorialReplay } from '../overlays/TutorialOverlay';

type SettingsTab = 'creator' | 'general' | 'theme' | 'paths' | 'integrations' | 'dev';

// Extracted tab content - see ./settings/ for implementations.
import { PathSettingItem, type PathSetting } from './settings/PathSettingItem';
import { SchemaProgressView, SchemaResultView, type SchemaProgress } from './settings/SchemaViews';
import { ThemePresetGrid } from './settings/ThemeTab';
import { CreatorTab } from './settings/CreatorTab';
import { IntegrationsTab } from './settings/IntegrationsTab';

export const SettingsModal: React.FC = () => {
    const { state, dispatch, closeModal, showToast } = useAppState();
    const configStore = useConfigStore();
    const ux = useUxStore();

    const [activeTab, setActiveTab] = useState<SettingsTab>('creator');

    const [leaguePath, setLeaguePath] = useState(state.leaguePath || '');
    const [leaguePathPbe, setLeaguePathPbe] = useState(state.leaguePathPbe || '');
    const [defaultProjectPath, setDefaultProjectPath] = useState(state.defaultProjectPath || '');
    const [creatorName, setCreatorName] = useState(state.creatorName || '');
    const [creatorDescription, setCreatorDescription] = useState(state.creatorDescription || '');
    const [creatorHome, setCreatorHome] = useState(state.creatorHome || '');
    const [creatorTip, setCreatorTip] = useState(state.creatorTip || '');
    const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(state.autoUpdateEnabled);
    const [verboseLogging, setVerboseLogging] = useState(state.verboseLogging);
    const [ltkManagerModPath, setLtkManagerModPath] = useState(state.ltkManagerModPath || '');
    const [autoSyncToLauncher, setAutoSyncToLauncher] = useState(state.autoSyncToLauncher);
    const [celestialPath, setCelestialPath] = useState(state.celestialModPath || '');
    const [preferredLauncher, setPreferredLauncher] = useState<'ltk' | 'celestial' | null>(state.preferredLauncher);
    // BIN engine is pinned to Jade — no UI selector; configStore default handles it.
    const [jadePath, setJadePath] = useState(configStore.jadePath || '');
    const [quartzPath, setQuartzPath] = useState(configStore.quartzPath || '');
    const [isValidating, setIsValidating] = useState(false);

    // File-association status (Windows registry Open With)
    const [assocStatus, setAssocStatus] = useState<FileAssocStatus | null>(null);
    const [isRegisteringAssoc, setIsRegisteringAssoc] = useState(false);

    const [currentVersion, setCurrentVersion] = useState<string>('');
    const [latestVersion, setLatestVersion] = useState<string | null>(null);
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [updateAvailable, setUpdateAvailable] = useState(false);

    const [isRebuildingHashes, setIsRebuildingHashes] = useState(false);

    const [isAggregating, setIsAggregating] = useState(false);
    const [schemaProgress, setSchemaProgress] = useState<SchemaProgress | null>(null);
    const [schemaResult, setSchemaResult] = useState<api.SchemaStats | null>(null);

    const [isAggregatingChampion, setIsAggregatingChampion] = useState(false);
    const [championSchemaProgress, setChampionSchemaProgress] = useState<SchemaProgress | null>(null);
    const [championSchemaResult, setChampionSchemaResult] = useState<api.ChampionSchemaStats | null>(null);

    const [showUIPreview, setShowUIPreview] = useState(false);

    const isVisible = state.activeModal === 'settings';

    useEffect(() => {
        if (!isVisible) return;
        setLeaguePath(state.leaguePath || '');
        setLeaguePathPbe(state.leaguePathPbe || '');
        setDefaultProjectPath(state.defaultProjectPath || '');
        setCreatorName(state.creatorName || '');
        setCreatorDescription(state.creatorDescription || '');
        setCreatorHome(state.creatorHome || '');
        setCreatorTip(state.creatorTip || '');
        setAutoUpdateEnabled(state.autoUpdateEnabled);
        setVerboseLogging(state.verboseLogging);
        setLtkManagerModPath(state.ltkManagerModPath || '');
        setAutoSyncToLauncher(state.autoSyncToLauncher);
        setCelestialPath(state.celestialModPath || '');
        setPreferredLauncher(state.preferredLauncher);
        // binConverterEngine no longer user-controlled — pinned to 'jade'.
        setJadePath(configStore.jadePath || '');
        setQuartzPath(configStore.quartzPath || '');
        getVersion().then(setCurrentVersion).catch(() => setCurrentVersion('0.0.0'));
        // Refresh file-association status when settings modal opens
        api.getFileAssociationStatus().then(setAssocStatus).catch(() => {});
    }, [isVisible, state.leaguePath, state.leaguePathPbe, state.defaultProjectPath, state.creatorName, state.creatorDescription, state.creatorHome, state.creatorTip, state.autoUpdateEnabled, state.verboseLogging, state.ltkManagerModPath, state.autoSyncToLauncher, configStore.jadePath, configStore.quartzPath, configStore.selectedTheme]);

    useEffect(() => {
        const unlisten = listen<SchemaProgress>('schema-progress', (event) => {
            setSchemaProgress(event.payload);
        });
        return () => { unlisten.then((fn) => fn()); };
    }, []);

    useEffect(() => {
        const unlisten = listen<SchemaProgress>('champion-schema-progress', (event) => {
            setChampionSchemaProgress(event.payload);
        });
        return () => { unlisten.then((fn) => fn()); };
    }, []);

    const handleDetectLeague = async () => {
        setIsValidating(true);
        try {
            const result = await api.detectLeague();
            if (result.path) {
                setLeaguePath(result.path);
                showToast('success', 'League installation detected!');
            }
        } catch {
            showToast('error', 'Could not auto-detect League installation');
        } finally {
            setIsValidating(false);
        }
    };

    const handleDetectPbe = async () => {
        const basePath = leaguePath || state.leaguePath;
        if (basePath) {
            const parent = basePath.replace(/[\\/][^\\/]+$/, '');
            const pbeCandidates = [
                `${parent}\\League of Legends (PBE)`,
                `${parent}\\League of Legends(PBE)`,
                basePath + ' (PBE)',
            ];
            for (const candidate of pbeCandidates) {
                try {
                    const result = await api.validateLeague(candidate);
                    if (result.valid) {
                        setLeaguePathPbe(candidate);
                        showToast('success', 'PBE installation detected!');
                        return;
                    }
                } catch { /* continue */ }
            }
        }
        showToast('error', 'Could not auto-detect PBE installation');
    };

    const handleDetectLtkManager = async () => {
        setIsValidating(true);
        try {
            const path = await api.getLtkManagerModPath();
            if (path) {
                setLtkManagerModPath(path);
                showToast('success', 'LTK Manager installation detected!');
            } else {
                showToast('error', 'LTK Manager not found. Please install LTK Manager first.');
            }
        } catch {
            showToast('error', 'Failed to detect LTK Manager installation');
        } finally {
            setIsValidating(false);
        }
    };

    const handleDetectJade = async () => {
        setIsValidating(true);
        try {
            const path = await api.detectJadeInstallation();
            if (path) {
                setJadePath(path);
                showToast('success', 'Jade installation detected!');
            } else {
                showToast('error', 'Jade not found. Please install Jade League Bin Editor first.');
            }
        } catch {
            showToast('error', 'Failed to detect Jade installation');
        } finally {
            setIsValidating(false);
        }
    };

    const handleDetectQuartz = async () => {
        setIsValidating(true);
        try {
            const path = await api.detectQuartzInstallation();
            if (path) {
                setQuartzPath(path);
                showToast('success', 'Quartz installation detected!');
            } else {
                showToast('error', 'Quartz not found. Please install Quartz first.');
            }
        } catch {
            showToast('error', 'Failed to detect Quartz installation');
        } finally {
            setIsValidating(false);
        }
    };

    const handleDetectCelestial = async () => {
        setIsValidating(true);
        try {
            const path = await api.getCelestialModPath();
            if (path) {
                setCelestialPath(path);
                showToast('success', 'Celestial detected.');
            } else {
                showToast('error', 'Celestial not found in the usual AppData location.');
            }
        } catch {
            showToast('error', 'Failed to detect Celestial install');
        } finally {
            setIsValidating(false);
        }
    };

    const handleCheckForUpdates = async () => {
        setIsCheckingUpdate(true);
        setLatestVersion(null);
        setUpdateAvailable(false);
        try {
            const result = await updater.checkForUpdates();
            if (result.available && result.newVersion) {
                setLatestVersion(result.newVersion);
                setUpdateAvailable(true);
                showToast('success', `Update available: v${result.newVersion}`);
            } else {
                setLatestVersion(result.currentVersion);
                showToast('info', 'You are running the latest version');
            }
        } catch {
            showToast('error', 'Failed to check for updates');
        } finally {
            setIsCheckingUpdate(false);
        }
    };

    const handleUpdateNow = () => {
        if (!latestVersion) return;
        dispatch({
            type: 'OPEN_MODAL',
            payload: {
                modal: 'updateAvailable',
                options: {
                    available: true,
                    current_version: currentVersion,
                    latest_version: latestVersion,
                    release_notes: 'Check GitHub releases for details',
                    published_at: new Date().toISOString(),
                } as Record<string, unknown>,
            },
        });
    };

    const handleForceRebuildHashes = async () => {
        setIsRebuildingHashes(true);
        try {
            await api.forceRebuildHashes();
            if (state.wadExplorer.isOpen) {
                state.wadExplorer.wads.forEach((wad) => {
                    if (wad.status === 'loaded') {
                        dispatch({
                            type: 'SET_WAD_EXPLORER_WAD_STATUS',
                            payload: { wadPath: wad.path, status: 'idle', chunks: [], error: null },
                        });
                    }
                });
            }
            showToast('success', 'Hash database rebuilt - collapse/expand WADs to reload');
        } catch (error) {
            console.error('Failed to rebuild hash database:', error);
            showToast('error', 'Failed to rebuild hash database');
        } finally {
            setIsRebuildingHashes(false);
        }
    };

    const handleAggregateBinSchema = async () => {
        if (!state.leaguePath) {
            showToast('error', 'League path not configured. Set it in the Paths tab first.');
            return;
        }
        setIsAggregating(true);
        setSchemaProgress(null);
        setSchemaResult(null);
        try {
            const stats = await api.aggregateBinSchema(state.leaguePath);
            setSchemaResult(stats);
            showToast('success', `Schema aggregated: ${stats.classes_found.toLocaleString()} classes, ${stats.total_fields.toLocaleString()} fields`);
        } catch (error) {
            console.error('Schema aggregation failed:', error);
            showToast('error', 'Schema aggregation failed. Check the log for details.');
        } finally {
            setIsAggregating(false);
        }
    };

    const handleAggregateChampionSchema = async () => {
        if (!state.leaguePath) {
            showToast('error', 'League path not configured. Set it in the Paths tab first.');
            return;
        }
        setIsAggregatingChampion(true);
        setChampionSchemaProgress(null);
        setChampionSchemaResult(null);
        try {
            const stats = await api.aggregateChampionBinSchema(state.leaguePath);
            setChampionSchemaResult(stats);
            showToast('success', `Champion schema built: ${stats.classes_found.toLocaleString()} classes, ${stats.total_fields.toLocaleString()} fields`);
        } catch (error) {
            console.error('Champion schema aggregation failed:', error);
            showToast('error', 'Champion schema aggregation failed. Check the log for details.');
        } finally {
            setIsAggregatingChampion(false);
        }
    };

    const handleSave = async () => {
        if (leaguePath && leaguePath !== state.leaguePath) {
            setIsValidating(true);
            try {
                const result = await api.validateLeague(leaguePath);
                if (!result.valid) {
                    showToast('error', 'Invalid League of Legends path');
                    setIsValidating(false);
                    return;
                }
            } catch {
                showToast('error', 'Failed to validate League path');
                setIsValidating(false);
                return;
            }
            setIsValidating(false);
        }

        dispatch({
            type: 'SET_STATE',
            payload: {
                leaguePath: leaguePath || null,
                leaguePathPbe: leaguePathPbe || null,
                defaultProjectPath: defaultProjectPath || null,
                creatorName: creatorName || null,
                creatorDescription: creatorDescription.trim() || null,
                creatorHome: creatorHome.trim() || null,
                creatorTip: creatorTip.trim() || null,
                autoUpdateEnabled,
                verboseLogging,
                ltkManagerModPath: ltkManagerModPath || null,
                autoSyncToLauncher,
                celestialModPath: celestialPath || null,
                preferredLauncher,
            },
        });

        // BIN engine is pinned to 'jade' — no save needed.
        configStore.setJadePath(jadePath || null);
        configStore.setQuartzPath(quartzPath || null);
        // selectedTheme is committed live by the preset cards — no need to re-save here.

        api.setLogLevel(verboseLogging).catch(() => {});
        showToast('success', 'Settings saved');
        closeModal();
    };

    const tabs: { id: SettingsTab; label: string; icon: IconName }[] = [
        { id: 'creator', label: 'Creator', icon: 'user' },
        { id: 'general', label: 'General', icon: 'settings' },
        { id: 'theme', label: 'Theme', icon: 'picture' },
        { id: 'paths', label: 'Paths', icon: 'folder' },
        { id: 'integrations', label: 'Integrations', icon: 'link' },
        { id: 'dev', label: 'Dev', icon: 'code' },
    ];

    const pathSettings: PathSetting[] = [
        {
            label: 'Default Project Path',
            placeholder: 'Where new projects are created',
            value: defaultProjectPath,
            onChange: setDefaultProjectPath,
            browseTitle: 'Select Default Project Folder',
            iconName: 'folder',
            hint: 'Where new mod projects get scaffolded.',
        },
        {
            label: 'League of Legends',
            badge: 'Live',
            placeholder: 'C:\\Riot Games\\League of Legends',
            value: leaguePath,
            onChange: setLeaguePath,
            browseTitle: 'Select League of Legends Folder',
            onDetect: handleDetectLeague,
            detectLabel: 'Auto-detect',
            disabled: isValidating,
            logoSrc: '/lol-logo.png',
            logoColor: '#0AC8B9',
        },
        {
            label: 'League of Legends PBE',
            badge: 'PBE',
            placeholder: 'C:\\Riot Games\\League of Legends (PBE)',
            value: leaguePathPbe,
            onChange: setLeaguePathPbe,
            browseTitle: 'Select PBE Folder',
            onDetect: handleDetectPbe,
            detectLabel: 'Auto-detect PBE',
            disabled: isValidating,
            logoSrc: '/lol-logo.png',
            logoColor: '#F0884F',
        },
    ];

    type IntegrationId = 'ltk' | 'celestial' | 'jade' | 'quartz';
    interface Integration {
        id: IntegrationId;
        name: string;
        tagline: string;
        accent: string;
        path: string;
        setPath: (v: string) => void;
        onDetect: () => void;
        browseTitle: string;
        directory: boolean;
        helpUrl?: string;
        /** Marks the integration as a launcher target so the UI surfaces a
         *  "Set as default launcher" pill on it. */
        kind?: 'launcher' | 'app';
    }
    const integrations: Integration[] = [
        {
            id: 'ltk',
            name: 'LTK Manager',
            tagline: 'Open-source League toolkit launcher. One-click "Sync to Launcher" drops your mods into its library.',
            accent: '#22D3EE',
            path: ltkManagerModPath,
            setPath: setLtkManagerModPath,
            onDetect: handleDetectLtkManager,
            browseTitle: 'Select LTK Manager Mod Storage Folder',
            directory: true,
            helpUrl: 'https://github.com/LeagueToolkit/ltk-manager',
            kind: 'launcher',
        },
        {
            id: 'celestial',
            name: 'Celestial',
            tagline: "Divine Skins' all-in-one launcher. Detect or point Flint at its mod storage to sync from here.",
            accent: '#A05CF6',
            path: celestialPath,
            setPath: setCelestialPath,
            onDetect: handleDetectCelestial,
            browseTitle: 'Select Celestial Mod Storage Folder',
            directory: true,
            kind: 'launcher',
        },
        {
            id: 'jade',
            name: 'Jade',
            tagline: 'Rich text editor for Riot’s binary formats — opens BIN files with full hash resolution and a custom converter for edge cases LTK trips on.',
            accent: '#4ADE80',
            path: jadePath,
            setPath: setJadePath,
            onDetect: handleDetectJade,
            browseTitle: 'Select Jade Executable',
            directory: false,
            kind: 'app',
        },
        {
            id: 'quartz',
            name: 'Quartz',
            tagline: 'VFX recolor & port editor. Launches from the BIN preview when configured.',
            accent: '#F8FAFC',
            path: quartzPath,
            setPath: setQuartzPath,
            onDetect: handleDetectQuartz,
            browseTitle: 'Select Quartz Executable',
            directory: false,
            kind: 'app',
        },
    ];

    const handleIntegrationConnect = async (i: Integration) => {
        const selected = await open({ title: i.browseTitle, directory: i.directory });
        if (selected) i.setPath(selected as string);
    };

    return (
        <Modal open={isVisible} onClose={closeModal} modifier="modal--settings">
            <ModalHeader title="Settings" onClose={closeModal} />

            <div className="settings-layout">
                <div className="settings-sidebar">
                    {tabs.map((tab) => (
                        <button
                            key={tab.id}
                            className={`settings-sidebar__item ${activeTab === tab.id ? 'settings-sidebar__item--active' : ''}`}
                            onClick={() => setActiveTab(tab.id)}
                        >
                            <Icon name={tab.icon} />
                            <span>{tab.label}</span>
                        </button>
                    ))}
                </div>

                <div className="settings-content">
                    {activeTab === 'paths' && (
                        <div className="settings-panel">
                            {pathSettings.map((s) => (
                                <PathSettingItem key={s.label} setting={s} />
                            ))}
                        </div>
                    )}

                    {activeTab === 'creator' && (
                        <div className="settings-panel">
                            <CreatorTab
                                name={creatorName}
                                onName={setCreatorName}
                                description={creatorDescription}
                                onDescription={setCreatorDescription}
                                home={creatorHome}
                                onHome={setCreatorHome}
                                tip={creatorTip}
                                onTip={setCreatorTip}
                            />
                        </div>
                    )}

                    {activeTab === 'integrations' && (
                        <div className="settings-panel">
                            <IntegrationsTab
                                integrations={integrations}
                                onConnect={handleIntegrationConnect}
                                autoSync={autoSyncToLauncher}
                                onAutoSyncChange={setAutoSyncToLauncher}
                                ltkConfigured={!!ltkManagerModPath || !!celestialPath}
                                preferredLauncher={preferredLauncher}
                                onPreferredLauncherChange={setPreferredLauncher}
                            />
                        </div>
                    )}

                    {activeTab === 'general' && (
                        <div className="settings-panel">
                            <div className="settings-item">
                                <Checkbox
                                    toggle
                                    checked={verboseLogging}
                                    onChange={(e) => setVerboseLogging(e.target.checked)}
                                    label="Verbose Logging"
                                    description="Show detailed debug output in the log panel"
                                />
                            </div>

                            <div className="settings-item">
                                <Checkbox
                                    toggle
                                    checked={autoUpdateEnabled}
                                    onChange={(e) => setAutoUpdateEnabled(e.target.checked)}
                                    label="Automatic Updates"
                                    description="Check for updates on startup"
                                />
                            </div>

                            {/* Windows "Open with" file association card */}
                            <div className="settings-item">
                                <label className="settings-item__label">
                                    <Icon name="link" />
                                    Open With — Windows File Associations
                                    <span className="settings-item__badge">Windows</span>
                                </label>
                                <div className="settings-item__hint" style={{ marginBottom: 8 }}>
                                    Adds Flint as an &ldquo;Open with&rdquo; option for .wad, .bin, .tex, .modpkg, .fantome and more.
                                    Files opened this way go straight to Flint&rsquo;s file editor. Does <em>not</em> override your
                                    current default app.
                                </div>
                                {assocStatus && (
                                    <div className="settings-item__hint" style={{ marginBottom: 8 }}>
                                        {assocStatus.registered.length === 0
                                            ? <span style={{ color: 'var(--text-muted)' }}>Not registered</span>
                                            : <>
                                                <span style={{ color: 'var(--color-success, #22c55e)' }}>✓ Registered</span>
                                                {' '}&mdash; {assocStatus.registered.length} extension{assocStatus.registered.length !== 1 ? 's' : ''}
                                                {assocStatus.missing.length > 0 && (
                                                    <span style={{ color: 'var(--color-warning)' }}>
                                                        {' '}({assocStatus.missing.length} missing — re-register to fix)
                                                    </span>
                                                )}
                                            </>
                                        }
                                    </div>
                                )}
                                <div style={{ display: 'flex', gap: 8, flexWrap: 'wrap' }}>
                                    <Button
                                        variant="primary"
                                        size="sm"
                                        icon="link"
                                        disabled={isRegisteringAssoc}
                                        onClick={async () => {
                                            setIsRegisteringAssoc(true);
                                            try {
                                                const result = await api.registerFileAssociations();
                                                const status = await api.getFileAssociationStatus();
                                                setAssocStatus(status);
                                                if (result.errors.length === 0) {
                                                    showToast('success', `Registered ${result.touched.length} file types — right-click any file to try it`);
                                                } else {
                                                    showToast('warning', `Registered with ${result.errors.length} error(s): ${result.errors[0]}`);
                                                }
                                            } catch {
                                                showToast('error', 'Failed to register file associations');
                                            } finally {
                                                setIsRegisteringAssoc(false);
                                            }
                                        }}
                                    >
                                        {isRegisteringAssoc ? 'Registering…' : 'Register'}
                                    </Button>
                                    {assocStatus && assocStatus.registered.length > 0 && (
                                        <Button
                                            variant="ghost"
                                            size="sm"
                                            icon="close"
                                            disabled={isRegisteringAssoc}
                                            onClick={async () => {
                                                setIsRegisteringAssoc(true);
                                                try {
                                                    await api.unregisterFileAssociations();
                                                    const status = await api.getFileAssociationStatus();
                                                    setAssocStatus(status);
                                                    showToast('success', 'File associations removed');
                                                } catch {
                                                    showToast('error', 'Failed to remove file associations');
                                                } finally {
                                                    setIsRegisteringAssoc(false);
                                                }
                                            }}
                                        >
                                            Unregister
                                        </Button>
                                    )}
                                </div>
                            </div>

                            <div className={`settings-hash settings-hash--${state.hashesLoaded ? 'ok' : 'warn'}`}>
                                <div className={`settings-hash__icon settings-hash__icon--${state.hashesLoaded ? 'ok' : 'warn'}`}>
                                    <Icon name={state.hashesLoaded ? 'success' : 'warning'} />
                                </div>
                                <div className="settings-hash__body">
                                    <div className="settings-hash__title">Hash Database</div>
                                    <div className="settings-hash__count">
                                        {state.hashesLoaded
                                            ? <><strong>{state.hashCount.toLocaleString()}</strong> hashes loaded</>
                                            : <span style={{ color: 'var(--color-warning)' }}>Hashes not loaded</span>}
                                    </div>
                                    <div className="settings-hash__hint">
                                        Rebuild to apply the latest fixes (BIN file resolution, new hash dumps, etc.)
                                    </div>
                                </div>
                                <Button
                                    size="sm"
                                    icon="refresh"
                                    onClick={handleForceRebuildHashes}
                                    disabled={isRebuildingHashes}
                                >
                                    {isRebuildingHashes ? 'Rebuilding…' : 'Force Rebuild'}
                                </Button>
                            </div>

                            <div className="version-card">
                                <div className="version-card__content">
                                    <div className="version-card__current">
                                        <div className="version-card__label">Current</div>
                                        <div className="version-card__version">v{currentVersion}</div>
                                    </div>

                                    {latestVersion && updateAvailable && (
                                        <>
                                            <Icon name="chevronRight" className="version-card__arrow" />
                                            <div className="version-card__latest">
                                                <div className="version-card__label version-card__label--accent">
                                                    Latest
                                                </div>
                                                <div className="version-card__version version-card__version--accent">
                                                    v{latestVersion}
                                                </div>
                                            </div>
                                        </>
                                    )}
                                </div>

                                <div className="version-card__actions">
                                    <Button
                                        icon="refresh"
                                        onClick={handleCheckForUpdates}
                                        disabled={isCheckingUpdate}
                                        style={{ flex: 1 }}
                                    >
                                        {isCheckingUpdate ? 'Checking...' : 'Check for Updates'}
                                    </Button>

                                    {updateAvailable && latestVersion && (
                                        <Button
                                            variant="primary"
                                            icon="download"
                                            onClick={handleUpdateNow}
                                            style={{ flex: 1 }}
                                        >
                                            Update Now
                                        </Button>
                                    )}
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'theme' && (
                        <div className="settings-panel settings-panel--theme">
                            <div className="settings-item">
                                <label className="settings-item__label">Theme presets</label>
                                <div className="settings-item__hint" style={{ marginBottom: 10 }}>
                                    Five curated palettes that swap bg, surfaces, accent and text in one click.
                                </div>
                                <ThemePresetGrid
                                    selectedTheme={configStore.selectedTheme}
                                    onSelect={(id, accent) => {
                                        configStore.setSelectedTheme(id);
                                        ux.setAccentPrimary(accent);
                                    }}
                                />
                            </div>

                            <div className="settings-item">
                                <label className="settings-item__label">
                                    Glassmorphism
                                    <span className="settings-item__badge">Surfaces</span>
                                </label>
                                <Checkbox
                                    toggle
                                    checked={ux.glassmorphism}
                                    onChange={(e) => ux.setGlassmorphism(e.target.checked)}
                                    label="Frosted blur on panels and modals"
                                    description="Beautiful but costs a few frames. Turn off for solid surfaces."
                                />
                            </div>

                            {ux.glassmorphism && (
                                <>
                                    <div className="settings-item">
                                        <label className="settings-item__label">Glass blur</label>
                                        <input
                                            type="range"
                                            min={0}
                                            max={32}
                                            step={1}
                                            value={ux.glassBlur}
                                            onChange={(e) => ux.setGlassBlur(Number(e.target.value))}
                                            className="theme-range"
                                        />
                                        <div className="settings-item__hint">{ux.glassBlur}px</div>
                                    </div>
                                    <div className="settings-item">
                                        <label className="settings-item__label">Glass opacity</label>
                                        <input
                                            type="range"
                                            min={0.2}
                                            max={1}
                                            step={0.05}
                                            value={ux.glassOpacity}
                                            onChange={(e) => ux.setGlassOpacity(Number(e.target.value))}
                                            className="theme-range"
                                        />
                                        <div className="settings-item__hint">{Math.round(ux.glassOpacity * 100)}%</div>
                                    </div>
                                </>
                            )}

                            <div className="settings-item">
                                <label className="settings-item__label">
                                    FPS Mode
                                    <span className="settings-item__badge">Performance</span>
                                </label>
                                <Checkbox
                                    toggle
                                    checked={ux.fpsMode}
                                    onChange={(e) => ux.setFpsMode(e.target.checked)}
                                    label="Strip animations and transitions"
                                    description="Disables every CSS transition, animation and backdrop blur. Maximum responsiveness — perfect for older hardware or focused work sessions."
                                />
                            </div>

                        </div>
                    )}

                    {activeTab === 'dev' && (
                        <div className="settings-panel">
                            {import.meta.env.DEV && (
                                <div className="settings-item">
                                    <label className="settings-item__label">
                                        UI Primitives Preview
                                        <span className="settings-item__badge">Dev only</span>
                                    </label>
                                    <div className="settings-item__hint" style={{ marginBottom: 8 }}>
                                        Opens a fullscreen showcase of every component in the design system —
                                        Button, Checkbox, Toggle, Radio, Dropdown, Modal, Input, Range, Spinner,
                                        ProgressBar — in every variant. Use it to audit visual consistency
                                        after style or theme changes.
                                    </div>
                                    <Button
                                        variant="primary"
                                        icon="info"
                                        onClick={() => setShowUIPreview(true)}
                                    >
                                        Open UI Showcase
                                    </Button>
                                </div>
                            )}

                            {import.meta.env.DEV && (
                                <div className="settings-item">
                                    <label className="settings-item__label">
                                        Replay First-Time Setup
                                        <span className="settings-item__badge">Dev only</span>
                                    </label>
                                    <div className="settings-item__hint" style={{ marginBottom: 8 }}>
                                        Reopens the full-screen welcome wizard so you can re-test the onboarding
                                        flow without wiping your settings. Closes the Settings modal first.
                                    </div>
                                    <Button
                                        variant="secondary"
                                        icon="refresh"
                                        onClick={() => {
                                            closeModal();
                                            // Wait for the close animation to finish before opening the
                                            // wizard so the two transitions don't overlap visually.
                                            setTimeout(() => {
                                                dispatch({
                                                    type: 'OPEN_MODAL',
                                                    payload: { modal: 'firstTimeSetup' },
                                                });
                                            }, 300);
                                        }}
                                    >
                                        Replay Setup Wizard
                                    </Button>
                                </div>
                            )}

                            <div className="settings-item">
                                <label className="settings-item__label">
                                    Replay Tutorial
                                    <span className="settings-item__badge">Dev only</span>
                                </label>
                                <div className="settings-item__hint" style={{ marginBottom: 8 }}>
                                    Restarts the first-run guided tour from the beginning. Clears the
                                    "onboarding done" flag and triggers the overlay immediately — useful
                                    when validating tooltips after UI changes.
                                </div>
                                <Button
                                    variant="secondary"
                                    icon="info"
                                    onClick={() => {
                                        closeModal();
                                        // Let the Settings modal finish closing so the tutorial
                                        // spotlight can target real elements, not the modal stack.
                                        setTimeout(() => triggerTutorialReplay(), 320);
                                    }}
                                >
                                    Restart Tutorial
                                </Button>
                            </div>


                            <div className="settings-item">
                                <label className="settings-item__label">BIN Schema Aggregator</label>
                                <div className="settings-item__hint" style={{ marginBottom: 8 }}>
                                    Scans all WAD archives in your League installation and extracts the complete
                                    BIN class/field schema. Parses every BIN, unions all fields per class, and
                                    outputs a ritobin-style schema reference with value ranges.
                                </div>
                                <Button
                                    icon="download"
                                    onClick={handleAggregateBinSchema}
                                    disabled={isAggregating || !state.leaguePath}
                                >
                                    {isAggregating ? 'Aggregating...' : 'Get BIN Entries'}
                                </Button>
                                {!state.leaguePath && (
                                    <div className="settings-item__hint" style={{ color: 'var(--color-warning)', marginTop: 4 }}>
                                        Configure League path in the Paths tab first
                                    </div>
                                )}
                            </div>

                            {isAggregating && schemaProgress && <SchemaProgressView progress={schemaProgress} />}
                            {schemaResult && !isAggregating && (
                                <SchemaResultView
                                    classes={schemaResult.classes_found}
                                    fields={schemaResult.total_fields}
                                    binsParsed={schemaResult.bins_parsed}
                                    binsFailed={schemaResult.bins_failed}
                                    wads={schemaResult.wads_scanned}
                                    outputPath={schemaResult.output_path}
                                />
                            )}

                            <div
                                className="settings-item"
                                style={{ marginTop: 16, paddingTop: 16, borderTop: '1px solid var(--color-border)' }}
                            >
                                <label className="settings-item__label">Champion BIN Schema Creator</label>
                                <div className="settings-item__hint" style={{ marginBottom: 8 }}>
                                    Walks only the Champions WAD folder, picks skin BINs and the data BINs they
                                    link to — excludes champion-root, root.bin, animation, and corrupt BINs.
                                    Merges every property of every class globally and emits ONE synthetic ritobin
                                    file in real block syntax (with brackets). Copy any block straight into a
                                    .ritobin file.
                                </div>
                                <Button
                                    icon="download"
                                    onClick={handleAggregateChampionSchema}
                                    disabled={isAggregatingChampion || !state.leaguePath}
                                >
                                    {isAggregatingChampion ? 'Building...' : 'Build Champion Schema'}
                                </Button>
                                {!state.leaguePath && (
                                    <div className="settings-item__hint" style={{ color: 'var(--color-warning)', marginTop: 4 }}>
                                        Configure League path in the Paths tab first
                                    </div>
                                )}
                            </div>

                            {isAggregatingChampion && championSchemaProgress && (
                                <SchemaProgressView progress={championSchemaProgress} />
                            )}
                            {championSchemaResult && !isAggregatingChampion && (
                                <SchemaResultView
                                    classes={championSchemaResult.classes_found}
                                    fields={championSchemaResult.total_fields}
                                    binsParsed={championSchemaResult.bins_parsed}
                                    binsFailed={championSchemaResult.bins_failed}
                                    wads={championSchemaResult.wads_scanned}
                                    outputPath={championSchemaResult.output_path}
                                    label="LinkedData BINs"
                                />
                            )}
                        </div>
                    )}
                </div>
            </div>

            <ModalFooter>
                <Button variant="secondary" onClick={closeModal}>
                    Cancel
                </Button>
                <Button
                    variant="success"
                    icon="success"
                    onClick={handleSave}
                    disabled={isValidating}
                >
                    Save Settings
                </Button>
            </ModalFooter>

            {/* Fullscreen UI primitives showcase (dev tab) */}
            <Modal
                open={showUIPreview}
                onClose={() => setShowUIPreview(false)}
                modifier="modal--fullscreen"
            >
                <ModalHeader title="Design Lab" onClose={() => setShowUIPreview(false)} />
                <ModalBody style={{ overflow: 'auto', padding: 0 }}>
                    <DesignLab />
                </ModalBody>
            </Modal>
        </Modal>
    );
};
