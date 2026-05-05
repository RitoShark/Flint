/**
 * Flint — First-Time Setup Wizard
 * --------------------------------
 * Full-screen onboarding flow with animated background, the real Flint
 * flame mark, and a multi-step wizard that captures the same data the
 * Settings → Paths tab does so the user lands ready to mod.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useUxStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Button, Input, Icon, type IconName } from '../ui';

type StepId = 'welcome' | 'identity' | 'paths' | 'theme' | 'finish';

interface Step {
    id: StepId;
    title: string;
    subtitle: string;
    /** Compact label shown in the stepper rail. */
    short: string;
}

const STEPS: Step[] = [
    { id: 'welcome',  short: 'Welcome',  title: 'Welcome to Flint',     subtitle: 'The League of Legends modding IDE — built for speed.' },
    { id: 'identity', short: 'Identity', title: "Who's modding?",       subtitle: 'A creator name shows up in every mod you ship.' },
    { id: 'paths',    short: 'Paths',    title: 'Tell Flint where things live', subtitle: 'Optional, but unlocks live previews and one-click sync.' },
    { id: 'theme',    short: 'Theme',    title: 'Make it yours',        subtitle: 'Pick an accent. Change everything later in Settings.' },
    { id: 'finish',   short: 'Finish',   title: "You're ready",         subtitle: 'Welcome to the workshop.' },
];

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

type DetectingState = boolean;

