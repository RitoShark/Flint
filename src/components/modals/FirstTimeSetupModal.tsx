import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useModalStore, useNotificationStore, useConfigStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { openUrl } from '@tauri-apps/plugin-opener';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Button, Input, Icon, Textarea, Checkbox, Spinner, type IconName } from '../ui';
import { FlintFlameMark } from '../ui/FlintFlameMark';
import { SettingsRow } from './settings/SettingsRow';
import { PathSettingItem } from './settings/PathSettingItem';
import { FlowPane, ProjectsPane, WorkspacePane, WadPane, MenusPane } from './setup/TourPanes';

type StepId = 'splash' | 'flow' | 'projects' | 'workspace' | 'wad' | 'menus' | 'identity' | 'paths' | 'finish';

interface Step {
    id: StepId;
    /** Starts a new rail group when set. */
    group?: string;
    /** Rail label. Empty = not shown in the rail. */
    short: string;
    hint: string;
    icon: IconName;
    title: string;
    subtitle: string;
}

const STEPS: Step[] = [
    { id: 'splash', short: '', hint: '', icon: 'info', title: '', subtitle: '' },
    {
        id: 'flow', group: 'Learn', short: 'How it works', hint: 'The five stages', icon: 'refresh',
        title: 'How Flint works',
        subtitle: 'From the files sitting in your League folder to a mod someone else can install.',
    },
    {
        id: 'projects', short: 'Projects', hint: 'Making a mod', icon: 'plus',
        title: 'Projects',
        subtitle: 'What New Project does, and what each field on it decides.',
    },
    {
        id: 'workspace', short: 'Workspace', hint: 'Where you edit', icon: 'layerText',
        title: 'The workspace',
        subtitle: 'Four regions, and which tool opens for which file.',
    },
    {
        id: 'wad', short: 'WAD Explorer', hint: 'Reading the game', icon: 'wad',
        title: 'WAD Explorer',
        subtitle: 'Search and preview the game archives without extracting anything first.',
    },
    {
        id: 'menus', short: 'Right-click', hint: 'Where the tools live', icon: 'more',
        title: 'Right-click menus',
        subtitle: 'Most of what Flint can do is one right-click away.',
    },
    {
        id: 'identity', group: 'Set up', short: 'You', hint: 'Name and links', icon: 'user',
        title: 'Who is shipping this',
        subtitle: 'Your creator name is stamped into every mod you build.',
    },
    {
        id: 'paths', short: 'Paths', hint: 'Game, launcher, editors', icon: 'folder',
        title: 'Point Flint at your install',
        subtitle: 'Flint needs the League folder for almost everything. The rest are optional.',
    },
    { id: 'finish', short: 'Finish', hint: 'Two last switches', icon: 'success', title: '', subtitle: '' },
];

type DetectingState = boolean;

