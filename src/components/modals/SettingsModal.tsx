/**
 * Flint - Settings Modal Component
 * Left sidebar navigation + content panels.
 */

import React, { useState, useEffect } from 'react';
import { useAppState, useConfigStore, useUxStore } from '../../lib/stores';
import * as api from '../../lib/api';
import type { FileAssocStatus } from '../../lib/api';
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
    DesignLab,
    Textarea,
} from '../ui';
import { triggerTutorialReplay } from '../TutorialOverlay';

type SettingsTab = 'creator' | 'general' | 'theme' | 'paths' | 'integrations' | 'dev';

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
    /** Optional brand logo image; renders inside the icon frame. */
    logoSrc?: string;
    /** Optional brand colour; drives the connected glow + badge tint. */
    logoColor?: string;
    /** Optional generic icon name (Icon glyph) when no logoSrc. */
    iconName?: IconName;
}

const PathSettingItem: React.FC<{ setting: PathSetting }> = ({ setting }) => {
    const handleBrowse = async () => {
        const selected = await open({
            title: setting.browseTitle,
            directory: !setting.file,
        });
        if (selected) setting.onChange(selected as string);
    };
    const filled = setting.value.trim().length > 0;
    const style = setting.logoColor ? ({ ['--logo' as never]: setting.logoColor } as React.CSSProperties) : undefined;
    return (
        <div
            className={`settings-prow ${filled ? 'is-filled' : ''} ${setting.logoSrc ? 'has-logo' : ''}`}
            style={style}
        >
            <span className="settings-prow__icon" aria-hidden="true">
                {setting.logoSrc
                    ? <img src={setting.logoSrc} alt="" className="settings-prow__logo-img" draggable={false} />
                    : <Icon name={setting.iconName ?? 'folder'} />}
                {setting.logoSrc && <span className="settings-prow__logo-ring" />}
            </span>
            <div className="settings-prow__body">
                <div className="settings-prow__head">
                    <strong className="settings-prow__name">{setting.label}</strong>
                    {setting.badge && <span className="settings-prow__badge">{setting.badge}</span>}
                    <span className={`settings-prow__pill ${filled ? 'is-on' : ''}`}>
                        <span className="settings-prow__pill-dot" />
                        {filled ? 'Set' : 'Empty'}
                    </span>
                </div>
                {setting.hint && <p className="settings-prow__tagline">{setting.hint}</p>}
                <div className="settings-prow__field">
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
                            onClick={setting.onDetect}
                            disabled={setting.disabled}
                        >
                            {setting.detectLabel}
                        </Button>
                    )}
                </div>
            </div>
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

/* -------------------------------------------------------------------------- */
/* Theme preset grid — same 5 cards as the wizard, lives on the Theme tab     */
/* -------------------------------------------------------------------------- */
/* Flint is the default — `id: null` means "no theme override, fall back to
   index.css :root defaults". Selecting it routes to setSelectedTheme(null).
   The other 4 bind to real `themes/<id>.json` files seeded by the Rust
   `seed_builtin_themes` command. */
