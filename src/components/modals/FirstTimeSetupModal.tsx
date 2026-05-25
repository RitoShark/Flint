/**
 * Flint — First-Time Setup Wizard
 * --------------------------------
 * Full-screen onboarding flow with animated background, the real Flint
 * flame mark, and a multi-step wizard that captures the same data the
 * Settings → Paths tab does so the user lands ready to mod.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppState, useUxStore, useConfigStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { Button, Input, Icon, Textarea, type IconName } from '../ui';

type StepId = 'splash' | 'theme' | 'identity' | 'paths' | 'finish';

interface Step {
    id: StepId;
    title: string;
    subtitle: string;
    /** Compact label shown in the stepper rail. Empty = hidden. */
    short: string;
}

/* Splash is rendered as a full-bleed pre-step (no stepper, no nav). The
   visible stepper begins at Theme, so the user feels like step 1 of 4 starts
   *after* they hit "Get Started" — same pattern as celestial. */
const STEPS: Step[] = [
    { id: 'splash',   short: '',         title: '',                              subtitle: '' },
    { id: 'theme',    short: 'Theme',    title: 'Pick a vibe',                   subtitle: 'Choose an accent and surface style. Tweakable later in Settings.' },
    { id: 'identity', short: 'Identity', title: "Let's get acquainted",          subtitle: 'Your creator name is stamped into every mod you publish.' },
    { id: 'paths',    short: 'Paths',    title: 'Point Flint at your install',   subtitle: 'All optional — but each one unlocks a piece of the IDE.' },
    { id: 'finish',   short: 'Finish',   title: "You're all set",                subtitle: 'Time to make something. Welcome to the workshop.' },
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
    const config = useConfigStore();

    const [stepIndex, setStepIndex] = useState(0);
    const [direction, setDirection] = useState<1 | -1>(1);
    const [creatorName, setCreatorName] = useState('');
    const [creatorDescription, setCreatorDescription] = useState(state.creatorDescription || '');
    const [leaguePath, setLeaguePath] = useState(state.leaguePath || '');
    const [pbePath, setPbePath] = useState(state.leaguePathPbe || '');
    const [defaultProjectPath, setDefaultProjectPath] = useState(state.defaultProjectPath || '');
    const [ltkPath, setLtkPath] = useState(state.ltkManagerModPath || '');
    const [celestialPath, setCelestialPath] = useState(state.celestialModPath || '');
    const [preferredLauncher, setPreferredLauncher] = useState<'ltk' | 'celestial' | null>(state.preferredLauncher);
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

    /* Seed the 5 built-in preset themes on disk so the theme picker can bind
       to real `themes/<id>.json` files via the existing setSelectedTheme path. */
    useEffect(() => {
        if (!isVisible) return;
        api.seedBuiltinThemes().catch((err) => {
            console.warn('[Wizard] Failed to seed built-in themes:', err);
        });
    }, [isVisible]);

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

            // 3) Launchers — single IPC call probes both in parallel on the
            //    Rust side (and also fills jade/quartz which the modal
            //    surfaces elsewhere).
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
            // Pick a default launcher: prefer the existing choice; else first one we found.
            setPreferredLauncher((prev) => prev ?? (ltkFound ? 'ltk' : celFound ? 'celestial' : null));

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
                creatorDescription: creatorDescription.trim() || null,
                leaguePath: leaguePath || null,
                leaguePathPbe: pbePath || null,
                defaultProjectPath: defaultProjectPath || null,
                ltkManagerModPath: ltkPath || null,
                celestialModPath: celestialPath || null,
                preferredLauncher: preferredLauncher,
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

    /* Splash takes over the whole shell — no stepper, no nav, just the logo
       and a single CTA. Mirrors celestial's intro pattern. */
    if (step.id === 'splash') {
        return (
            <div className="fwiz" role="dialog" aria-modal="true" aria-label="First-time setup">
                <WizBackdrop />
                <WizTitleBar />
                <SplashPane onStart={advance} />
            </div>
        );
    }

    /* Real steps start at index 1 (Theme). Stepper excludes the splash. */
    const visibleSteps = STEPS.slice(1);
    const visibleIndex = stepIndex - 1;
    const visibleTotal = visibleSteps.length;

    return (
        <div className="fwiz" role="dialog" aria-modal="true" aria-label="First-time setup">
            <WizBackdrop />
            <WizTitleBar />
            <div className="fwiz__shell">
                <Stepper
                    steps={visibleSteps}
                    index={visibleIndex}
                    onJump={(i) => goToStep(i + 1)}
                />

                <main className={`fwiz__stage fwiz__stage--${direction > 0 ? 'fwd' : 'back'}`} key={step.id}>
                    <div className="fwiz__heading">
                        <h1>{step.title}</h1>
                        <p>{step.subtitle}</p>
                    </div>

                    <div className="fwiz__body">
                        {step.id === 'identity' && (
                            <IdentityPane
                                value={creatorName}
                                onChange={setCreatorName}
                                onKeyDown={onIdentityKey}
                                description={creatorDescription}
                                onDescriptionChange={setCreatorDescription}
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
                                flintHome={flintHome}
                                detectingAll={detectingAll}
                                onLeague={setLeaguePath}
                                onPbe={setPbePath}
                                onProject={setDefaultProjectPath}
                                onLtk={setLtkPath}
                                onCelestial={setCelestialPath}
                                onPreferredLauncherChange={setPreferredLauncher}
                                onBrowseLeague={() => browseDir('Select League of Legends Folder', setLeaguePath)}
                                onBrowsePbe={() => browseDir('Select PBE Folder', setPbePath)}
                                onBrowseProject={() => browseDir('Where should new projects be created?', setDefaultProjectPath)}
                                onBrowseLtk={() => browseDir('Select LTK Manager Mod Folder', setLtkPath)}
                                onBrowseCelestial={() => browseDir('Select Celestial Mod Folder', setCelestialPath)}
                                onDetectAll={detectAll}
                            />
                        )}
                        {step.id === 'theme' && (
                            <ThemePane
                                accent={accentChoice}
                                onAccent={setAccentChoice}
                                selectedTheme={config.selectedTheme}
                                onSelectTheme={(id) => config.setSelectedTheme(id)}
                                glass={glassChoice}
                                onGlass={setGlassChoice}
                            />
                        )}
                        {step.id === 'finish' && (
                            <FinishPane
                                creatorName={creatorName}
                                creatorDescription={creatorDescription}
                                leaguePath={leaguePath}
                                pbePath={pbePath}
                                projectPath={defaultProjectPath}
                                ltkPath={ltkPath}
                                celestialPath={celestialPath}
                                preferredLauncher={preferredLauncher}
                                accent={accentChoice}
                            />
                        )}
                    </div>
                </main>

                <footer className="fwiz__nav">
                    <Button variant="ghost" onClick={back} disabled={visibleIndex === 0}>
                        Back
                    </Button>
                    <div className="fwiz__nav-spacer" />
                    {/* Step counter — small, monospace, sits next to CTA */}
                    <span className="fwiz__nav-counter">
                        {String(visibleIndex + 1).padStart(2, '0')}<span> / {visibleTotal}</span>
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
/* Splash — logo-only intro that auto-advances with a smooth zoom-fade.       */
/* No CTA button — the splash plays itself and hands off to the wizard.       */
/* -------------------------------------------------------------------------- */
const SplashPane: React.FC<{ onStart: () => void }> = ({ onStart }) => {
    const [stage, setStage] = useState<'in' | 'hold' | 'out'>('in');
    useEffect(() => {
        const t1 = setTimeout(() => setStage('hold'), 1100);   // logo + text settled
        const t2 = setTimeout(() => setStage('out'),  3000);   // begin zoom-fade
        const t3 = setTimeout(() => onStart(),        3700);   // hand off when fade finishes
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
                {/* Single-tone silhouette flame — currentColor everywhere, with
                    the inner cut-out at lower alpha so it reads as depth rather
                    than a hole. No white core. */}
                <svg width="118" height="118" viewBox="0 0 24 24">
                    <path
                        d="M12 2C8.5 6 8 10 8 12c0 3.5 1.5 6 4 8 2.5-2 4-4.5 4-8 0-2-.5-6-4-10z"
                        fill="currentColor"
                    />
                    <path
                        d="M12 5c-2 3-2.5 5.5-2.5 7 0 2 .8 3.5 2.5 5 1.7-1.5 2.5-3 2.5-5 0-1.5-.5-4-2.5-7z"
                        fill="currentColor"
                        fillOpacity="0.55"
                    />
                </svg>
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

const IdentityPane: React.FC<{
    value: string;
    onChange: (v: string) => void;
    onKeyDown: (e: React.KeyboardEvent<HTMLInputElement>) => void;
    description: string;
    onDescriptionChange: (v: string) => void;
}> = ({ value, onChange, onKeyDown, description, onDescriptionChange }) => {
    const trimmed = value.trim();
    const trimmedDesc = description.trim();
    const initials = trimmed
        ? trimmed.split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || trimmed[0]?.toUpperCase()
        : '';
    return (
        <div className="fwiz-identity">
            <div className="fwiz-identity__form">
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
                    </p>
                </div>

                <div className="fwiz-field">
                    <label className="fwiz-field__label">
                        Default description
                        <span className="fwiz-field__chip">Optional</span>
                    </label>
                    <Textarea
                        placeholder="A tagline that pre-fills new mod projects (e.g. “Stylized recolors for Aatrox.”)"
                        value={description}
                        onChange={(e) => onDescriptionChange(e.target.value)}
                        rows={3}
                        maxLength={280}
                    />
                    <p className="fwiz-field__hint">
                        <span>Pre-fills the description on every new project — editable per-project later.</span>
                        <span className="fwiz-field__counter">{description.length}/280</span>
                    </p>
                </div>
            </div>

            <div className="fwiz-stamp" aria-hidden="true">
                <span className="fwiz-stamp__eyebrow">Live preview</span>
                <div className="fwiz-stamp__card">
                    <div className="fwiz-stamp__cover">
                        <span className="fwiz-stamp__cover-flame">
                            <svg viewBox="0 0 24 24" width="22" height="22" fill="currentColor">
                                <path d="M12 2C8.5 6 8 10 8 12c0 3.5 1.5 6 4 8 2.5-2 4-4.5 4-8 0-2-.5-6-4-10z" />
                            </svg>
                        </span>
                        <span className="fwiz-stamp__cover-tag">.modpkg</span>
                    </div>
                    <div className="fwiz-stamp__meta">
                        <div className="fwiz-stamp__avatar">{initials || '?'}</div>
                        <div className="fwiz-stamp__lines">
                            <strong>My First Mod</strong>
                            <span>by <em className={trimmed ? '' : 'is-empty'}>{trimmed || 'your name here'}</em></span>
                        </div>
                    </div>
                    <p className={`fwiz-stamp__desc ${trimmedDesc ? '' : 'is-empty'}`}>
                        {trimmedDesc || 'Your description will show up here.'}
                    </p>
                </div>
            </div>
        </div>
    );
};

interface PathRowProps {
    icon: IconName;
    /** Optional image asset path; when set, renders instead of the named Icon. */
    logoSrc?: string;
    /** Optional brand color for the logo frame glow + connected glow. */
    logoColor?: string;
    badge?: string;
    label: string;
    placeholder: string;
    value: string;
    onChange: (v: string) => void;
    onBrowse: () => void;
    onDetect?: () => void;
    detecting?: boolean;
    hint?: string;
}

const PathRow: React.FC<PathRowProps> = ({
    icon, logoSrc, logoColor, badge, label, placeholder, value, onChange, onBrowse, onDetect, detecting, hint,
}) => {
    const filled = value.trim().length > 0;
    const style = logoColor ? ({ ['--logo' as never]: logoColor } as React.CSSProperties) : undefined;
    return (
        <div
            className={`fwiz-prow ${filled ? 'is-filled' : ''} ${logoSrc ? 'has-logo' : ''}`}
            style={style}
        >
            <span className="fwiz-prow__icon" aria-hidden="true">
                {logoSrc
                    ? <img src={logoSrc} alt="" className="fwiz-prow__logo-img" draggable={false} />
                    : <Icon name={icon} />}
                {logoSrc && <span className="fwiz-prow__logo-ring" aria-hidden="true" />}
            </span>
            <div className="fwiz-prow__body">
                <div className="fwiz-prow__head">
                    <strong className="fwiz-prow__name">{label}</strong>
                    {badge && <span className="fwiz-prow__badge">{badge}</span>}
                    <span className={`fwiz-prow__pill ${filled ? 'is-on' : ''}`}>
                        <span className="fwiz-prow__pill-dot" />
                        {filled ? 'Connected' : 'Not set'}
                    </span>
                </div>
                {hint && <p className="fwiz-prow__tagline">{hint}</p>}
                {filled && (
                    <p className="fwiz-prow__path" title={value}>{value}</p>
                )}
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
                    {onDetect && (
                        <button
                            type="button"
                            className={`fwiz-iconbtn ${detecting ? 'is-busy' : ''}`}
                            onClick={onDetect}
                            disabled={detecting}
                            title="Auto-detect"
                            aria-label="Auto-detect"
                        >
                            <Icon name="search" />
                            <span>{detecting ? 'Scanning…' : 'Detect'}</span>
                        </button>
                    )}
                </div>
            </div>
        </div>
    );
};

const PathsPane: React.FC<{
    league: string; pbe: string; project: string; ltk: string; celestial: string;
    preferredLauncher: 'ltk' | 'celestial' | null;
    flintHome: string;
    detectingAll: boolean;
    onLeague: (v: string) => void;
    onPbe: (v: string) => void;
    onProject: (v: string) => void;
    onLtk: (v: string) => void;
    onCelestial: (v: string) => void;
    onPreferredLauncherChange: (l: 'ltk' | 'celestial' | null) => void;
    onBrowseLeague: () => void;
    onBrowsePbe: () => void;
    onBrowseProject: () => void;
    onBrowseLtk: () => void;
    onBrowseCelestial: () => void;
    onDetectAll: () => void;
}> = (p) => {
    const filledCount = [p.project, p.league, p.pbe, p.ltk || p.celestial].filter((v) => v.trim().length > 0).length;
    const progress = (filledCount / 4) * 100;
    return (
    <div className="fwiz-paths">
        {/* One global auto-detect — fills League, PBE, LTK Manager, and Celestial. */}
        <div className="fwiz-paths__bar">
            <div className="fwiz-paths__bar-text">
                <strong>Find everything for me</strong>
                <span>Scans your machine for League, PBE, LTK Manager and Celestial.</span>
                <div className="fwiz-paths__progress" aria-hidden="true">
                    <div className="fwiz-paths__progress-track">
                        <div className="fwiz-paths__progress-fill" style={{ width: `${progress}%` }} />
                    </div>
                    <span className="fwiz-paths__progress-label">{filledCount}/4 set</span>
                </div>
            </div>
            <button
                type="button"
                className={`fwiz-iconbtn fwiz-iconbtn--accent fwiz-iconbtn--lg ${p.detectingAll ? 'is-busy' : ''}`}
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
            logoSrc="/lol-logo.png"
            logoColor="#0AC8B9"
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
            logoSrc="/lol-logo.png"
            logoColor="#F0884F"
            label="League of Legends PBE"
            badge="Optional"
            placeholder="C:\Riot Games\League of Legends (PBE)"
            value={p.pbe}
            onChange={p.onPbe}
            onBrowse={p.onBrowsePbe}
            hint="Lets Flint pull pre-release champion BINs and assets."
        />

        {/* Launcher picker — LTK Manager or Celestial. The user can keep both
            paths set and swap their preferred sync target. */}
        <LauncherPicker
            ltk={p.ltk}
            celestial={p.celestial}
            preferred={p.preferredLauncher}
            onPreferredChange={p.onPreferredLauncherChange}
            onLtk={p.onLtk}
            onCelestial={p.onCelestial}
            onBrowseLtk={p.onBrowseLtk}
            onBrowseCelestial={p.onBrowseCelestial}
        />
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
    onBrowseLtk: () => void;
    onBrowseCelestial: () => void;
}> = ({ ltk, celestial, preferred, onPreferredChange, onLtk, onCelestial, onBrowseLtk, onBrowseCelestial }) => {
    const launchers = [
        {
            id: 'ltk' as const,
            name: 'LTK Manager',
            logo: '/ltk-manager-logo.svg',
            color: '#22D3EE',
            tagline: "Open-source League toolkit's mod manager.",
            value: ltk,
            onChange: onLtk,
            onBrowse: onBrowseLtk,
            placeholder: 'Path to LTK Manager mod storage',
        },
        {
            id: 'celestial' as const,
            name: 'Celestial',
            logo: '/celestial-logo.webp',
            color: '#A05CF6',
            tagline: "Divine Skins' all-in-one launcher.",
            value: celestial,
            onChange: onCelestial,
            onBrowse: onBrowseCelestial,
            placeholder: 'Path to Celestial mod storage',
        },
    ];
    const effective = preferred ?? (ltk ? 'ltk' : celestial ? 'celestial' : 'ltk');
    return (
        <div className="fwiz-launcher">
            <div className="fwiz-launcher__head">
                <div>
                    <strong>Launcher</strong>
                    <span>Pick where “Sync to Launcher” drops your mods. Configure both — switch any time.</span>
                </div>
            </div>
            <div className="fwiz-launcher__grid">
                {launchers.map((l) => {
                    const active = effective === l.id;
                    const filled = l.value.trim().length > 0;
                    return (
                        <button
                            key={l.id}
                            type="button"
                            className={`fwiz-launcher__card ${active ? 'is-active' : ''} ${filled ? 'is-filled' : ''}`}
                            style={{ ['--logo' as never]: l.color }}
                            onClick={() => onPreferredChange(l.id)}
                        >
                            <span className="fwiz-launcher__logo">
                                <img src={l.logo} alt="" className="fwiz-launcher__logo-img" draggable={false} />
                                <span className="fwiz-launcher__logo-ring" />
                            </span>
                            <span className="fwiz-launcher__meta">
                                <span className="fwiz-launcher__name">
                                    {l.name}
                                    {active && <span className="fwiz-launcher__badge">Selected</span>}
                                </span>
                                <span className="fwiz-launcher__tag">{l.tagline}</span>
                            </span>
                            {filled && <span className="fwiz-launcher__check"><Icon name="check" /></span>}
                        </button>
                    );
                })}
            </div>
            <div className="fwiz-launcher__editor">
                {launchers.map((l) => (
                    <div
                        key={l.id}
                        className={`fwiz-launcher__row ${effective === l.id ? 'is-visible' : ''}`}
                        hidden={effective !== l.id}
                    >
                        <input
                            type="text"
                            className="fwiz-input"
                            placeholder={l.placeholder}
                            value={l.value}
                            onChange={(e) => l.onChange(e.target.value)}
                        />
                        <button
                            type="button"
                            className="fwiz-iconbtn"
                            onClick={l.onBrowse}
                            title="Browse"
                        >
                            <Icon name="folder" />
                            <span>Browse</span>
                        </button>
                    </div>
                ))}
            </div>
        </div>
    );
};

/* The 5 built-in theme presets. Flint is the *default* — it lives in
   `index.css :root`, no JSON file exists for it. Picking the Flint card
   calls `setSelectedTheme(null)` which clears any override and lets the
   defaults take over. The other 4 bind to real `themes/<id>.json` files
   seeded by `seed_builtin_themes` in src-tauri settings.rs. */
type ThemePreset = { id: string | null; name: string; bg: string; raised: string; accent: string };
const THEME_PRESETS: ThemePreset[] = [
    { id: null,        name: 'Flint',     bg: '#0c0c10', raised: '#15151b', accent: '#EF4444' },
    { id: 'celestial', name: 'Celestial', bg: '#0a0a14', raised: '#13132a', accent: '#A05CF6' },
    { id: 'jade',      name: 'Jade',      bg: '#08111a', raised: '#0f1c28', accent: '#06B6D4' },
    { id: 'froggy',    name: 'Froggy',    bg: '#0a1410', raised: '#11241c', accent: '#22C55E' },
    { id: 'quartz',    name: 'Quartz',    bg: '#0f0a14', raised: '#1d1424', accent: '#EC4899' },
];

const ThemePane: React.FC<{
    accent: string;
    onAccent: (hex: string) => void;
    selectedTheme: string | null;
    onSelectTheme: (id: string | null) => void;
    glass: boolean;
    onGlass: (b: boolean) => void;
}> = ({ accent, onAccent, selectedTheme, onSelectTheme, glass, onGlass }) => {
    const activeThemePreset = THEME_PRESETS.find((p) => p.id === selectedTheme)
        ?? THEME_PRESETS.find((p) => p.accent.toLowerCase() === accent.toLowerCase());
    return (
        <div className="fwiz-theme">
            <div className="fwiz-theme__row">
                <div className="fwiz-theme__row-head">
                    <label className="fwiz-field__label">Theme presets</label>
                    {activeThemePreset && (
                        <span className="fwiz-theme__chip">
                            <span className="fwiz-theme__chip-dot" style={{ background: activeThemePreset.accent }} />
                            {activeThemePreset.name}
                        </span>
                    )}
                </div>
                <div className="fwiz-themecards">
                    {THEME_PRESETS.map((t) => {
                        const active = activeThemePreset?.id === t.id;
                        return (
                            <button
                                key={t.id ?? '__default__'}
                                type="button"
                                className={`fwiz-themecard ${active ? 'is-active' : ''}`}
                                style={{ ['--accent' as never]: t.accent, ['--bg' as never]: t.bg, ['--raised' as never]: t.raised }}
                                onClick={() => { onSelectTheme(t.id); onAccent(t.accent); }}
                                aria-pressed={active}
                            >
                                <span className="fwiz-themecard__mock">
                                    <span className="fwiz-themecard__mock-rail" />
                                    <span className="fwiz-themecard__mock-rows">
                                        <span className="fwiz-themecard__mock-row">
                                            <span className="fwiz-themecard__mock-tile" />
                                            <span className="fwiz-themecard__mock-tile fwiz-themecard__mock-tile--accent" />
                                        </span>
                                        <span className="fwiz-themecard__mock-row">
                                            <span className="fwiz-themecard__mock-tile fwiz-themecard__mock-tile--accent-soft" />
                                            <span className="fwiz-themecard__mock-tile" />
                                        </span>
                                    </span>
                                </span>
                                <span className="fwiz-themecard__foot">
                                    <span className="fwiz-themecard__name">{t.name}</span>
                                    <span className="fwiz-themecard__dots">
                                        <span className="fwiz-themecard__dot" style={{ background: t.bg }} />
                                        <span className="fwiz-themecard__dot" style={{ background: t.accent }} />
                                        {active && (
                                            <span className="fwiz-themecard__check" style={{ background: t.accent }}>
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
            <div className="fwiz-theme__preview" aria-hidden="true">
                <span className="fwiz-theme__preview-eyebrow">Live preview</span>
                <div className={`fwiz-theme__window ${glass ? 'is-glass' : 'is-solid'}`}>
                    <div className="fwiz-theme__window-bar">
                        <span /><span /><span />
                        <em>Mod Workshop</em>
                    </div>
                    <div className="fwiz-theme__window-body">
                        <div className="fwiz-theme__sidebar">
                            <span className="is-active">Project</span>
                            <span>Assets</span>
                            <span>Audio</span>
                            <span>Export</span>
                        </div>
                        <div className="fwiz-theme__content">
                            <div className="fwiz-theme__title-row">
                                <strong>Aatrox · Skin 12</strong>
                                <button type="button" className="fwiz-theme__cta">Ship it</button>
                            </div>
                            <div className="fwiz-theme__bars">
                                <div /><div /><div />
                            </div>
                        </div>
                    </div>
                </div>
            </div>
        </div>
    );
};

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
    creatorDescription: string;
    leaguePath: string;
    pbePath: string;
    projectPath: string;
    ltkPath: string;
    celestialPath: string;
    preferredLauncher: 'ltk' | 'celestial' | null;
    accent: string;
}> = ({ creatorName, creatorDescription, leaguePath, pbePath, projectPath, ltkPath, celestialPath, preferredLauncher, accent }) => {
    const desc = creatorDescription.trim();
    const initials = creatorName.trim()
        ? creatorName.trim().split(/\s+/).slice(0, 2).map((p) => p[0]?.toUpperCase() ?? '').join('') || creatorName.trim()[0]?.toUpperCase()
        : '?';
    const launcherLabel = preferredLauncher === 'celestial'
        ? `Celestial${celestialPath ? '' : ' (path missing)'}`
        : preferredLauncher === 'ltk'
            ? `LTK Manager${ltkPath ? '' : ' (path missing)'}`
            : (ltkPath ? 'LTK Manager' : celestialPath ? 'Celestial' : 'None set');
    const rows: { label: string; value: string; mono?: boolean }[] = [
        { label: 'Creator',        value: creatorName.trim() || '—' },
        { label: 'Launcher',       value: launcherLabel },
        { label: 'League',         value: leaguePath || 'Skipped',  mono: !!leaguePath },
    ];
    if (pbePath) rows.push({ label: 'PBE', value: pbePath, mono: true });
    if (projectPath) rows.push({ label: 'Workspace', value: projectPath, mono: true });
    if (desc) rows.push({ label: 'Description', value: desc });

    return (
        <div className="fwiz-finish">
            {/* Left — confirmed hero. Right — info grid. */}
            <div className="fwiz-finish__hero">
                <div className="fwiz-finish__halo" aria-hidden="true">
                    <div className="fwiz-finish__check">
                        <svg width="40" height="40" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="3" strokeLinecap="round" strokeLinejoin="round">
                            <polyline points="20 6 9 17 4 12" />
                        </svg>
                    </div>
                    {Array.from({ length: 14 }).map((_, i) => (
                        <span key={i} className="fwiz-finish__spark" style={{ '--n': i } as React.CSSProperties} />
                    ))}
                </div>
                <span className="fwiz-finish__eyebrow">Confirmed</span>
                <h2 className="fwiz-finish__title">{creatorName.trim() || 'Anonymous'}</h2>
                <p className="fwiz-finish__sub">
                    Workshop wired up. Hit <kbd>Ctrl</kbd>+<kbd>N</kbd> any time to spin up a mod.
                </p>
                <div className="fwiz-finish__avatar" style={{ ['--accent' as never]: accent }}>{initials}</div>
            </div>

            <div className="fwiz-finish__panel">
                <div className="fwiz-finish__panel-head">
                    <span className="fwiz-finish__panel-eyebrow">Setup summary</span>
                    <span className="fwiz-finish__panel-count">{rows.length} item{rows.length === 1 ? '' : 's'}</span>
                </div>
                <ul className="fwiz-finish__rows">
                    {rows.map((r) => (
                        <li key={r.label} className="fwiz-finish__row">
                            <span className="fwiz-finish__row-label">{r.label}</span>
                            <span className={`fwiz-finish__row-value ${r.mono ? 'is-mono' : ''}`} title={r.value}>{r.value}</span>
                        </li>
                    ))}
                </ul>
                <div className="fwiz-finish__shortcuts">
                    <div><kbd>Ctrl</kbd>+<kbd>N</kbd><span>New mod</span></div>
                    <div><kbd>Ctrl</kbd>+<kbd>,</kbd><span>Settings</span></div>
                    <div><kbd>Ctrl</kbd>+<kbd>K</kbd><span>Command palette</span></div>
                </div>
            </div>
        </div>
    );
};
