/**
 * Flint - Settings Modal Component
 * Left sidebar navigation + content panels.
 */

import React, { useState, useEffect } from 'react';
import { useAppState, useConfigStore, useUxStore } from '../../lib/stores';
import * as api from '../../lib/api';
import * as updater from '../../lib/updater';
import { open } from '@tauri-apps/plugin-dialog';
import { listen } from '@tauri-apps/api/event';
import { getVersion } from '@tauri-apps/api/app';
import {
    Button,
    Checkbox,
    Icon,
    type IconName,
    Input,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    ProgressBar,
    Picker,
    DesignLab,
} from '../ui';

type SettingsTab = 'paths' | 'general' | 'theme' | 'dev';

const ACCENT_PRESETS: { name: string; hex: string }[] = [
    { name: 'Flint Red',   hex: '#EF4444' },
    { name: 'Sunset',      hex: '#F97316' },
    { name: 'Honey',       hex: '#EAB308' },
    { name: 'Forest',      hex: '#22C55E' },
    { name: 'Lagoon',      hex: '#06B6D4' },
    { name: 'Sapphire',    hex: '#3B82F6' },
    { name: 'Iris',        hex: '#8B5CF6' },
    { name: 'Magenta',     hex: '#EC4899' },
];

interface PathSetting {
    label: string;
    badge?: string;
    placeholder: string;
    value: string;
    onChange: (v: string) => void;
    browseTitle: string;
    onDetect?: () => void;
    detectLabel?: string;
    /** Treat as file picker rather than directory. */
    file?: boolean;
    hint?: string;
    disabled?: boolean;
}

const PathSettingItem: React.FC<{ setting: PathSetting }> = ({ setting }) => {
    const handleBrowse = async () => {
        const selected = await open({
            title: setting.browseTitle,
            directory: !setting.file,
        });
        if (selected) setting.onChange(selected as string);
    };

    return (
        <div className="settings-item">
            <label className="settings-item__label">
                {setting.label}
                {setting.badge && <span className="settings-item__badge">{setting.badge}</span>}
            </label>
            <Input
                placeholder={setting.placeholder}
                value={setting.value}
                onChange={(e) => setting.onChange(e.target.value)}
                buttonLabel="Browse"
                onButtonClick={handleBrowse}
            />
            {setting.onDetect && setting.detectLabel && (
                <Button
                    variant="ghost"
                    size="sm"
                    icon="search"
                    style={{ marginTop: 6 }}
                    onClick={setting.onDetect}
                    disabled={setting.disabled}
                >
                    {setting.detectLabel}
                </Button>
            )}
            {setting.hint && <div className="settings-item__hint">{setting.hint}</div>}
        </div>
    );
};

interface SchemaProgress {
    phase: string;
    current: number;
    total: number;
    bins_parsed: number;
    bins_failed: number;
    classes_found: number;
}

const SchemaProgressView: React.FC<{ progress: SchemaProgress }> = ({ progress }) => {
    const pct = (progress.current / Math.max(progress.total, 1)) * 100;
    return (
        <div className="settings-item">
            <div className="settings-item__label">
                {progress.phase === 'complete'
                    ? 'Complete'
                    : `Scanning WAD ${progress.current} / ${progress.total}`}
            </div>
            <ProgressBar value={pct} hideHeader />
            <div className="settings-item__hint" style={{ marginTop: 4 }}>
                {progress.bins_parsed.toLocaleString()} BINs parsed
                {progress.bins_failed > 0 && ` (${progress.bins_failed} failed)`}
                {' | '}
                {progress.classes_found.toLocaleString()} classes found
            </div>
        </div>
    );
};