export const FirstTimeSetupModal: React.FC = () => {
    const { state, dispatch, closeModal, showToast } = useAppState();
    const ux = useUxStore();

    const [stepIndex, setStepIndex] = useState(0);
    const [direction, setDirection] = useState<1 | -1>(1);
    const [creatorName, setCreatorName] = useState('');
    const [leaguePath, setLeaguePath] = useState(state.leaguePath || '');
    const [pbePath, setPbePath] = useState(state.leaguePathPbe || '');
    const [defaultProjectPath, setDefaultProjectPath] = useState(state.defaultProjectPath || '');
    const [ltkPath, setLtkPath] = useState(state.ltkManagerModPath || '');
    const [detectingAll, setDetectingAll] = useState<DetectingState>(false);
    const [flintHome, setFlintHome] = useState<string>('');
    const [accentChoice, setAccentChoice] = useState<string>(ux.accentPrimary || ACCENT_PRESETS[0].hex);
    const [glassChoice, setGlassChoice] = useState<boolean>(ux.glassmorphism);

    const isVisible = state.activeModal === 'firstTimeSetup';
    const step = STEPS[stepIndex];
    const isLast = stepIndex === STEPS.length - 1;

    // Live-apply accent + glass so the user sees the choice on the wizard itself.
    useEffect(() => {
        if (!isVisible) return;
        ux.setAccentPrimary(accentChoice);
    }, [accentChoice, isVisible]); // eslint-disable-line react-hooks/exhaustive-deps

    useEffect(() => {
        if (!isVisible) return;
        ux.setGlassmorphism(glassChoice);
    }, [glassChoice, isVisible]); // eslint-disable-line react-hooks/exhaustive-deps

    const advance = () => { setDirection(1); setStepIndex((i) => Math.min(STEPS.length - 1, i + 1)); };
    const back    = () => { setDirection(-1); setStepIndex((i) => Math.max(0, i - 1)); };

    /* Resolve Flint's app-home folder once and use it as the default project
       path placeholder if the user hasn't set one. Lets the user see exactly
       where their mods will land before they hit Continue. */
    useEffect(() => {
        if (!isVisible || flintHome) return;
        api.getAppHome().then((home) => {
            const sep = home.includes('\\') ? '\\' : '/';
            const guess = `${home.replace(/[\\/]+$/, '')}${sep}projects`;
            setFlintHome(guess);
            // Pre-fill the project path field if the user hasn't set one yet.
            setDefaultProjectPath((prev) => prev || guess);
        }).catch(() => { /* non-fatal */ });
    }, [isVisible, flintHome]);

    /* ONE global "Auto-detect everything" — fires League, PBE (parented to the
       newly-detected live install), and LTK Manager in parallel. Shows a
       single combined toast at the end. */
    const detectAll = async () => {
        setDetectingAll(true);
        const results: string[] = [];
        const failures: string[] = [];
        try {
            // 1) League first — needed to seed PBE candidates
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

            // 2) PBE next to whichever League path we know about
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

            // 3) LTK Manager mod folder
            try {
                const ltk = await api.getLtkManagerModPath();
                if (ltk) {
                    setLtkPath(ltk);
                    results.push('LTK Manager');
                } else {
                    failures.push('LTK Manager');
                }
            } catch { failures.push('LTK Manager'); }

            if (results.length === 0) {
                showToast('warning', 'Nothing was auto-detected — fill paths manually.');
            } else if (failures.length === 0) {
                showToast('success', `Detected ${results.join(', ')}.`);
            } else {
                showToast('info', `Found ${results.join(', ')}. Couldn't find ${failures.join(', ')}.`);
            }
        } finally {
            setDetectingAll(false);
        }
    };

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

        // Persist paths via the legacy SET_STATE bridge — same wiring SettingsModal uses.
        dispatch({
            type: 'SET_STATE',
            payload: {
                creatorName: creatorName.trim(),
                leaguePath: leaguePath || null,
                leaguePathPbe: pbePath || null,
                defaultProjectPath: defaultProjectPath || null,
                ltkManagerModPath: ltkPath || null,
            },
        });

        closeModal();
        showToast('success', 'Setup complete — welcome to Flint.');
    };

    const onIdentityKey = (e: React.KeyboardEvent<HTMLInputElement>) => {
        if (e.key === 'Enter' && creatorName.trim()) advance();
    };

    const canAdvance = useMemo(() => {
        if (step.id === 'identity') return creatorName.trim().length > 0;
        return true;
    }, [step.id, creatorName]);

    if (!isVisible) return null;

    /* Stepper navigation: let users jump back to any visited step (current or
       earlier). Going forward stays gated by the Continue button so we don't
       skip required validation. */
    const goToStep = (i: number) => {
        if (i > stepIndex) return;
        setDirection(i > stepIndex ? 1 : -1);
        setStepIndex(i);
    };

    return (
        <div className="fwiz" role="dialog" aria-modal="true" aria-label="First-time setup">
            <WizBackdrop />
            <WizTitleBar />
            <div className="fwiz__shell">
                <Stepper steps={STEPS} index={stepIndex} onJump={goToStep} />

                <main className={`fwiz__stage fwiz__stage--${direction > 0 ? 'fwd' : 'back'}`} key={step.id}>
                    <div className="fwiz__heading">
                        <h1>{step.title}</h1>
                        <p>{step.subtitle}</p>
                    </div>

                    <div className="fwiz__body">
                        {step.id === 'welcome' && <WelcomePane />}
                        {step.id === 'identity' && (
                            <IdentityPane
                                value={creatorName}
                                onChange={setCreatorName}
                                onKeyDown={onIdentityKey}
                            />
                        )}
                        {step.id === 'paths' && (
                            <PathsPane
                                league={leaguePath}
                                pbe={pbePath}
                                project={defaultProjectPath}
                                ltk={ltkPath}
                                flintHome={flintHome}
                                detectingAll={detectingAll}
                                onLeague={setLeaguePath}
                                onPbe={setPbePath}
                                onProject={setDefaultProjectPath}
                                onLtk={setLtkPath}
                                onBrowseLeague={() => browseDir('Select League of Legends Folder', setLeaguePath)}
                                onBrowsePbe={() => browseDir('Select PBE Folder', setPbePath)}
                                onBrowseProject={() => browseDir('Where should new projects be created?', setDefaultProjectPath)}
                                onBrowseLtk={() => browseDir('Select LTK Manager Mod Folder', setLtkPath)}
                                onDetectAll={detectAll}
                            />
                        )}
                        {step.id === 'theme' && (
                            <ThemePane
                                accent={accentChoice}
                                onAccent={setAccentChoice}
                                glass={glassChoice}
                                onGlass={setGlassChoice}
                            />
                        )}
                        {step.id === 'finish' && (
                            <FinishPane
                                creatorName={creatorName}
                                leaguePath={leaguePath}
                                pbePath={pbePath}
                                projectPath={defaultProjectPath}
                            />
                        )}
                    </div>
                </main>

                <footer className="fwiz__nav">
                    <Button variant="ghost" onClick={back} disabled={stepIndex === 0}>
                        Back
                    </Button>
                    <div className="fwiz__nav-spacer" />
                    {/* Step counter — small, monospace, sits next to CTA */}
                    <span className="fwiz__nav-counter">
                        {String(stepIndex + 1).padStart(2, '0')}<span> / {STEPS.length}</span>
                    </span>
                    {isLast ? (
                        <Button variant="success" size="lg" icon="success" onClick={handleFinish} className="fwiz__cta">
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
                        <svg width="18" height="18" viewBox="0 0 24 24" fill="currentColor">
                            <path d="M12 2C8.5 6 8 10 8 12c0 3.5 1.5 6 4 8 2.5-2 4-4.5 4-8 0-2-.5-6-4-10z" />
                            <path
                                d="M12 5c-2 3-2.5 5.5-2.5 7 0 2 .8 3.5 2.5 5 1.7-1.5 2.5-3 2.5-5 0-1.5-.5-4-2.5-7z"
                                fill="var(--bg-primary)"
                            />
                            <path d="M12 8c-1 1.5-1.5 3-1.5 4 0 1.2.5 2.2 1.5 3 1-.8 1.5-1.8 1.5-3 0-1-.5-2.5-1.5-4z" />
                        </svg>
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
/* Stepper rail                                                                */
/* -------------------------------------------------------------------------- */
const Stepper: React.FC<{
    steps: Step[];
    index: number;
    onJump: (i: number) => void;
}> = ({ steps, index, onJump }) => (
    <ol className="fwiz-step">
        {steps.map((s, i) => {
            const reachable = i <= index;
            return (
                <li key={s.id}>
                    <button
                        type="button"
                        className={`fwiz-step__item ${i === index ? 'is-active' : ''} ${i < index ? 'is-done' : ''} ${reachable ? '' : 'is-locked'}`}
                        onClick={() => onJump(i)}
                        disabled={!reachable}
                        aria-current={i === index ? 'step' : undefined}
                    >
                        <span className="fwiz-step__dot">
                            {i < index ? (
                                <svg width="12" height="12" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                                    <polyline points="20 6 9 17 4 12" />
                                </svg>
                            ) : (
                                i + 1
                            )}
                        </span>
                        <span className="fwiz-step__label">{s.short}</span>
                    </button>
                </li>
            );
        })}
    </ol>
);

/* -------------------------------------------------------------------------- */
/* Step panes                                                                  */
/* -------------------------------------------------------------------------- */
const FEATURES: { icon: IconName; label: string; desc: string }[] = [
    { icon: 'wad',     label: 'WAD extraction', desc: 'Browse and extract any League archive instantly.' },
    { icon: 'bin',     label: 'BIN editing',    desc: 'Live ritobin editor with hash resolution.' },
    { icon: 'picture', label: 'Live preview',   desc: 'Textures, models, and audio without leaving Flint.' },
    { icon: 'export',  label: 'One-click ship', desc: 'Pack to .fantome / .modpkg or sync to LTK Manager.' },
];

const WelcomePane: React.FC = () => (
    <div className="fwiz-welcome">
        {FEATURES.map((f) => (
            <div className="fwiz-pill" key={f.label}>
                <span className="fwiz-pill__ic"><Icon name={f.icon} /></span>
                <div className="fwiz-pill__txt">
                    <strong>{f.label}</strong>
                    <span>{f.desc}</span>
                </div>
            </div>
        ))}
    </div>
);

const IdentityPane: React.FC<{
    value: string;
    onChange: (v: string) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
}> = ({ value, onChange, onKeyDown }) => (
    <div className="fwiz-field">
        <label className="fwiz-field__label">Your creator name</label>
        <Input
            placeholder="e.g. SirDexal"
            value={value}
            onChange={(e) => onChange(e.target.value)}
            onKeyDown={onKeyDown}
            autoFocus
        />
        <p className="fwiz-field__hint">
            Stamped into every mod you ship — proper credit, automatically.
            Press <kbd>Enter</kbd> to continue.
        </p>
    </div>
);

interface PathRowProps {
    icon: IconName;
    badge?: string;
    label: string;
    placeholder: string;
    value: string;
    onChange: (v: string) => void;
    onBrowse: () => void;
    hint?: string;
}

const PathRow: React.FC<PathRowProps> = ({
    icon, badge, label, placeholder, value, onChange, onBrowse, hint,
}) => (
    <div className="fwiz-prow">
        <span className="fwiz-prow__icon" aria-hidden="true">
            <Icon name={icon} />
        </span>
        <div className="fwiz-prow__body">
            <div className="fwiz-prow__head">
                <span className="fwiz-prow__label">{label}</span>
                {badge && <span className="fwiz-prow__badge">{badge}</span>}
                {hint && <span className="fwiz-prow__hint">{hint}</span>}
            </div>
            <div className="fwiz-prow__field">
                <input
                    type="text"
                    className="fwiz-input"
                    placeholder={placeholder}
                    value={value}
                    onChange={(e) => onChange(e.target.value)}
                />
                <button
                    type="button"
                    className="fwiz-iconbtn"
                    onClick={onBrowse}
                    title="Browse"
                    aria-label="Browse for folder"
                >
                    <Icon name="folder" />
                    <span>Browse</span>
                </button>
            </div>
        </div>
    </div>
);

const PathsPane: React.FC<{
    league: string; pbe: string; project: string; ltk: string;
    flintHome: string;
    detectingAll: boolean;
    onLeague: (v: string) => void;
    onPbe: (v: string) => void;
    onProject: (v: string) => void;
    onLtk: (v: string) => void;
    onBrowseLeague: () => void;
    onBrowsePbe: () => void;
    onBrowseProject: () => void;
    onBrowseLtk: () => void;
    onDetectAll: () => void;
}> = (p) => (
    <div className="fwiz-paths">
        {/* One global auto-detect — fills League, PBE, and LTK in one shot. */}
        <div className="fwiz-paths__bar">
            <div className="fwiz-paths__bar-text">
                <strong>Find everything for me</strong>
                <span>Scans your machine for League, PBE, and LTK Manager.</span>
            </div>
            <button
                type="button"
                className="fwiz-iconbtn fwiz-iconbtn--accent fwiz-iconbtn--lg"
                onClick={p.onDetectAll}
                disabled={p.detectingAll}
            >
                <Icon name="search" />
                <span>{p.detectingAll ? 'Scanning…' : 'Auto-detect everything'}</span>
            </button>
        </div>

        <PathRow
            icon="folder"
            label="Default project folder"
            badge="Workspace"
            placeholder={p.flintHome || 'Where new mods will be created'}
            value={p.project}
            onChange={p.onProject}
            onBrowse={p.onBrowseProject}
            hint="Where every new mod project gets created."
        />
        <PathRow
            icon="folder"
            label="League of Legends"
            badge="Live"
            placeholder="C:\Riot Games\League of Legends"
            value={p.league}
            onChange={p.onLeague}
            onBrowse={p.onBrowseLeague}
            hint="Powers in-game tooling, hash resolution, and previews."
        />
        <PathRow
            icon="folder"
            label="League of Legends PBE"
            badge="Optional"
            placeholder="C:\Riot Games\League of Legends (PBE)"
            value={p.pbe}
            onChange={p.onPbe}
            onBrowse={p.onBrowsePbe}
            hint="Lets Flint pull pre-release champion BINs and assets."
        />
        <PathRow
            icon="package"
            label="LTK Manager"
            badge="Launcher"
            placeholder="Path to LTK Manager mod storage"
            value={p.ltk}
            onChange={p.onLtk}
            onBrowse={p.onBrowseLtk}
            hint="Required for one-click 'Sync to Launcher' from the top bar."
        />
    </div>
);

const ThemePane: React.FC<{
    accent: string;
    onAccent: (hex: string) => void;
    glass: boolean;
    onGlass: (b: boolean) => void;
}> = ({ accent, onAccent, glass, onGlass }) => (
    <div className="fwiz-theme">
        <div className="fwiz-theme__row">
            <label className="fwiz-field__label">Accent color</label>
            <div className="fwiz-swatches">
                {ACCENT_PRESETS.map((p) => (
                    <button
                        key={p.hex}
                        type="button"
                        className={`fwiz-swatch ${accent === p.hex ? 'is-active' : ''}`}
                        style={{ background: p.hex, color: p.hex }}
                        onClick={() => onAccent(p.hex)}
                        title={p.name}
                        aria-label={p.name}
                    />
                ))}
                <label className="fwiz-swatch fwiz-swatch--custom" title="Custom">
                    <input
                        type="color"
                        value={accent}
                        onChange={(e) => onAccent(e.target.value.toUpperCase())}
                    />
                    <span>+</span>
                </label>
            </div>
        </div>
        <div className="fwiz-theme__row">
            <label className="fwiz-field__label">Surface style</label>
            <div className="fwiz-toggle-cards">
                <ToggleCard
                    active={glass}
                    onClick={() => onGlass(true)}
                    title="Glass"
                    desc="Frosted, blurred surfaces. Best on modern GPUs."
                    sample="glass"
                />
                <ToggleCard
                    active={!glass}
                    onClick={() => onGlass(false)}
                    title="Solid"
                    desc="Flat, opaque surfaces. Cheapest to render."
                    sample="solid"
                />
            </div>
        </div>
    </div>
);

const ToggleCard: React.FC<{
    active: boolean;
    onClick: () => void;
    title: string;
    desc: string;
    sample: 'glass' | 'solid';
}> = ({ active, onClick, title, desc, sample }) => (
    <button
        type="button"
        className={`fwiz-tcard fwiz-tcard--${sample} ${active ? 'is-active' : ''}`}
        onClick={onClick}
    >
        <span className={`fwiz-tcard__sample fwiz-tcard__sample--${sample}`} aria-hidden="true" />
        <span className="fwiz-tcard__title">{title}</span>
        <span className="fwiz-tcard__desc">{desc}</span>
    </button>
);

const FinishPane: React.FC<{
    creatorName: string;
    leaguePath: string;
    pbePath: string;
    projectPath: string;
}> = ({ creatorName, leaguePath, pbePath, projectPath }) => (
    <div className="fwiz-finish">
        <div className="fwiz-finish__check" aria-hidden="true">
            <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                <polyline points="20 6 9 17 4 12" />
            </svg>
        </div>
        <ul className="fwiz-finish__list">
            <li><span>Creator</span><strong>{creatorName || '—'}</strong></li>
            <li><span>League</span><strong>{leaguePath || 'Skipped'}</strong></li>
            {pbePath && <li><span>PBE</span><strong>{pbePath}</strong></li>}
            {projectPath && <li><span>Project folder</span><strong>{projectPath}</strong></li>}
        </ul>
        <p className="fwiz-finish__cta">
            Press <kbd>Ctrl</kbd>+<kbd>N</kbd> to spin up your first mod.
        </p>
    </div>
);