export const FirstTimeSetupModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const config = useConfigStore();

    const creatorDescriptionStored = useConfigStore((s) => s.creatorDescription);
    const creatorHomeStored = useConfigStore((s) => s.creatorHome);
    const creatorTipStored = useConfigStore((s) => s.creatorTip);
    const leaguePathStored = useConfigStore((s) => s.leaguePath);
    const leaguePathPbeStored = useConfigStore((s) => s.leaguePathPbe);
    const defaultProjectPathStored = useConfigStore((s) => s.defaultProjectPath);
    const ltkManagerModPathStored = useConfigStore((s) => s.ltkManagerModPath);
    const celestialModPathStored = useConfigStore((s) => s.celestialModPath);
    const preferredLauncherStored = useConfigStore((s) => s.preferredLauncher);
    const jadePathStored = useConfigStore((s) => s.jadePath);
    const quartzPathStored = useConfigStore((s) => s.quartzPath);
    const autoSyncStored = useConfigStore((s) => s.autoSyncToLauncher);
    const autoUpdateStored = useConfigStore((s) => s.autoUpdateEnabled);

    const [stepIndex, setStepIndex] = useState(0);
    const [direction, setDirection] = useState<1 | -1>(1);
    const [creatorName, setCreatorName] = useState('');
    const [creatorDescription, setCreatorDescription] = useState(creatorDescriptionStored || '');
    const [creatorHome, setCreatorHome] = useState(creatorHomeStored || '');
    const [creatorTip, setCreatorTip] = useState(creatorTipStored || '');
    const [leaguePath, setLeaguePath] = useState(leaguePathStored || '');
    const [pbePath, setPbePath] = useState(leaguePathPbeStored || '');
    const [defaultProjectPath, setDefaultProjectPath] = useState(defaultProjectPathStored || '');
    const [ltkPath, setLtkPath] = useState(ltkManagerModPathStored || '');
    const [celestialPath, setCelestialPath] = useState(celestialModPathStored || '');
    const [preferredLauncher, setPreferredLauncher] = useState<'ltk' | 'celestial' | null>(preferredLauncherStored);
    const [jadePath, setJadePath] = useState(jadePathStored || '');
    const [quartzPath, setQuartzPath] = useState(quartzPathStored || '');
    const [autoSync, setAutoSync] = useState<boolean>(autoSyncStored);
    const [editorsOpen, setEditorsOpen] = useState(false);
    const [registerAssoc, setRegisterAssoc] = useState(true);
    const [autoUpdate, setAutoUpdate] = useState<boolean>(autoUpdateStored);
    const [detectingAll, setDetectingAll] = useState<DetectingState>(false);
    const autoDetectRan = useRef(false);
    const [flintHome, setFlintHome] = useState<string>('');

    const isVisible = activeModal === 'firstTimeSetup';
    const step = STEPS[stepIndex];
    const isLast = stepIndex === STEPS.length - 1;

    const advance = () => { setDirection(1); setStepIndex((i) => Math.min(STEPS.length - 1, i + 1)); };
    const back    = () => { setDirection(-1); setStepIndex((i) => Math.max(0, i - 1)); };

    useEffect(() => {
        if (!isVisible || flintHome) return;
        api.getAppHome().then((home) => {
            const sep = home.includes('\\') ? '\\' : '/';
            const guess = `${home.replace(/[\\/]+$/, '')}${sep}projects`;
            setFlintHome(guess);
            setDefaultProjectPath((prev) => prev || guess);
        }).catch(() => { /* non-fatal */ });
    }, [isVisible, flintHome]);

    useEffect(() => {
        if (!isVisible) return;
        api.seedBuiltinThemes().catch((err) => {
            console.warn('[Wizard] Failed to seed built-in themes:', err);
        });
    }, [isVisible]);

    const detectAll = async () => {
        setDetectingAll(true);
        const results: string[] = [];
        const failures: string[] = [];
        try {
            let detectedLeague = leaguePath;
            try {
                const r = await api.detectLeague();
                if (r.path) {
                    detectedLeague = r.path;
                    setLeaguePath(r.path);
                    results.push('League');
                } else {
                    failures.push('League');
                }
            } catch { failures.push('League'); }

            if (detectedLeague) {
                const parent = detectedLeague.replace(/[\\/][^\\/]+$/, '');
                const candidates = [
                    `${parent}\\League of Legends (PBE)`,
                    `${parent}\\League of Legends(PBE)`,
                    `${detectedLeague} (PBE)`,
                ];
                let foundPbe = false;
                for (const c of candidates) {
                    try {
                        const v = await api.validateLeague(c);
                        if (v.valid) {
                            setPbePath(c);
                            results.push('PBE');
                            foundPbe = true;
                            break;
                        }
                    } catch { /* try next */ }
                }
                if (!foundPbe) failures.push('PBE');
            } else {
                failures.push('PBE');
            }

            const ext = await api.detectExternalApps().catch(() => ({
                jade: null, quartz: null, ltk_manager: null, celestial: null,
            }));
            const ltkFound = ext.ltk_manager;
            const celFound = ext.celestial;
            if (ltkFound) {
                setLtkPath(ltkFound);
                results.push('LTK Manager');
            } else {
                failures.push('LTK Manager');
            }
            if (celFound) {
                setCelestialPath(celFound);
                results.push('Celestial');
            }
            setPreferredLauncher((prev) => prev ?? (celFound ? 'celestial' : ltkFound ? 'ltk' : null));

            // Editors are optional — surface them only when actually found, so the
            // block stays collapsed for users who don't have them installed.
            if (ext.jade) {
                setJadePath(ext.jade);
                results.push('Jade');
            }
            if (ext.quartz) {
                setQuartzPath(ext.quartz);
                results.push('Quartz');
            }
            if (ext.jade || ext.quartz) setEditorsOpen(true);

            if (results.length === 0) {
                showToast('warning', 'Nothing was auto-detected. Fill the paths in manually.');
            } else if (failures.length === 0) {
                showToast('success', `Detected ${results.join(', ')}.`);
            } else {
                showToast('info', `Found ${results.join(', ')}. Couldn't find ${failures.join(', ')}.`);
            }
        } finally {
            setDetectingAll(false);
        }
    };

    // Auto-run detection the first time the Paths step is reached — no button.
    useEffect(() => {
        if (!isVisible || step.id !== 'paths' || autoDetectRan.current) return;
        autoDetectRan.current = true;
        void detectAll();
    }, [isVisible, step.id]); // eslint-disable-line react-hooks/exhaustive-deps

    const browseDir = async (title: string, setter: (v: string) => void) => {
        const selected = await open({ title, directory: true });
        if (selected) setter(selected as string);
    };

    const handleFinish = async () => {
        if (!creatorName.trim()) {
            setStepIndex(STEPS.findIndex((s) => s.id === 'identity'));
            showToast('warning', 'A creator name is required.');
            return;
        }

        if (leaguePath) {
            try {
                const result = await api.validateLeague(leaguePath);
                if (!result.valid) {
                    setStepIndex(STEPS.findIndex((s) => s.id === 'paths'));
                    showToast('error', "That folder doesn't look like a League install.");
                    return;
                }
            } catch {
                showToast('error', 'Failed to validate League path');
                return;
            }
        }

        config.setCreatorName(creatorName.trim());
        config.setCreatorDescription(creatorDescription.trim() || null);
        config.setCreatorHome(creatorHome.trim() || null);
        config.setCreatorTip(creatorTip.trim() || null);
        config.setLeaguePath(leaguePath || null);
        config.setLeaguePathPbe(pbePath || null);
        config.setDefaultProjectPath(defaultProjectPath || null);
        config.setLtkManagerModPath(ltkPath || null);
        config.setCelestialModPath(celestialPath || null);
        config.setPreferredLauncher(preferredLauncher);
        config.setJadePath(jadePath || null);
        config.setQuartzPath(quartzPath || null);
        config.setAutoSyncToLauncher(autoSync);
        config.setAutoUpdateEnabled(autoUpdate);

        // Opt-in "Open with" registration. Never block entering Flint on it.
        if (registerAssoc) {
            try {
                const result = await api.registerFileAssociations();
                if (result.errors.length > 0) {
                    showToast('warning', `File associations registered with ${result.errors.length} error(s).`);
                }
            } catch {
                showToast('warning', "Couldn't register file associations. You can do it later in Settings.");
            }
        }

        closeModal();
        showToast('success', 'Setup complete. Welcome to Flint.');
    };

    const onIdentityKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && creatorName.trim()) advance();
    };

    const canAdvance = useMemo(() => {
        if (step.id === 'identity') return creatorName.trim().length > 0;
        return true;
    }, [step.id, creatorName]);

    if (!isVisible) return null;

    const goToStep = (i: number) => {
        if (i > stepIndex) return;
        setDirection(i > stepIndex ? 1 : -1);
        setStepIndex(i);
    };

    if (step.id === 'splash') {
        return (
            <div className="fwiz" role="dialog" aria-modal="true" aria-label="First-time setup">
                <WizBackdrop />
                <WizTitleBar />
                <SplashPane onStart={advance} />
            </div>
        );
    }

    const visibleSteps = STEPS.slice(1);
    const visibleIndex = stepIndex - 1;
    const visibleTotal = visibleSteps.length;

    return (
        <div className="fwiz" role="dialog" aria-modal="true" aria-label="First-time setup">
            <WizBackdrop />
            <WizTitleBar />
            <div className="fwiz__shell">
                <WizRail
                    steps={visibleSteps}
                    index={visibleIndex}
                    onJump={(i) => goToStep(i + 1)}
                />

                <div className="fwiz__main">
                    <main className={`fwiz__stage fwiz__stage--${direction > 0 ? 'fwd' : 'back'}`} key={step.id}>
                        {(step.title || step.subtitle) && (
                            <div className="fwiz__heading">
                                {step.title && <h1>{step.title}</h1>}
                                {step.subtitle && <p>{step.subtitle}</p>}
                            </div>
                        )}

                        <div className="fwiz__body">
                            {step.id === 'identity' && (
                                <IdentityPane
                                    value={creatorName}
                                    onChange={setCreatorName}
                                    onKeyDown={onIdentityKey}
                                    description={creatorDescription}
                                    onDescriptionChange={setCreatorDescription}
                                    home={creatorHome}
                                    onHomeChange={setCreatorHome}
                                    tip={creatorTip}
                                    onTipChange={setCreatorTip}
                                />
                            )}
                            {step.id === 'paths' && (
                                <PathsPane
                                    league={leaguePath}
                                    pbe={pbePath}
                                    project={defaultProjectPath}
                                    ltk={ltkPath}
                                    celestial={celestialPath}
                                    preferredLauncher={preferredLauncher}
                                    jade={jadePath}
                                    quartz={quartzPath}
                                    autoSync={autoSync}
                                    editorsOpen={editorsOpen}
                                    flintHome={flintHome}
                                    detectingAll={detectingAll}
                                    onLeague={setLeaguePath}
                                    onPbe={setPbePath}
                                    onProject={setDefaultProjectPath}
                                    onLtk={setLtkPath}
                                    onCelestial={setCelestialPath}
                                    onJade={setJadePath}
                                    onQuartz={setQuartzPath}
                                    onAutoSync={setAutoSync}
                                    onEditorsToggle={() => setEditorsOpen((v) => !v)}
                                    onPreferredLauncherChange={setPreferredLauncher}
                                    onBrowseLeague={() => browseDir('Select League of Legends Folder', setLeaguePath)}
                                    onBrowsePbe={() => browseDir('Select PBE Folder', setPbePath)}
                                    onBrowseProject={() => browseDir('Where should new projects be created?', setDefaultProjectPath)}
                                    onBrowseLtk={() => browseDir('Select LTK Manager Mod Folder', setLtkPath)}
                                    onBrowseCelestial={() => browseDir('Select Celestial Mod Folder', setCelestialPath)}
                                />
                            )}
                            {step.id === 'flow' && <FlowPane />}
                            {step.id === 'projects' && <ProjectsPane />}
                            {step.id === 'workspace' && <WorkspacePane />}
                            {step.id === 'wad' && <WadPane />}
                            {step.id === 'menus' && <MenusPane />}
                            {step.id === 'finish' && (
                                <FinishPane
                                    creatorName={creatorName}
                                    registerAssoc={registerAssoc}
                                    onRegisterAssoc={setRegisterAssoc}
                                    autoUpdate={autoUpdate}
                                    onAutoUpdate={setAutoUpdate}
                                />
                            )}
                        </div>
                    </main>

                    <footer className="fwiz__nav">
                        <Button variant="ghost" onClick={back} disabled={visibleIndex === 0}>
                            Back
                        </Button>
                        <div className="fwiz__nav-spacer" />
                        <span className="fwiz__nav-counter">
                            {String(visibleIndex + 1).padStart(2, '0')}<span> / {visibleTotal}</span>
                        </span>
                        {isLast ? (
                            <Button variant="success" size="lg" iconRight="chevronRight" onClick={handleFinish} className="fwiz__cta">
                                Enter Flint
                            </Button>
                        ) : (
                            <Button
                                variant="primary"
                                size="lg"
                                iconRight="chevronRight"
                                onClick={advance}
                                disabled={!canAdvance}
                                className="fwiz__cta"
                            >
                                Continue
                            </Button>
                        )}
                    </footer>
                </div>
            </div>
        </div>
    );
};