type SettingsThemePreset = { id: string | null; name: string; bg: string; raised: string; accent: string };
const SETTINGS_THEME_PRESETS: SettingsThemePreset[] = [
    { id: null,        name: 'Flint',     bg: '#0c0c10', raised: '#15151b', accent: '#EF4444' },
    { id: 'celestial', name: 'Celestial', bg: '#0a0a14', raised: '#13132a', accent: '#A05CF6' },
    { id: 'jade',      name: 'Jade',      bg: '#08111a', raised: '#0f1c28', accent: '#06B6D4' },
    { id: 'froggy',    name: 'Froggy',    bg: '#0a1410', raised: '#11241c', accent: '#22C55E' },
    { id: 'quartz',    name: 'Quartz',    bg: '#0f0a14', raised: '#1d1424', accent: '#EC4899' },
];
const ThemePresetGrid: React.FC<{
    selectedTheme: string | null;
    onSelect: (id: string | null, accent: string) => void;
}> = ({ selectedTheme, onSelect }) => {
    // Seed the JSON theme files on first render so clicking a card actually
    // resolves to a real `themes/<id>.json` via the existing apply path.
    useEffect(() => {
        api.seedBuiltinThemes().catch(() => { /* non-fatal */ });
    }, []);
    return (
        <div className="theme-preset-grid">
            {SETTINGS_THEME_PRESETS.map((t) => {
                const active = selectedTheme === t.id;
                return (
                    <button
                        key={t.id ?? '__default__'}
                        type="button"
                        className={`theme-preset ${active ? 'is-active' : ''}`}
                        style={{ ['--accent' as never]: t.accent, ['--bg' as never]: t.bg, ['--raised' as never]: t.raised }}
                        onClick={() => onSelect(t.id, t.accent)}
                        aria-pressed={active}
                    >
                        <span className="theme-preset__mock">
                            <span className="theme-preset__mock-rail" />
                            <span className="theme-preset__mock-rows">
                                <span className="theme-preset__mock-row">
                                    <span className="theme-preset__mock-tile" />
                                    <span className="theme-preset__mock-tile theme-preset__mock-tile--accent" />
                                </span>
                                <span className="theme-preset__mock-row">
                                    <span className="theme-preset__mock-tile theme-preset__mock-tile--accent-soft" />
                                    <span className="theme-preset__mock-tile" />
                                </span>
                            </span>
                        </span>
                        <span className="theme-preset__foot">
                            <span className="theme-preset__name">{t.name}</span>
                            <span className="theme-preset__dots">
                                <span className="theme-preset__dot" style={{ background: t.bg }} />
                                <span className="theme-preset__dot" style={{ background: t.accent }} />
                                {active && (
                                    <span className="theme-preset__check" style={{ background: t.accent }}>
                                        <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                                            <polyline points="20 6 9 17 4 12" />
                                        </svg>
                                    </span>
                                )}
                            </span>
                        </span>
                    </button>
                );
            })}
        </div>
    );
};

/* -------------------------------------------------------------------------- */
/* Creator tab — name, description, home URL, tip URL                          */
/* Inspired by celestial-1's CreatorHubTab but laid out in Flint's settings   */
/* primitive (settings-item / Field / Input). The header uses a glassy hero    */
/* card so the tab feels distinct from the rest of Settings.                   */
/* -------------------------------------------------------------------------- */
const CreatorTab: React.FC<{
    name: string;
    onName: (v: string) => void;
    description: string;
    onDescription: (v: string) => void;
    home: string;
    onHome: (v: string) => void;
    tip: string;
    onTip: (v: string) => void;
}> = ({ name, onName, description, onDescription, home, onHome, tip, onTip }) => {
    return (
        <div className="creator-tab">
            <div className="settings-item">
                <label className="settings-item__label">
                    <Icon name="user" /> Creator name
                </label>
                <Input
                    placeholder="Your handle (for mod credits)"
                    value={name}
                    onChange={(e) => onName(e.target.value)}
                />
            </div>

            <div className="settings-item">
                <label className="settings-item__label">
                    <Icon name="info" /> Default description
                    <span className="settings-item__badge">Optional</span>
                </label>
                <Textarea
                    placeholder="Short tagline shown on every imported / new mod (e.g. “Stylized recolors for Aatrox”)"
                    value={description}
                    onChange={(e) => onDescription(e.target.value)}
                    rows={2}
                    maxLength={280}
                />
                <div className="settings-item__hint">
                    Pre-fills the description on every new project — editable per-project later. {description.length}/280
                </div>
            </div>

            <div className="settings-item">
                <label className="settings-item__label">
                    <Icon name="globe" /> Home URL
                    <span className="settings-item__badge">Optional</span>
                </label>
                <Input
                    type="url"
                    placeholder="https://yoursite.com or your socials"
                    value={home}
                    onChange={(e) => onHome(e.target.value)}
                />
                <div className="settings-item__hint">
                    Shown as a “Home” link on every mod you publish.
                </div>
            </div>

            <div className="settings-item">
                <label className="settings-item__label">
                    <Icon name="heart" /> Tip URL
                    <span className="settings-item__badge">Optional</span>
                </label>
                <Input
                    type="url"
                    placeholder="https://ko-fi.com/you  ·  buymeacoffee.com/you"
                    value={tip}
                    onChange={(e) => onTip(e.target.value)}
                />
                <div className="settings-item__hint">
                    Shown as a tip-jar link so users can support your work.
                </div>
            </div>
        </div>
    );
};