const SchemaResultView: React.FC<{
    classes: number;
    fields: number;
    binsParsed: number;
    binsFailed: number;
    wads: number;
    outputPath: string;
    label?: string;
}> = ({ classes, fields, binsParsed, binsFailed, wads, outputPath, label = 'BIN files' }) => (
    <div className="settings-item">
        <div className="settings-item__label">Result</div>
        <div className="settings-item__hint">
            Found {classes.toLocaleString()} classes with {fields.toLocaleString()} fields across{' '}
            {binsParsed.toLocaleString()} {label}
            {binsFailed > 0 && ` (${binsFailed} failed to parse)`} from {wads.toLocaleString()} WADs
        </div>
        <div className="settings-item__hint" style={{ marginTop: 4 }}>
            Output: {outputPath}
        </div>
        <Button
            variant="ghost"
            size="sm"
            icon="folder"
            style={{ marginTop: 6 }}
            onClick={() => {
                const dir = outputPath.replace(/[\\/][^\\/]+$/, '');
                api.openInExplorer(dir).catch(() => {});
            }}
        >
            Open in Explorer
        </Button>
    </div>
);

export const SettingsModal: React.FC = () => {
    const { state, dispatch, closeModal, showToast } = useAppState();
    const configStore = useConfigStore();
    const ux = useUxStore();

    const [activeTab, setActiveTab] = useState<SettingsTab>('general');

    const [leaguePath, setLeaguePath] = useState(state.leaguePath || '');
    const [leaguePathPbe, setLeaguePathPbe] = useState(state.leaguePathPbe || '');
    const [defaultProjectPath, setDefaultProjectPath] = useState(state.defaultProjectPath || '');
    const [creatorName, setCreatorName] = useState(state.creatorName || '');
    const [autoUpdateEnabled, setAutoUpdateEnabled] = useState(state.autoUpdateEnabled);
    const [verboseLogging, setVerboseLogging] = useState(state.verboseLogging);
    const [ltkManagerModPath, setLtkManagerModPath] = useState(state.ltkManagerModPath || '');
    const [autoSyncToLauncher, setAutoSyncToLauncher] = useState(state.autoSyncToLauncher);
    const [binConverterEngine, setBinConverterEngine] = useState<'ltk' | 'jade'>(configStore.binConverterEngine);
    const [jadePath, setJadePath] = useState(configStore.jadePath || '');
    const [quartzPath, setQuartzPath] = useState(configStore.quartzPath || '');
    const [isValidating, setIsValidating] = useState(false);

    const [currentVersion, setCurrentVersion] = useState<string>('');
    const [latestVersion, setLatestVersion] = useState<string | null>(null);
    const [isCheckingUpdate, setIsCheckingUpdate] = useState(false);
    const [updateAvailable, setUpdateAvailable] = useState(false);

    const [selectedTheme, setSelectedTheme] = useState(configStore.selectedTheme || '');
    const [availableThemes, setAvailableThemes] = useState<api.ThemeInfo[]>([]);

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
        setAutoUpdateEnabled(state.autoUpdateEnabled);
        setVerboseLogging(state.verboseLogging);
        setLtkManagerModPath(state.ltkManagerModPath || '');
        setAutoSyncToLauncher(state.autoSyncToLauncher);
        setBinConverterEngine(configStore.binConverterEngine);
        setJadePath(configStore.jadePath || '');
        setQuartzPath(configStore.quartzPath || '');
        setSelectedTheme(configStore.selectedTheme || '');
        getVersion().then(setCurrentVersion).catch(() => setCurrentVersion('0.0.0'));
        api.listThemes().then(setAvailableThemes).catch(() => {});
    }, [isVisible, state.leaguePath, state.leaguePathPbe, state.defaultProjectPath, state.creatorName, state.autoUpdateEnabled, state.verboseLogging, state.ltkManagerModPath, state.autoSyncToLauncher, configStore.binConverterEngine, configStore.jadePath, configStore.quartzPath, configStore.selectedTheme]);

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
                autoUpdateEnabled,
                verboseLogging,
                ltkManagerModPath: ltkManagerModPath || null,
                autoSyncToLauncher,
            },
        });

        configStore.setBinConverterEngine(binConverterEngine);
        configStore.setJadePath(jadePath || null);
        configStore.setQuartzPath(quartzPath || null);
        configStore.setSelectedTheme(selectedTheme || null);

        api.setLogLevel(verboseLogging).catch(() => {});
        showToast('success', 'Settings saved');
        closeModal();
    };

    const tabs: { id: SettingsTab; label: string; icon: IconName }[] = [
        { id: 'general', label: 'General', icon: 'settings' },
        { id: 'theme', label: 'Theme', icon: 'picture' },
        { id: 'paths', label: 'Paths', icon: 'folder' },
        { id: 'dev', label: 'Dev', icon: 'code' },
    ];

    const pathSettings: PathSetting[] = [
        {
            label: 'Default Project Path',
            placeholder: 'Where new projects are created',
            value: defaultProjectPath,
            onChange: setDefaultProjectPath,
            browseTitle: 'Select Default Project Folder',
        },
        {
            label: 'League of Legends Path',
            placeholder: 'C:\\Riot Games\\League of Legends',
            value: leaguePath,
            onChange: setLeaguePath,
            browseTitle: 'Select League of Legends Folder',
            onDetect: handleDetectLeague,
            detectLabel: 'Auto-detect',
            disabled: isValidating,
        },
        {
            label: 'League of Legends PBE Path',
            badge: 'PBE',
            placeholder: 'C:\\Riot Games\\League of Legends (PBE)',
            value: leaguePathPbe,
            onChange: setLeaguePathPbe,
            browseTitle: 'Select PBE Folder',
            onDetect: handleDetectPbe,
            detectLabel: 'Auto-detect PBE',
            disabled: isValidating,
        },
        {
            label: 'LTK Manager Mod Path',
            badge: 'Launcher',
            placeholder: 'Path to LTK Manager mod storage',
            value: ltkManagerModPath,
            onChange: setLtkManagerModPath,
            browseTitle: 'Select LTK Manager Mod Storage Folder',
            onDetect: handleDetectLtkManager,
            detectLabel: 'Auto-detect LTK Manager',
            disabled: isValidating,
            hint: 'Configure where LTK Manager stores mods for auto-sync functionality',
        },
        {
            label: 'Jade Path',
            badge: 'External App',
            placeholder: 'Path to Jade.exe',
            value: jadePath,
            onChange: setJadePath,
            browseTitle: 'Select Jade Executable',
            onDetect: handleDetectJade,
            detectLabel: 'Auto-detect Jade',
            disabled: isValidating,
            hint: 'Jade League Bin Editor - Alternative BIN viewer with custom converter',
        },
        {
            label: 'Quartz Path',
            badge: 'External App',
            placeholder: 'Path to Quartz.exe',
            value: quartzPath,
            onChange: setQuartzPath,
            browseTitle: 'Select Quartz Executable',
            onDetect: handleDetectQuartz,
            detectLabel: 'Auto-detect Quartz',
            disabled: isValidating,
            hint: 'Quartz VFX Editor - Tool for recoloring and porting VFX',
        },
    ];

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

                    {activeTab === 'general' && (
                        <div className="settings-panel">
                            <div className="settings-item">
                                <label className="settings-item__label">Creator Name</label>
                                <Input
                                    placeholder="Your name (for mod credits)"
                                    value={creatorName}
                                    onChange={(e) => setCreatorName(e.target.value)}
                                />
                            </div>

                            <div className="settings-item">
                                <label className="settings-item__label">
                                    BIN Conversion Engine
                                    <span className="settings-item__badge">Advanced</span>
                                </label>
                                <Picker
                                    fullWidth
                                    value={binConverterEngine}
                                    onChange={(v) => setBinConverterEngine(v as 'ltk' | 'jade')}
                                    options={[
                                        { value: 'ltk',  label: 'LTK (Default)',  hint: 'Standard converter, ships with Flint' },
                                        { value: 'jade', label: 'Jade Custom', hint: 'Alt converter, handles edge-case BINs better' },
                                    ]}
                                />
                                <div className="settings-item__hint">
                                    Jade Custom converter may handle certain BIN files better than LTK
                                </div>
                            </div>

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

                            <div className="settings-item">
                                <Checkbox
                                    toggle
                                    checked={autoSyncToLauncher}
                                    onChange={(e) => setAutoSyncToLauncher(e.target.checked)}
                                    disabled={!ltkManagerModPath}
                                    label={
                                        <>
                                            Auto-Sync to LTK Manager
                                            {ltkManagerModPath && (
                                                <span className="settings-item__badge" style={{ marginLeft: 8 }}>
                                                    Launcher
                                                </span>
                                            )}
                                        </>
                                    }
                                    description={
                                        ltkManagerModPath
                                            ? 'Automatically sync project changes to LTK Manager when files are modified'
                                            : 'Configure LTK Manager path in Paths tab to enable auto-sync'
                                    }
                                />
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
                                <label className="settings-item__label">Accent color</label>
                                <div className="settings-item__hint" style={{ marginBottom: 8 }}>
                                    Drives every focus ring, primary button, and highlight in the app.
                                </div>
                                <div className="theme-swatches">
                                    {ACCENT_PRESETS.map((p) => {
                                        const isActive = (ux.accentPrimary || '#EF4444').toUpperCase() === p.hex.toUpperCase();
                                        return (
                                            <button
                                                key={p.hex}
                                                type="button"
                                                className={`theme-swatch ${isActive ? 'theme-swatch--active' : ''}`}
                                                style={{ background: p.hex }}
                                                onClick={() => ux.setAccentPrimary(p.hex)}
                                                title={p.name}
                                                aria-label={p.name}
                                            />
                                        );
                                    })}
                                    <label className="theme-swatch theme-swatch--custom" title="Pick custom">
                                        <input
                                            type="color"
                                            value={ux.accentPrimary || '#EF4444'}
                                            onChange={(e) => ux.setAccentPrimary(e.target.value.toUpperCase())}
                                        />
                                        <span>+</span>
                                    </label>
                                    <Button
                                        size="sm"
                                        variant="ghost"
                                        icon="refresh"
                                        onClick={() => ux.setAccentPrimary(null)}
                                    >
                                        Reset
                                    </Button>
                                </div>
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

                            <div className="settings-item">
                                <label className="settings-item__label">Theme preset</label>
                                <div style={{ display: 'flex', gap: 8, alignItems: 'center' }}>
                                    <div style={{ flex: 1 }}>
                                        <Picker
                                            fullWidth
                                            value={selectedTheme}
                                            onChange={(v) => setSelectedTheme(v)}
                                            options={[
                                                { value: '', label: 'Default (Red)' },
                                                ...availableThemes.map((t) => ({ value: t.id, label: t.name })),
                                            ]}
                                        />
                                    </div>
                                    <Button
                                        size="sm"
                                        onClick={async () => {
                                            try {
                                                const path = await api.createDefaultTheme();
                                                await api.openInExplorer(path.replace(/[^/\\]*$/, ''));
                                                showToast('success', 'Theme template created — edit custom.json and restart');
                                                api.listThemes().then(setAvailableThemes).catch(() => {});
                                            } catch {
                                                showToast('error', 'Failed to create theme template');
                                            }
                                        }}
                                    >
                                        Create Custom
                                    </Button>
                                </div>
                                <div className="settings-item__hint">
                                    Drop .json theme files in the themes folder to add more options.
                                </div>
                            </div>

                            <div className="settings-item">
                                <label className="settings-item__label">Live preview</label>
                                <div className="theme-preview">
                                    <Button variant="primary" icon="success">Primary</Button>
                                    <Button variant="secondary">Secondary</Button>
                                    <Button variant="ghost" icon="search">Ghost</Button>
                                    <Button variant="danger" icon="trash">Danger</Button>
                                    <span className="theme-preview__chip">Accent chip</span>
                                </div>
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