/* -------------------------------------------------------------------------- */
/* Splash — logo-only intro that auto-advances with a smooth zoom-fade.       */
/* No CTA button — the splash plays itself and hands off to the wizard.       */
/* -------------------------------------------------------------------------- */
const SplashPane: React.FC<{ onStart: () => void }> = ({ onStart }) => {
    const [stage, setStage] = useState<'in' | 'hold' | 'out'>('in');
    useEffect(() => {
        const t1 = setTimeout(() => setStage('hold'), 1100);
        const t2 = setTimeout(() => setStage('out'),  3000);
        const t3 = setTimeout(() => onStart(),        3700);
        return () => { clearTimeout(t1); clearTimeout(t2); clearTimeout(t3); };
    }, [onStart]);

    const word = 'FLINT';
    const tagline = 'A modding IDE for League of Legends';
    return (
        <div
            className={`fwiz-splash fwiz-splash--${stage}`}
            onClick={() => stage !== 'out' && setStage('out')}
            role="button"
            tabIndex={0}
            aria-label="Skip intro"
        >
            <div className="fwiz-splash__logo" aria-hidden="true">
                <span className="fwiz-splash__logo-glow" />
                <FlintFlameMark size={118} />
                <span className="fwiz-splash__logo-ring" />
                <span className="fwiz-splash__logo-ring fwiz-splash__logo-ring--two" />
            </div>
            <h1 className="fwiz-splash__title" aria-label="Flint">
                {word.split('').map((c, i) => (
                    <span key={i} style={{ animationDelay: `${i * 0.06}s` }}>{c}</span>
                ))}
            </h1>
            <span className="fwiz-splash__bar" aria-hidden="true" />
            <p className="fwiz-splash__subtitle">{tagline}</p>
            <span className="fwiz-splash__hint" aria-hidden="true">click anywhere to skip</span>
        </div>
    );
};

