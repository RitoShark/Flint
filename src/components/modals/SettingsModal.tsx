import React, { useState, useEffect } from 'react';
import { useConfigStore, useUxStore, useModalStore, useNotificationStore, useAppMetadataStore, useWadExplorerStore } from '../../lib/stores';
import { useShallow } from 'zustand/react/shallow';
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

import { PathSettingItem, type PathSetting } from './settings/PathSettingItem';
import { SchemaProgressView, SchemaResultView, type SchemaProgress } from './settings/SchemaViews';
import { ThemePresetGrid } from './settings/ThemeTab';
import { CreatorTab } from './settings/CreatorTab';
import { IntegrationsTab } from './settings/IntegrationsTab';
import { SettingsRow, SettingsTag } from './settings/SettingsRow';
import { getIcon } from '../../lib/ui-helpers/fileIcons';

export const SettingsModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const openModal = useModalStore((s) => s.openModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const hashesLoaded = useAppMetadataStore((s) => s.hashesLoaded);
    const hashCount = useAppMetadataStore((s) => s.hashCount);
    const verboseLoggingStore = useAppMetadataStore((s) => s.verboseLogging);
    const wadExplorer = useWadExplorerStore(useShallow((s) => ({ isOpen: s.isOpen, wads: s.wads })));
    const setWadStatus = useWadExplorerStore((s) => s.setWadStatus);
    const configStore = useConfigStore();
    const ux = useUxStore();

    const [activeTab, setActiveTab] = useState<SettingsTab>('creator');

    const [leaguePath, setLeaguePath] = useState(configStore.leaguePath || '');
    const [leaguePathPbe, setLeaguePathPbe] = useState(configStore.leaguePathPbe || '');
    const [defaultProjectPath, setDefaultProjectPath] = useState(configStore.defaultProjectPath || '');
    const [creatorName, setCreatorName] = useState(configStore.creatorName || '');
    const [creatorDescription, setCreatorDescription] = useState(configStore.creatorDescription || '');
    const [creatorHome, setCreatorHome] = useState(configStore.creatorHome || '');
    const [creatorTip, setCreatorTip] = useState(configStore.creatorTip || '');
    const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(configStore.autoUpdateEnabled);
    const [verboseLogging, setVerboseLogging] = useState(verboseLoggingStore);
    const [ltkManagerModPath, setLtkManagerModPath] = useState(configStore.ltkManagerModPath || '');
    const [autoSyncToLauncher, setAutoSyncToLauncher] = useState(configStore.autoSyncToLauncher);
    const [celestialPath, setCelestialPath] = useState(configStore.celestialModPath || '');
    const [preferredLauncher, setPreferredLauncher] = useState<'ltk' | 'celestial' | null>(configStore.preferredLauncher);
    const [jadePath, setJadePath] = useState(configStore.jadePath || '');
    const [quartzPath, setQuartzPath] = useState(configStore.quartzPath || '');
    const [isValidating, setIsValidating] = useState(false);

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

    const [isAggregatingTft, setIsAggregatingTft] = useState(false);
    const [tftSchemaProgress, setTftSchemaProgress] = useState<SchemaProgress | null>(null);
    const [tftSchemaResult, setTftSchemaResult] = useState<api.TftSchemaStats | null>(null);

    const [isAggregatingLuabins, setIsAggregatingLuabins] = useState(false);
    const [luabinSchemaProgress, setLuabinSchemaProgress] = useState<SchemaProgress | null>(null);
    const [luabinSchemaResult, setLuabinSchemaResult] = useState<api.LuabinExtractStats | null>(null);

    const [isAggregatingTroybin, setIsAggregatingTroybin] = useState(false);
    const [troybinSchemaProgress, setTroybinSchemaProgress] = useState<SchemaProgress | null>(null);
    const [troybinSchemaResult, setTroybinSchemaResult] = useState<api.TroybinSchemaStats | null>(null);

    const [showUIPreview, setShowUIPreview] = useState(false);

    const isVisible = activeModal === 'settings';

    useEffect(() => {
        if (!isVisible) return;
        setLeaguePath(configStore.leaguePath || '');
        setLeaguePathPbe(configStore.leaguePathPbe || '');
        setDefaultProjectPath(configStore.defaultProjectPath || '');
        setCreatorName(configStore.creatorName || '');
        setCreatorDescription(configStore.creatorDescription || '');
        setCreatorHome(configStore.creatorHome || '');
        setCreatorTip(configStore.creatorTip || '');
        setAutoUpdateEnabled(configStore.autoUpdateEnabled);
        setVerboseLogging(verboseLoggingStore);
        setLtkManagerModPath(configStore.ltkManagerModPath || '');
        setAutoSyncToLauncher(configStore.autoSyncToLauncher);
        setCelestialPath(configStore.celestialModPath || '');
        setPreferredLauncher(configStore.preferredLauncher);
        setJadePath(configStore.jadePath || '');
        setQuartzPath(configStore.quartzPath || '');
        getVersion().then(setCurrentVersion).catch(() => setCurrentVersion('0.0.0'));
        api.getFileAssociationStatus().then(setAssocStatus).catch(() => {});
    }, [isVisible, configStore.leaguePath, configStore.leaguePathPbe, configStore.defaultProjectPath, configStore.creatorName, configStore.creatorDescription, configStore.creatorHome, configStore.creatorTip, configStore.autoUpdateEnabled, verboseLoggingStore, configStore.ltkManagerModPath, configStore.autoSyncToLauncher, configStore.jadePath, configStore.quartzPath, configStore.selectedTheme]);

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

    useEffect(() => {
        const unlisten = listen<SchemaProgress>('tft-schema-progress', (event) => {
            setTftSchemaProgress(event.payload);
        });
        return () => { unlisten.then((fn) => fn()); };
    }, []);

    useEffect(() => {
        const unlisten = listen<SchemaProgress>('luabin-extract-progress', (event) => {
            setLuabinSchemaProgress(event.payload);
        });
        return () => { unlisten.then((fn) => fn()); };
    }, []);

    useEffect(() => {
        const unlisten = listen<SchemaProgress>('troybin-schema-progress', (event) => {
            setTroybinSchemaProgress(event.payload);
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
        const basePath = leaguePath || configStore.leaguePath;
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
                } catch { }
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
        openModal('updateAvailable', {
            available: true,
            current_version: currentVersion,
            latest_version: latestVersion,
            release_notes: 'Check GitHub releases for details',
            published_at: new Date().toISOString(),
        } as Record<string, unknown>);
    };

    const handleForceRebuildHashes = async () => {
        setIsRebuildingHashes(true);
        try {
            await api.forceRebuildHashes();
            if (wadExplorer.isOpen) {
                wadExplorer.wads.forEach((wad) => {
                    if (wad.status === 'loaded') {
                        setWadStatus(wad.path, 'idle', [], undefined);
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
        if (!leaguePath) {
            showToast('error', 'League path not configured. Set it in the Paths tab first.');
            return;
        }
        setIsAggregating(true);
        setSchemaProgress(null);
        setSchemaResult(null);
        try {
            const stats = await api.aggregateBinSchema(leaguePath);
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
        if (!leaguePath) {
            showToast('error', 'League path not configured. Set it in the Paths tab first.');
            return;
        }
        setIsAggregatingChampion(true);
        setChampionSchemaProgress(null);
        setChampionSchemaResult(null);
        try {
            const stats = await api.aggregateChampionBinSchema(leaguePath);
            setChampionSchemaResult(stats);
            showToast('success', `Champion schema built: ${stats.classes_found.toLocaleString()} classes, ${stats.total_fields.toLocaleString()} fields`);
        } catch (error) {
            console.error('Champion schema aggregation failed:', error);
            showToast('error', 'Champion schema aggregation failed. Check the log for details.');
        } finally {
            setIsAggregatingChampion(false);
        }
    };

    const handleAggregateTftSchema = async () => {
        if (!leaguePath) {
            showToast('error', 'League path not configured. Set it in the Paths tab first.');
            return;
        }
        setIsAggregatingTft(true);
        setTftSchemaProgress(null);
        setTftSchemaResult(null);
        try {
            const stats = await api.aggregateTftBinSchema(leaguePath);
            setTftSchemaResult(stats);
            showToast('success', `TFT schema built: ${stats.classes_found.toLocaleString()} classes, ${stats.total_fields.toLocaleString()} fields`);
        } catch (error) {
            console.error('TFT schema aggregation failed:', error);
            showToast('error', 'TFT schema aggregation failed. Check the log for details.');
        } finally {
            setIsAggregatingTft(false);
        }
    };

    const handleBuildLuabinSchema = async () => {
        if (!leaguePath) {
            showToast('error', 'League path not configured. Set it in the Paths tab first.');
            return;
        }
        setIsAggregatingLuabins(true);
        setLuabinSchemaProgress(null);
        setLuabinSchemaResult(null);
        try {
            const stats = await api.extractAllLuabins(leaguePath);
            setLuabinSchemaResult(stats);
            showToast('success', `Built luabin schema with ${stats.classes_found.toLocaleString()} globals from ${stats.wads_scanned.toLocaleString()} WADs`);
        } catch (error) {
            console.error('Luabin schema build failed:', error);
            showToast('error', 'Luabin schema build failed. Check the log for details.');
        } finally {
            setIsAggregatingLuabins(false);
        }
    };

    const handleAggregateTroybinSchema = async () => {
        if (!leaguePath) {
            showToast('error', 'League path not configured. Set it in the Paths tab first.');
            return;
        }
        setIsAggregatingTroybin(true);
        setTroybinSchemaProgress(null);
        setTroybinSchemaResult(null);
        try {
            const stats = await api.aggregateTroybinSchema(leaguePath);
            setTroybinSchemaResult(stats);
            showToast('success', `Troybin schema built: ${stats.classes_found.toLocaleString()} classes, ${stats.total_fields.toLocaleString()} fields`);
        } catch (error) {
            console.error('Troybin schema aggregation failed:', error);
            showToast('error', 'Troybin schema aggregation failed. Check the log for details.');
        } finally {
            setIsAggregatingTroybin(false);
        }
    };

    const handleSave = async () => {
        if (leaguePath && leaguePath !== configStore.leaguePath) {
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

        configStore.setLeaguePath(leaguePath || null);
        configStore.setLeaguePathPbe(leaguePathPbe || null);
        configStore.setDefaultProjectPath(defaultProjectPath || null);
        configStore.setCreatorName(creatorName || null);
        configStore.setCreatorDescription(creatorDescription.trim() || null);
        configStore.setCreatorHome(creatorHome.trim() || null);
        configStore.setCreatorTip(creatorTip.trim() || null);
        configStore.setAutoUpdateEnabled(autoUpdateEnabled);
        configStore.setLtkManagerModPath(ltkManagerModPath || null);
        configStore.setAutoSyncToLauncher(autoSyncToLauncher);
        configStore.setCelestialModPath(celestialPath || null);
        configStore.setPreferredLauncher(preferredLauncher);
        useAppMetadataStore.getState().setVerboseLogging(verboseLogging);

        configStore.setJadePath(jadePath || null);
        configStore.setQuartzPath(quartzPath || null);

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
        kind?: 'launcher' | 'app';
    }
    const integrations: Integration[] = [
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
                        <div className="settings-panel settings-panel--flush">
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
                        <div className="settings-panel settings-panel--flush">
                            <div className="settings-subhead">Preferences</div>
                            <SettingsRow
                                icon={<Icon name="code" />}
                                title="Verbose Logging"
                                sub={<span className="settings-row__sub">Show detailed debug output in the log panel</span>}
                                onActivate={() => setVerboseLogging(!verboseLogging)}
                                actions={<Checkbox toggle checked={verboseLogging} onChange={(e) => setVerboseLogging(e.target.checked)} />}
                            />
                            <SettingsRow
                                icon={<Icon name="download" />}
                                title="Automatic Updates"
                                sub={<span className="settings-row__sub">Automatically download and install updates before Flint opens</span>}
                                onActivate={() => setAutoUpdateEnabled(!autoUpdateEnabled)}
                                actions={<Checkbox toggle checked={autoUpdateEnabled} onChange={(e) => setAutoUpdateEnabled(e.target.checked)} />}
                            />

                            <div className="settings-subhead">Windows</div>
                            <SettingsRow
                                icon={<Icon name="link" />}
                                title="Open With — File Associations"
                                tags={<>
                                    <SettingsTag>Windows</SettingsTag>
                                    {assocStatus && (assocStatus.registered.length === 0
                                        ? <span className="dl-badge">Not registered</span>
                                        : <span className={`dl-badge ${assocStatus.missing.length > 0 ? 'dl-badge--warn' : 'dl-badge--success'}`}>
                                            {assocStatus.missing.length > 0 ? `${assocStatus.missing.length} missing` : `${assocStatus.registered.length} registered`}
                                        </span>)}
                                </>}
                                sub={<span className="settings-row__sub" style={{ whiteSpace: 'normal' }}>
                                    Adds Flint as an “Open with” option for .wad, .bin, .tex, .modpkg, .fantome and more — files open straight in Flint&rsquo;s editor without changing your default app.
                                </span>}
                                actions={<>
                                    <button
                                        className="dl-btn dl-btn--primary dl-btn--sm"
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
                                        {isRegisteringAssoc ? 'Registering…' : (assocStatus && assocStatus.registered.length > 0 ? 'Re-register' : 'Register')}
                                    </button>
                                    {assocStatus && assocStatus.registered.length > 0 && (
                                        <button
                                            className="dl-btn dl-btn--ghost dl-btn--sm"
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
                                        </button>
                                    )}
                                </>}
                            />

                            <div className="settings-subhead">Updates &amp; System</div>
                            <div className="settings-duo">
                                <div className="settings-fcard">
                                    <div className="settings-fcard__head">
                                        <span className="settings-fcard__glyph"><Icon name="info" /></span>
                                        <span className="settings-fcard__title">Program Version</span>
                                    </div>
                                    <div className="settings-fcard__value">
                                        v{currentVersion}
                                        {updateAvailable && latestVersion && <span className="accent" style={{ fontSize: 12, marginLeft: 8 }}>→ v{latestVersion}</span>}
                                    </div>
                                    <p className="settings-fcard__hint">
                                        {updateAvailable && latestVersion ? 'An update is available.' : 'You’re on the latest release.'}
                                    </p>
                                    <div className="settings-fcard__actions">
                                        <button className="dl-btn dl-btn--sm" onClick={handleCheckForUpdates} disabled={isCheckingUpdate}>
                                            {isCheckingUpdate ? 'Checking…' : 'Check for Updates'}
                                        </button>
                                        {updateAvailable && latestVersion && (
                                            <button className="dl-btn dl-btn--primary dl-btn--sm" onClick={handleUpdateNow}>Update Now</button>
                                        )}
                                    </div>
                                </div>

                                <div className={`settings-fcard ${hashesLoaded ? 'settings-fcard--ok' : 'settings-fcard--warn'}`}>
                                    <div className="settings-fcard__head">
                                        <span className="settings-fcard__glyph">
                                            <Icon name={hashesLoaded ? 'success' : 'warning'} />
                                        </span>
                                        <span className="settings-fcard__title">Hash Database</span>
                                    </div>
                                    <div className="settings-fcard__value">
                                        {hashesLoaded
                                            ? <><span className="accent">{hashCount.toLocaleString()}</span> hashes</>
                                            : <span style={{ color: 'var(--color-warning)' }}>Not loaded</span>}
                                    </div>
                                    <p className="settings-fcard__hint">
                                        Rebuild to apply the latest fixes (BIN resolution, new hash dumps, etc.)
                                    </p>
                                    <div className="settings-fcard__actions">
                                        <button className="dl-btn dl-btn--sm" onClick={handleForceRebuildHashes} disabled={isRebuildingHashes}>
                                            {isRebuildingHashes ? 'Rebuilding…' : 'Force Rebuild'}
                                        </button>
                                    </div>
                                </div>
                            </div>
                        </div>
                    )}

                    {activeTab === 'theme' && (
                        <div className="settings-panel settings-panel--flush">
                            <div className="settings-subhead">Appearance</div>
                            <p className="settings-subhead__note">
                                Curated palettes that swap bg, surfaces, accent and text in one click — or pick a custom accent.
                            </p>
                            <ThemePresetGrid
                                selectedTheme={configStore.selectedTheme}
                                customAccent={ux.accentPrimary}
                                onSelect={(id, accent) => {
                                    configStore.setSelectedTheme(id);
                                    ux.setAccentPrimary(accent);
                                }}
                                onCustomAccent={(hex) => {
                                    configStore.setSelectedTheme('custom');
                                    ux.setAccentPrimary(hex);
                                }}
                            />

                            <div className="settings-subhead">Surfaces</div>
                            <SettingsRow
                                icon={<Icon name="picture" />}
                                title="Glassmorphism"
                                sub={<span className="settings-row__sub">Frosted blur on panels and modals — turn off for solid surfaces.</span>}
                                onActivate={() => ux.setGlassmorphism(!ux.glassmorphism)}
                                actions={<Checkbox toggle checked={ux.glassmorphism} onChange={(e) => ux.setGlassmorphism(e.target.checked)} />}
                            />
                            {ux.glassmorphism && (
                                <>
                                    <SettingsRow
                                        icon={<Icon name="settings" />}
                                        title="Glass blur"
                                        sub={
                                            <input type="range" min={0} max={32} step={1} value={ux.glassBlur}
                                                onChange={(e) => ux.setGlassBlur(Number(e.target.value))} className="theme-range" />
                                        }
                                        actions={<span className="settings-row__metric">{ux.glassBlur}px</span>}
                                    />
                                    <SettingsRow
                                        icon={<Icon name="settings" />}
                                        title="Glass opacity"
                                        sub={
                                            <input type="range" min={0.2} max={1} step={0.05} value={ux.glassOpacity}
                                                onChange={(e) => ux.setGlassOpacity(Number(e.target.value))} className="theme-range" />
                                        }
                                        actions={<span className="settings-row__metric">{Math.round(ux.glassOpacity * 100)}%</span>}
                                    />
                                </>
                            )}

                            <div className="settings-subhead">Performance</div>
                            <SettingsRow
                                icon={<Icon name="refresh" />}
                                title="FPS Mode"
                                tags={<SettingsTag>Performance</SettingsTag>}
                                sub={<span className="settings-row__sub" style={{ whiteSpace: 'normal' }}>Strip every CSS transition, animation and backdrop blur for maximum responsiveness — great for older hardware.</span>}
                                onActivate={() => ux.setFpsMode(!ux.fpsMode)}
                                actions={<Checkbox toggle checked={ux.fpsMode} onChange={(e) => ux.setFpsMode(e.target.checked)} />}
                            />
                            <SettingsRow
                                icon={<Icon name="picture" />}
                                title="Button Glow"
                                tags={<SettingsTag>Performance</SettingsTag>}
                                sub={<span className="settings-row__sub" style={{ whiteSpace: 'normal' }}>{ux.fpsMode
                                    ? 'Off automatically while FPS Mode is on (the cursor-tracking listener costs frames).'
                                    : 'A soft radial glow that tracks your cursor across buttons. On by default.'}</span>}
                                onActivate={ux.fpsMode ? undefined : () => ux.setButtonGlow(!ux.buttonGlow)}
                                actions={<Checkbox toggle checked={ux.buttonGlow && !ux.fpsMode} disabled={ux.fpsMode} onChange={(e) => ux.setButtonGlow(e.target.checked)} />}
                            />
                        </div>
                    )}

                    {activeTab === 'dev' && (
                        <div className="settings-panel settings-panel--flush">
                            <div className="dev-header">
                                <span className="dev-header__glyph"><Icon name="code" /></span>
                                <div className="dev-header__text">
                                    <div className="dev-header__title">
                                        Developer Tools
                                        <span className="dl-badge dl-badge--warn">{import.meta.env.DEV ? 'Dev build' : 'Advanced'}</span>
                                    </div>
                                    <p className="dev-header__sub">
                                        Internal utilities and schema extractors. Handle with care — these scan your
                                        whole League install and write files to disk.
                                    </p>
                                </div>
                            </div>

                            {import.meta.env.DEV && (
                                <>
                                    <div className="settings-subhead">Debug utilities · dev build only</div>
                                    <div className="dev-grid">
                                        <button className="dev-tile" onClick={() => setShowUIPreview(true)}>
                                            <span className="dev-tile__ico" dangerouslySetInnerHTML={{ __html: getIcon('picture') }} />
                                            <span className="dev-tile__label">UI Showcase</span>
                                            <span className="dev-tile__desc">Every component, every variant</span>
                                        </button>
                                        <button className="dev-tile" onClick={() => { closeModal(); setTimeout(() => useModalStore.getState().openModal('firstTimeSetup'), 300); }}>
                                            <span className="dev-tile__ico" dangerouslySetInnerHTML={{ __html: getIcon('refresh') }} />
                                            <span className="dev-tile__label">Replay Setup</span>
                                            <span className="dev-tile__desc">Reopen the welcome wizard</span>
                                        </button>
                                        <button className="dev-tile" onClick={() => { closeModal(); setTimeout(() => triggerTutorialReplay(), 320); }}>
                                            <span className="dev-tile__ico" dangerouslySetInnerHTML={{ __html: getIcon('info') }} />
                                            <span className="dev-tile__label">Restart Tutorial</span>
                                            <span className="dev-tile__desc">Replay the guided tour</span>
                                        </button>
                                        <button className="dev-tile" onClick={() => openModal('whatsNew', {})}>
                                            <span className="dev-tile__ico" dangerouslySetInnerHTML={{ __html: getIcon('info') }} />
                                            <span className="dev-tile__label">What&rsquo;s New</span>
                                            <span className="dev-tile__desc">Preview the update popup</span>
                                        </button>
                                    </div>
                                </>
                            )}

                            <div className="settings-subhead">Schema extractors</div>
                            {!leaguePath && (
                                <p className="dev-warn">Configure your League path in the Paths tab to enable these.</p>
                            )}
                            <div className="dev-grid">
                                <button className="dev-tile" onClick={handleAggregateBinSchema} disabled={isAggregating || !leaguePath} title="Scans all WADs and unions every BIN class/field into a ritobin-style schema.">
                                    <span className="dev-tile__ico" dangerouslySetInnerHTML={{ __html: getIcon('code') }} />
                                    <span className="dev-tile__label">{isAggregating ? 'Aggregating…' : 'BIN Entries'}</span>
                                    <span className="dev-tile__desc">All WADs → full BIN schema</span>
                                </button>
                                <button className="dev-tile" onClick={handleAggregateChampionSchema} disabled={isAggregatingChampion || !leaguePath} title="Champions WAD only: skin BINs + linked data BINs, merged into one ritobin block file.">
                                    <span className="dev-tile__ico" dangerouslySetInnerHTML={{ __html: getIcon('code') }} />
                                    <span className="dev-tile__label">{isAggregatingChampion ? 'Building…' : 'Champion'}</span>
                                    <span className="dev-tile__desc">Skin + linked data BINs</span>
                                </button>
                                <button className="dev-tile" onClick={handleAggregateTftSchema} disabled={isAggregatingTft || !leaguePath} title="TFT WADs: companions + map-mode data (traits, items, augments), merged into one ritobin file.">
                                    <span className="dev-tile__ico" dangerouslySetInnerHTML={{ __html: getIcon('code') }} />
                                    <span className="dev-tile__label">{isAggregatingTft ? 'Building…' : 'TFT'}</span>
                                    <span className="dev-tile__desc">Companions + mode data</span>
                                </button>
                                <button className="dev-tile" onClick={handleBuildLuabinSchema} disabled={isAggregatingLuabins || !leaguePath} title="Finds all .luabin/.luabin64 chunks and merges their global assignments into luabin-schema.lua.">
                                    <span className="dev-tile__ico" dangerouslySetInnerHTML={{ __html: getIcon('code') }} />
                                    <span className="dev-tile__label">{isAggregatingLuabins ? 'Building…' : 'Luabin'}</span>
                                    <span className="dev-tile__desc">Global vars → schema.lua</span>
                                </button>
                                <button className="dev-tile" onClick={handleAggregateTroybinSchema} disabled={isAggregatingTroybin || !leaguePath} title="Picks up all .troybin files and merges every class property into one ritobin file.">
                                    <span className="dev-tile__ico" dangerouslySetInnerHTML={{ __html: getIcon('code') }} />
                                    <span className="dev-tile__label">{isAggregatingTroybin ? 'Building…' : 'Troybin'}</span>
                                    <span className="dev-tile__desc">All .troybin → schema</span>
                                </button>
                            </div>

                            {isAggregating && schemaProgress && <SchemaProgressView progress={schemaProgress} />}
                            {schemaResult && !isAggregating && (
                                <SchemaResultView classes={schemaResult.classes_found} fields={schemaResult.total_fields} binsParsed={schemaResult.bins_parsed} binsFailed={schemaResult.bins_failed} wads={schemaResult.wads_scanned} outputPath={schemaResult.output_path} />
                            )}
                            {isAggregatingChampion && championSchemaProgress && <SchemaProgressView progress={championSchemaProgress} />}
                            {championSchemaResult && !isAggregatingChampion && (
                                <SchemaResultView classes={championSchemaResult.classes_found} fields={championSchemaResult.total_fields} binsParsed={championSchemaResult.bins_parsed} binsFailed={championSchemaResult.bins_failed} wads={championSchemaResult.wads_scanned} outputPath={championSchemaResult.output_path} label="LinkedData BINs" />
                            )}
                            {isAggregatingTft && tftSchemaProgress && <SchemaProgressView progress={tftSchemaProgress} />}
                            {tftSchemaResult && !isAggregatingTft && (
                                <SchemaResultView classes={tftSchemaResult.classes_found} fields={tftSchemaResult.total_fields} binsParsed={tftSchemaResult.bins_parsed} binsFailed={tftSchemaResult.bins_failed} wads={tftSchemaResult.wads_scanned} outputPath={tftSchemaResult.output_path} label="TFT BINs" />
                            )}
                            {isAggregatingLuabins && luabinSchemaProgress && <SchemaProgressView progress={luabinSchemaProgress} />}
                            {luabinSchemaResult && !isAggregatingLuabins && (
                                <SchemaResultView classes={luabinSchemaResult.classes_found} fields={luabinSchemaResult.total_fields} binsParsed={luabinSchemaResult.bins_parsed} binsFailed={luabinSchemaResult.bins_failed} wads={luabinSchemaResult.wads_scanned} outputPath={luabinSchemaResult.output_path} label="luabins" />
                            )}
                            {isAggregatingTroybin && troybinSchemaProgress && <SchemaProgressView progress={troybinSchemaProgress} />}
                            {troybinSchemaResult && !isAggregatingTroybin && (
                                <SchemaResultView classes={troybinSchemaResult.classes_found} fields={troybinSchemaResult.total_fields} binsParsed={troybinSchemaResult.bins_parsed} binsFailed={troybinSchemaResult.bins_failed} wads={troybinSchemaResult.wads_scanned} outputPath={troybinSchemaResult.output_path} label=".troybin BINs" />
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