/* -------------------------------------------------------------------------- */
/* Integrations tab — branded "Connect" cards for each external app           */
/* -------------------------------------------------------------------------- */
type IntegrationDisplay = {
    id: 'ltk' | 'celestial' | 'jade' | 'quartz';
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
};
const INTEGRATION_LOGOS: Record<IntegrationDisplay['id'], string> = {
    ltk: '/ltk-manager-logo.svg',
    celestial: '/celestial-logo.webp',
    jade: '/jade-logo.webp',
    quartz: '/quartz-logo.webp',
};
const IntegrationLogo: React.FC<{ id: IntegrationDisplay['id']; accent: string }> = ({ id, accent }) => (
    <div className="integration-card__logo" style={{ ['--logo' as never]: accent }}>
        <img src={INTEGRATION_LOGOS[id]} alt="" className="integration-card__logo-img" draggable={false} />
        <span className="integration-card__logo-ring" />
    </div>
);
const IntegrationsTab: React.FC<{
    integrations: IntegrationDisplay[];
    onConnect: (i: IntegrationDisplay) => Promise<void> | void;
    autoSync: boolean;
    onAutoSyncChange: (v: boolean) => void;
    ltkConfigured: boolean;
    preferredLauncher: 'ltk' | 'celestial' | null;
    onPreferredLauncherChange: (l: 'ltk' | 'celestial' | null) => void;
}> = ({ integrations, onConnect, autoSync, onAutoSyncChange, ltkConfigured, preferredLauncher, onPreferredLauncherChange }) => {
    const launchers = integrations.filter((i) => i.kind === 'launcher');
    const apps = integrations.filter((i) => i.kind !== 'launcher');
    const effective = preferredLauncher
        ?? (launchers.find((l) => l.path.trim().length > 0)?.id as 'ltk' | 'celestial' | undefined)
        ?? 'ltk';

    const renderCard = (i: IntegrationDisplay, isLauncher: boolean) => {
        const connected = i.path.trim().length > 0;
        const isDefault = isLauncher && effective === i.id;
        return (
            <div
                key={i.id}
                className={`integration-card ${connected ? 'is-connected' : ''} ${isDefault ? 'is-default' : ''}`}
                style={{ ['--logo' as never]: i.accent }}
            >
                <IntegrationLogo id={i.id} accent={i.accent} />
                <div className="integration-card__body">
                    <div className="integration-card__head">
                        <strong>{i.name}</strong>
                        <span className={`integration-card__pill ${connected ? 'is-on' : ''}`}>
                            <span className="integration-card__pill-dot" />
                            {connected ? 'Connected' : 'Not connected'}
                        </span>
                        {isDefault && (
                            <span className="integration-card__pill integration-card__pill--default">
                                <span className="integration-card__pill-dot" />
                                Default launcher
                            </span>
                        )}
                    </div>
                    <p className="integration-card__tagline">{i.tagline}</p>
                    {connected && <p className="integration-card__path" title={i.path}>{i.path}</p>}
                </div>
                <div className="integration-card__actions">
                    {connected ? (
                        <>
                            {isLauncher && !isDefault && (
                                <Button
                                    variant="primary"
                                    size="sm"
                                    icon="check"
                                    onClick={() => onPreferredLauncherChange(i.id as 'ltk' | 'celestial')}
                                >
                                    Set as default
                                </Button>
                            )}
                            <Button variant="ghost" size="sm" icon="refresh" onClick={() => void onConnect(i)}>Change</Button>
                            <Button variant="ghost" size="sm" icon="close" onClick={() => i.setPath('')}>Disconnect</Button>
                        </>
                    ) : (
                        <>
                            <Button variant="primary" size="sm" icon="link" onClick={() => void onConnect(i)}>
                                Connect
                            </Button>
                            <Button variant="ghost" size="sm" icon="search" onClick={i.onDetect}>Auto-detect</Button>
                        </>
                    )}
                </div>
                {isDefault && connected && (
                    <div className="integration-card__extra">
                        <Checkbox
                            toggle
                            checked={autoSync}
                            onChange={(e) => onAutoSyncChange(e.target.checked)}
                            disabled={!ltkConfigured}
                            label={`Auto-Sync to ${i.name}`}
                            description="Push project changes whenever files are modified."
                        />
                    </div>
                )}
            </div>
        );
    };

    return (
        <div className="integrations-tab">
            <p className="integrations-tab__intro">
                Connect external tools so Flint can hand off work to them. Each one is fully optional — you can swap them any time.
            </p>
            <div className="integrations-tab__group-label">Launchers</div>
            {launchers.map((i) => renderCard(i, true))}
            <div className="integrations-tab__group-label">External apps</div>
            {apps.map((i) => renderCard(i, false))}
        </div>
    );
};

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