/* -------------------------------------------------------------------------- */
/* Background — animated gradient mesh + drifting orbs                         */
/* -------------------------------------------------------------------------- */
const WizBackdrop: React.FC = () => {
    const ref = useRef<HTMLDivElement>(null);
    useEffect(() => {
        const el = ref.current;
        if (!el) return;
        const onMove = (e: MouseEvent) => {
            const x = (e.clientX / window.innerWidth) * 100;
            const y = (e.clientY / window.innerHeight) * 100;
            el.style.setProperty('--mx', `${x}%`);
            el.style.setProperty('--my', `${y}%`);
        };
        window.addEventListener('mousemove', onMove);
        return () => window.removeEventListener('mousemove', onMove);
    }, []);
    return (
        <div className="fwiz__bg" ref={ref}>
            <div className="fwiz__bg-grid" />
            <div className="fwiz__bg-orb fwiz__bg-orb--a" />
            <div className="fwiz__bg-orb fwiz__bg-orb--b" />
            <div className="fwiz__bg-orb fwiz__bg-orb--c" />
            <div className="fwiz__bg-spot" />
            <div className="fwiz__bg-vignette" />
        </div>
    );
};

/* -------------------------------------------------------------------------- */
/* Title bar — mirrors the app's main TitleBar (FlintLogo + "Flint") plus      */
/* the standard window controls. Drag region everywhere except the buttons.    */
/* The flame mark glows to mark this as the onboarding context.                */
/* -------------------------------------------------------------------------- */
const WizTitleBar: React.FC = () => {
    const onMinimize = () => { void getCurrentWindow().minimize().catch(() => {}); };
    const onMaximize = () => { void getCurrentWindow().toggleMaximize().catch(() => {}); };
    const onClose    = () => { void getCurrentWindow().close().catch(() => {}); };
    return (
        <div className="fwiz__titlebar titlebar" data-tauri-drag-region>
            <div className="titlebar__left fwiz__titlebar-left" data-tauri-drag-region>
                <div className="titlebar__logo fwiz__titlebar-logo" data-tauri-drag-region="false">
                    <span className="fwiz-mark" aria-hidden="true">
                        <FlintFlameMark size={22} />
                        <span className="fwiz-mark__halo" />
                    </span>
                    <span className="titlebar__app-name">Flint</span>
                    <span className="fwiz__titlebar-mode">Setup</span>
                </div>
            </div>
            <div className="fwiz__titlebar-controls" data-tauri-drag-region="false">
                <button className="fwiz__win-btn" onClick={onMinimize} aria-label="Minimize" title="Minimize">
                    <svg width="10" height="10" viewBox="0 0 10 10"><path d="M0 5 H10" stroke="currentColor" strokeWidth="1" /></svg>
                </button>
                <button className="fwiz__win-btn" onClick={onMaximize} aria-label="Maximize" title="Maximize">
                    <svg width="10" height="10" viewBox="0 0 10 10"><rect x="0.5" y="0.5" width="9" height="9" stroke="currentColor" strokeWidth="1" fill="none" /></svg>
                </button>
                <button className="fwiz__win-btn fwiz__win-btn--close" onClick={onClose} aria-label="Close" title="Close">
                    <svg width="10" height="10" viewBox="0 0 10 10">
                        <path d="M0 0 L10 10 M10 0 L0 10" stroke="currentColor" strokeWidth="1" />
                    </svg>
                </button>
            </div>
        </div>
    );
};

/* -------------------------------------------------------------------------- */
/* Rail                                                                        */
/* -------------------------------------------------------------------------- */
const WizRail: React.FC<{
    steps: Step[];
    index: number;
    onJump: (i: number) => void;
}> = ({ steps, index, onJump }) => (
    <nav className="fwiz-rail" aria-label="Setup steps">
        {steps.map((s, i) => (
            <React.Fragment key={s.id}>
                {s.group && (
                    <>
                        {i > 0 && <div className="fwiz-rail__rule" />}
                        <span className="fwiz-rail__group">{s.group}</span>
                    </>
                )}
                <button
                    type="button"
                    className="fwiz-rail__item"
                    aria-pressed={i === index}
                    aria-current={i === index ? 'step' : undefined}
                    data-done={i < index || undefined}
                    disabled={i > index}
                    onClick={() => onJump(i)}
                    title={s.short}
                >
                    <span className="fwiz-rail__ico">
                        {i < index ? (
                            <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                <polyline points="20 6 9 17 4 12" />
                            </svg>
                        ) : (
                            <Icon name={s.icon} />
                        )}
                    </span>
                    <span className="fwiz-rail__text">
                        <span className="fwiz-rail__title">{s.short}</span>
                        <span className="fwiz-rail__sub">{s.hint}</span>
                    </span>
                </button>
            </React.Fragment>
        ))}
    </nav>
);

/* -------------------------------------------------------------------------- */
/* Step panes                                                                  */
/* -------------------------------------------------------------------------- */

const IdentityPane: React.FC<{
    value: string;
    onChange: (v: string) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    description: string;
    onDescriptionChange: (v: string) => void;
    home: string;
    onHomeChange: (v: string) => void;
    tip: string;
    onTipChange: (v: string) => void;
}> = ({ value, onChange, onKeyDown, description, onDescriptionChange, home, onHomeChange, tip, onTipChange }) => (
    <div className="fwiz-settings fwiz-pane--split">
        <div className="fwiz-pane__col">
            <p className="settings-subhead">Creator</p>
            <SettingsRow
                icon={<Icon name="user" />}
                title="Your creator name"
                sub={
                    <div className="creator-field">
                        <Input
                            placeholder="e.g. SirDexal"
                            value={value}
                            onChange={(e) => onChange(e.target.value)}
                            onKeyDown={onKeyDown}
                            autoFocus
                        />
                        <p className="creator-field__hint">
                            Stamped into every mod you ship, so the credit is already in there.
                        </p>
                    </div>
                }
            />
            <SettingsRow
                icon={<Icon name="document" />}
                title="Default description"
                sub={
                    <div className="creator-field">
                        <Textarea
                            placeholder="A tagline that pre-fills new mod projects (e.g. “Stylized recolors for Aatrox.”)"
                            value={description}
                            onChange={(e) => onDescriptionChange(e.target.value)}
                            rows={3}
                            maxLength={280}
                        />
                        <p className="creator-field__hint">
                            Pre-fills the description on every new project. You can change it per project. {description.length}/280
                        </p>
                    </div>
                }
            />
        </div>

        <div className="fwiz-pane__col">
            <p className="settings-subhead">Links</p>
            <p className="settings-subhead__note">Optional. These ship with your mods so people can find you.</p>
            <SettingsRow
                icon={<Icon name="link" />}
                title="Home page"
                sub={
                    <div className="creator-field">
                        <Input
                            placeholder="https://your-site-or-socials"
                            value={home}
                            onChange={(e) => onHomeChange(e.target.value)}
                        />
                        <p className="creator-field__hint">Where people can find more of your work.</p>
                    </div>
                }
            />
            <SettingsRow
                icon={<Icon name="link" />}
                title="Tip / support link"
                sub={
                    <div className="creator-field">
                        <Input
                            placeholder="https://ko-fi.com/you"
                            value={tip}
                            onChange={(e) => onTipChange(e.target.value)}
                        />
                        <p className="creator-field__hint">Optional donate link for people who want to support you.</p>
                    </div>
                }
            />
        </div>
    </div>
);

const PathsPane: React.FC<{
    league: string; pbe: string; project: string; ltk: string; celestial: string;
    preferredLauncher: 'ltk' | 'celestial' | null;
    jade: string; quartz: string;
    autoSync: boolean;
    editorsOpen: boolean;
    flintHome: string;
    detectingAll: boolean;
    onLeague: (v: string) => void;
    onPbe: (v: string) => void;
    onProject: (v: string) => void;
    onLtk: (v: string) => void;
    onCelestial: (v: string) => void;
    onJade: (v: string) => void;
    onQuartz: (v: string) => void;
    onAutoSync: (b: boolean) => void;
    onEditorsToggle: () => void;
    onPreferredLauncherChange: (l: 'ltk' | 'celestial' | null) => void;
    onBrowseLeague: () => void;
    onBrowsePbe: () => void;
    onBrowseProject: () => void;
    onBrowseLtk: () => void;
    onBrowseCelestial: () => void;
}> = (p) => {
    const hasEditor = !!(p.jade.trim() || p.quartz.trim());
    const filledCount = [p.project, p.league, p.pbe, p.ltk || p.celestial, p.jade || p.quartz]
        .filter((v) => v.trim().length > 0).length;
    const progress = (filledCount / 5) * 100;
    return (
    <div className="fwiz-settings">
        <div className={`fwiz-detectbar ${p.detectingAll ? 'is-busy' : ''}`}>
            <span className="fwiz-detectbar__icon" aria-hidden="true">
                {p.detectingAll ? <Spinner size="sm" /> : <Icon name="success" />}
            </span>
            <div className="fwiz-detectbar__text">
                <strong>{p.detectingAll ? 'Detecting your setup…' : 'Auto-detected your setup'}</strong>
                <span>
                    {p.detectingAll
                        ? 'Scanning for League, PBE, launchers and editors. Adjust anything below.'
                        : `Found ${filledCount}/5. Review or change any path below.`}
                </span>
            </div>
            <div className="fwiz-detectbar__track" aria-hidden="true">
                <div className="fwiz-detectbar__fill" style={{ width: `${progress}%` }} />
            </div>
        </div>

        <div className="fwiz-pane--split fwiz-pane--paths">
            <div className="fwiz-pane__col">
                <p className="settings-subhead">Workspace &amp; game</p>
                <PathSettingItem setting={{
                    iconName: 'folder',
                    label: 'Default project folder',
                    badge: 'Workspace',
                    placeholder: p.flintHome || 'Where new mods will be created',
                    value: p.project,
                    onChange: p.onProject,
                    browseTitle: 'Where should new projects be created?',
                    hint: 'Where every new mod project gets created.',
                }} />
                <PathSettingItem setting={{
                    logoSrc: '/lol-logo.png',
                    logoColor: '#0AC8B9',
                    label: 'League of Legends',
                    badge: 'Live',
                    placeholder: 'C:\\Riot Games\\League of Legends',
                    value: p.league,
                    onChange: p.onLeague,
                    browseTitle: 'Select League of Legends Folder',
                    hint: 'Used for extraction, hash resolution and previews.',
                }} />
                <PathSettingItem setting={{
                    logoSrc: '/lol-logo.png',
                    logoColor: '#F0884F',
                    label: 'League of Legends PBE',
                    badge: 'Optional',
                    placeholder: 'C:\\Riot Games\\League of Legends (PBE)',
                    value: p.pbe,
                    onChange: p.onPbe,
                    browseTitle: 'Select PBE Folder',
                    hint: 'Lets Flint pull pre-release champion BINs and assets.',
                }} />
            </div>

            <div className="fwiz-pane__col">
                <p className="settings-subhead">Launcher</p>
                <LauncherPicker
                    ltk={p.ltk}
                    celestial={p.celestial}
                    preferred={p.preferredLauncher}
                    onPreferredChange={p.onPreferredLauncherChange}
                    onLtk={p.onLtk}
                    onCelestial={p.onCelestial}
                />
                <SettingsRow
                    icon={<Icon name="refresh" />}
                    title="Auto-sync to launcher"
                    sub={<span className="settings-row__sub" style={{ whiteSpace: 'normal' }}>
                        Push changes to your launcher automatically while you work.
                    </span>}
                    onActivate={() => p.onAutoSync(!p.autoSync)}
                    actions={<Checkbox toggle checked={p.autoSync} onChange={(e) => p.onAutoSync(e.target.checked)} />}
                />
            </div>

            {/* Editors span BOTH columns — it's a peer of Workspace and Launcher,
                not a child of either, and its two rows read better side by side. */}
            <div className="fwiz-pane__col fwiz-pane__col--full">
                <p className="settings-subhead">Editors</p>
                <div className={`fwiz-disclose ${p.editorsOpen ? 'is-open' : ''}`}>
                    <button type="button" className="fwiz-disclose__toggle" onClick={p.onEditorsToggle} aria-expanded={p.editorsOpen}>
                        <span className="fwiz-disclose__logos" aria-hidden="true">
                            <img src="/jade-logo.webp" alt="" draggable={false} />
                            <img src="/quartz-logo.webp" alt="" draggable={false} />
                        </span>
                        <span>
                            Jade &amp; Quartz{' '}
                            <span className="fwiz-disclose__sub">
                                {hasEditor ? '(detected)' : '(optional, not detected)'}
                            </span>
                        </span>
                        <svg className="fwiz-disclose__chev" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                            <path d="M4 6l4 4 4-4" stroke="currentColor" strokeWidth="1.5" strokeLinecap="round" strokeLinejoin="round" />
                        </svg>
                    </button>
                    {p.editorsOpen && (
                        <div className="fwiz-disclose__body fwiz-pane--split">
                            <PathSettingItem setting={{
                                logoSrc: '/jade-logo.webp',
                                logoColor: '#4ADE80',
                                label: 'Jade',
                                placeholder: 'Path to the Jade executable',
                                value: p.jade,
                                onChange: p.onJade,
                                browseTitle: 'Select Jade Executable',
                                hint: 'Opens BIN files with full hash resolution.',
                            }} />
                            <PathSettingItem setting={{
                                logoSrc: '/quartz-logo.webp',
                                logoColor: '#F8FAFC',
                                label: 'Quartz',
                                placeholder: 'Path to the Quartz executable',
                                value: p.quartz,
                                onChange: p.onQuartz,
                                browseTitle: 'Select Quartz Executable',
                                hint: 'VFX recolor & port editor, launched from the BIN preview.',
                            }} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    </div>
    );
};

/* -------------------------------------------------------------------------- */
/* Launcher picker — branded toggle between LTK Manager and Celestial         */
/* -------------------------------------------------------------------------- */
const LauncherPicker: React.FC<{
    ltk: string;
    celestial: string;
    preferred: 'ltk' | 'celestial' | null;
    onPreferredChange: (l: 'ltk' | 'celestial' | null) => void;
    onLtk: (v: string) => void;
    onCelestial: (v: string) => void;
}> = ({ ltk, celestial, preferred, onPreferredChange, onLtk, onCelestial }) => {
    const launchers = [
        {
            id: 'celestial' as const,
            name: 'Celestial',
            logo: '/celestial-logo.webp',
            color: '#A05CF6',
            tagline: "Divine Skins' all-in-one launcher.",
            value: celestial,
            onChange: onCelestial,
            browseTitle: 'Select Celestial Mod Folder',
            placeholder: 'Path to Celestial mod storage',
        },
        {
            id: 'ltk' as const,
            name: 'LTK Manager',
            logo: '/ltk-manager-logo.svg',
            color: '#22D3EE',
            tagline: "Open-source League toolkit's mod manager.",
            value: ltk,
            onChange: onLtk,
            browseTitle: 'Select LTK Manager Mod Folder',
            placeholder: 'Path to LTK Manager mod storage',
        },
    ];
    const effective = preferred ?? (celestial ? 'celestial' : ltk ? 'ltk' : 'celestial');
    const selected = launchers.find((l) => l.id === effective) ?? launchers[0];
    return (
        <div className="fwiz-settings__block">
            <p className="settings-subhead__note">
                Pick where “Sync to Launcher” drops your mods. Set both up and switch any time.
            </p>
            <div className="fwiz-launcher__grid">
                {launchers.map((l) => {
                    const active = effective === l.id;
                    const filled = l.value.trim().length > 0;
                    return (
                        <button
                            key={l.id}
                            type="button"
                            className={`fwiz-launcher__card ${active ? 'is-active' : ''}`}
                            style={{ ['--logo' as never]: l.color }}
                            onClick={() => onPreferredChange(l.id)}
                            aria-pressed={active}
                        >
                            <span className="fwiz-launcher__logo" aria-hidden="true">
                                <img src={l.logo} alt="" className="fwiz-launcher__logo-img" draggable={false} />
                            </span>
                            <span className="fwiz-launcher__meta">
                                <span className="fwiz-launcher__name">
                                    {l.name}
                                    {filled && <span className="fwiz-launcher__dot" aria-hidden="true" />}
                                </span>
                                <span className="fwiz-launcher__tag">{l.tagline}</span>
                            </span>
                            {active && <span className="fwiz-launcher__badge">Selected</span>}
                        </button>
                    );
                })}
            </div>
            <PathSettingItem setting={{
                logoSrc: selected.logo,
                logoColor: selected.color,
                label: `${selected.name} mod folder`,
                placeholder: selected.placeholder,
                value: selected.value,
                onChange: selected.onChange,
                browseTitle: selected.browseTitle,
            }} />
        </div>
    );
};

const FinishPane: React.FC<{
    creatorName: string;
    registerAssoc: boolean;
    onRegisterAssoc: (b: boolean) => void;
    autoUpdate: boolean;
    onAutoUpdate: (b: boolean) => void;
}> = ({
    creatorName,
    registerAssoc, onRegisterAssoc, autoUpdate, onAutoUpdate,
}) => {
    return (
        <div className="fwiz-finish">
            <div className="fwiz-finish__welcome">
                <h2 className="fwiz-finish__title">Welcome, {creatorName.trim() || 'Anonymous'}</h2>
                <p className="fwiz-finish__sub">
                    Everything is set. You can replay this tour from Settings at any time.
                </p>
            </div>

            <div className="fwiz-finish__panel">
                <div className="fwiz-finish__shortcuts">
                    <div><kbd>Ctrl</kbd>+<kbd>N</kbd><span>New mod</span></div>
                    <div><kbd>Ctrl</kbd>+<kbd>K</kbd><span>Command palette</span></div>
                    <div><kbd>Ctrl</kbd>+<kbd>,</kbd><span>Settings</span></div>
                </div>

                <a
                    className="fwiz-wiki"
                    href="https://wiki.divineskins.gg/"
                    onClick={(e) => { e.preventDefault(); openUrl('https://wiki.divineskins.gg/').catch(() => {}); }}
                >
                    <img className="fwiz-wiki__logo" src="/divine-logo.webp" alt="" draggable={false} />
                    <span className="fwiz-wiki__text">
                        <strong>New to modding? Read the Divine Skins wiki</strong>
                        <span>Guides that cover modding from the ground up. wiki.divineskins.gg</span>
                    </span>
                    <svg className="fwiz-wiki__arrow" viewBox="0 0 16 16" fill="none" aria-hidden="true">
                        <path d="M6 3l5 5-5 5" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round" />
                    </svg>
                </a>

            </div>

            <div className="fwiz-settings">
                <p className="settings-subhead">One last thing</p>
                <SettingsRow
                    icon={<Icon name="link" />}
                    title="Open Flint from Explorer"
                    sub={<span className="settings-row__sub" style={{ whiteSpace: 'normal' }}>
                        Adds Flint to the “Open with” menu for .wad, .bin, .tex, .fantome and more. Your default apps stay as they are.
                    </span>}
                    onActivate={() => onRegisterAssoc(!registerAssoc)}
                    actions={<Checkbox toggle checked={registerAssoc} onChange={(e) => onRegisterAssoc(e.target.checked)} />}
                />
                <SettingsRow
                    icon={<Icon name="download" />}
                    title="Automatic updates"
                    sub={<span className="settings-row__sub" style={{ whiteSpace: 'normal' }}>
                        Download and install updates before Flint opens.
                    </span>}
                    onActivate={() => onAutoUpdate(!autoUpdate)}
                    actions={<Checkbox toggle checked={autoUpdate} onChange={(e) => onAutoUpdate(e.target.checked)} />}
                />
            </div>
        </div>
    );
};
