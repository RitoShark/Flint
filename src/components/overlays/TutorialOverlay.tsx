/**
 * Flint - First-run tutorial overlay
 */

import React, { useState, useEffect, useRef } from 'react';
import { useAppState } from '../../lib/stores';
import type { ModalType } from '../../lib/types';

const ONBOARDING_KEY = 'flint_onboarding_done';
export function isOnboardingDone(): boolean { return localStorage.getItem(ONBOARDING_KEY) === 'true'; }
export function markOnboardingDone(): void { localStorage.setItem(ONBOARDING_KEY, 'true'); }

/** Custom DOM event the Settings dev tab fires to replay the tutorial.
 *  App.tsx listens and flips `showTutorial` on. We also wipe the
 *  onboarding flag first so any re-entry triggers fire normally next
 *  session if needed. */
export const TUTORIAL_REPLAY_EVENT = 'flint:tutorial:replay';
export function triggerTutorialReplay(): void {
    try { localStorage.removeItem(ONBOARDING_KEY); } catch { /* ignore */ }
    window.dispatchEvent(new CustomEvent(TUTORIAL_REPLAY_EVENT));
}

interface Step {
    title: string;
    body: string;
    selector?: string;
    placement?: 'below' | 'below-end';
    modal?: ModalType;
    /** ms delay before starting element polling (let modals finish animating) */
    delay?: number;
    /** called when entering this step in either direction */
    onEnter?: () => void;
    /** require the first <img> inside the spotted element to be fully loaded */
    waitForImage?: boolean;
}

/** Click selector as soon as it appears, retrying up to maxTries × intervalMs. */
function clickWhenReady(selector: string, maxTries = 50, intervalMs = 150): void {
    let tries = 0;
    const attempt = () => {
        const el = document.querySelector<HTMLElement>(selector);
        if (el) { el.click(); return; }
        if (++tries < maxTries) setTimeout(attempt, intervalMs);
    };
    attempt();
}

const STEPS: Step[] = [
    {
        title: 'Welcome to Flint!',
        body: "Flint is a League of Legends asset extractor and modding IDE — extraction, path rewriting, and mod packaging all in one place. Let's take a quick look around.",
    },
    {
        title: 'Create a Mod Project',
        body: "Click here to start a new mod. We'll walk through the creation flow so you know exactly what to expect.",
        selector: '.welcome__column--left .btn--primary',
        placement: 'below',
    },
    {
        title: 'Pick a Project Type',
        body: 'Choose between a champion skin mod, an animated loading screen, or a HUD editor. Skin mods are the most common starting point.',
        selector: '.np-type-selector',
        placement: 'below',
        modal: 'newProject',
        delay: 280, // wait for modal CSS transition (200ms) + buffer
    },
    {
        title: 'Select a Champion',
        body: "Browse or search the full champion roster. We'll auto-pick Aatrox to show you what happens after selection.",
        selector: '.np-champion-grid',
        placement: 'below',
        modal: 'newProject',
        delay: 100,
    },
    {
        title: 'Champion Splash Art',
        body: "After picking a champion, their splash art appears here. The pencil icon in the top-right opens the skin picker so you can choose which skin slot to base your mod on.",
        selector: '.np-hero-splash',
        placement: 'below',
        modal: 'newProject',
        // Wait for modal (if re-entering from a non-modal step) + Aatrox skins API call
        delay: 350,
        waitForImage: true, // only spotlight once the splash image has actually loaded
        onEnter: () => {
            // Close skin picker overlay if it was left open (backward nav from step 5)
            const overlay = document.querySelector<HTMLElement>('.np-skin-picker-overlay');
            if (overlay) overlay.click();
            // Select Aatrox — retries handle both "champions still loading" and "already selected" cases
            clickWhenReady('.np-champ-card[title="Aatrox"]');
        },
    },
    {
        title: 'Skin Slot Selection',
        body: "Every skin for this champion is listed here. Skin 0 is the base look, higher numbers are alternates — legendaries, prestige editions, etc. Pick one and it becomes your mod's starting point.",
        selector: '.np-skin-picker',
        placement: 'below',
        modal: 'newProject',
        delay: 300,
        onEnter: () => {
            // Need: Aatrox selected → splash visible → pencil button exists
            // Works in both directions; if splash is already there we click immediately.
            const tryOpenPicker = (tries = 0) => {
                const editBtn = document.querySelector<HTMLElement>('.np-hero-splash__edit');
                if (editBtn) { editBtn.click(); return; }

                const aatrox = document.querySelector<HTMLElement>('.np-champ-card[title="Aatrox"]');
                if (aatrox && tries === 0) aatrox.click(); // ensure Aatrox is selected

                if (tries < 40) setTimeout(() => tryOpenPicker(tries + 1), 200);
            };
            setTimeout(() => tryOpenPicker(), 0);
        },
    },
    {
        title: 'Open or Import a Project',
        body: 'Load a project you have worked on before, or import a .fantome / .modpkg file from another tool. Recent projects appear below for quick access.',
        selector: '.welcome__column--left .btn--secondary',
        placement: 'below',
    },
    {
        title: 'Browse Raw Game Files',
        body: 'Open WAD archives straight from your League install to extract individual assets — no project needed. Great for hunting down specific textures or meshes.',
        selector: '.welcome__column--right .welcome__actions',
        placement: 'below',
    },
    {
        title: 'Fix Skin Tool',
        body: "Having issues in-game? The wrench scans your skin files and automatically patches the most common problems like broken particle links or missing animations.",
        selector: '.titlebar__button--fix',
        placement: 'below-end',
    },
    {
        title: 'Settings',
        body: 'Configure your League path, pick a UI theme, set up Jade / Quartz BIN tools, and manage LTK Manager integration for one-click mod installs.',
        selector: '.titlebar__button--settings',
        placement: 'below-end',
    },
    {
        title: "You're all set!",
        body: 'Start with "Create New Project" to build your first mod. You can replay this tour from Settings → General at any time.',
    },
];

const CALLOUT_W = 360;
const CALLOUT_H_EST = 280;
const GAP = 18;
const EDGE = 14;

interface Spot { x: number; y: number; w: number; h: number; }

/** Pad small elements gently so the highlight doesn't dwarf a 14px icon. */
function paddingFor(w: number, h: number): number {
    const min = Math.min(w, h);
    if (min <= 24) return 3;   // titlebar icons, small chips
    if (min <= 48) return 5;   // small buttons
    return 8;                  // panels, grids, splash art
}

function clampToViewport(s: Spot, vpW: number, vpH: number): Spot {
    const x = Math.max(0, s.x);
    const y = Math.max(0, s.y);
    const w = Math.min(s.w, vpW - x);
    const h = Math.min(s.h, vpH - y);
    return { x, y, w, h };
}

function queryRect(selector: string, waitForImage: boolean): Spot | null {
    const el = document.querySelector(selector);
    if (!el) return null;
    const r = el.getBoundingClientRect();
    if (r.width === 0 || r.height === 0) return null;
    if (waitForImage) {
        const img = el.querySelector<HTMLImageElement>('img');
        if (img && !img.complete) return null;
    }
    const p = paddingFor(r.width, r.height);
    return { x: r.left - p, y: r.top - p, w: r.width + p * 2, h: r.height + p * 2 };
}

/** Two rects are equal enough that the element has finished moving/scaling. */
function rectsMatch(a: Spot, b: Spot): boolean {
    return Math.abs(a.x - b.x) < 0.5
        && Math.abs(a.y - b.y) < 0.5
        && Math.abs(a.w - b.w) < 0.5
        && Math.abs(a.h - b.h) < 0.5;
}

/** Always returns pixel coords so CSS `transition: top, left` works across all steps. */
function buildCalloutStyle(
    spot: Spot | null,
    placement: Step['placement'],
    vpW: number,
    vpH: number,
): React.CSSProperties {
    if (!spot) {
        return {
            position: 'fixed',
            top: Math.round((vpH - CALLOUT_H_EST) / 2),
            left: Math.round((vpW - CALLOUT_W) / 2),
            width: CALLOUT_W,
        };
    }
    let left = placement === 'below-end'
        ? spot.x + spot.w - CALLOUT_W
        : spot.x + spot.w / 2 - CALLOUT_W / 2;
    left = Math.max(EDGE, Math.min(vpW - CALLOUT_W - EDGE, left));

    const belowTop = spot.y + spot.h + GAP;
    const top = belowTop + CALLOUT_H_EST <= vpH - EDGE
        ? belowTop
        : Math.max(EDGE, spot.y - CALLOUT_H_EST - GAP);

    return { position: 'fixed', top, left, width: CALLOUT_W };
}

interface Props { onDone: () => void; }

export const TutorialOverlay: React.FC<Props> = ({ onDone }) => {
    const { openModal, closeModal } = useAppState();
    const [idx, setIdx] = useState(0);
    const [spot, setSpot] = useState<Spot | null>(null);
    const [vpW, setVpW] = useState(window.innerWidth);
    const [vpH, setVpH] = useState(window.innerHeight);

    const idxRef = useRef(0);
    const spotTimerRef = useRef<ReturnType<typeof setTimeout>>();
    const enterTimerRef = useRef<ReturnType<typeof setTimeout>>();

    const step = STEPS[idx];

    // Viewport size tracking
    useEffect(() => {
        const onResize = () => { setVpW(window.innerWidth); setVpH(window.innerHeight); };
        window.addEventListener('resize', onResize);
        return () => window.removeEventListener('resize', onResize);
    }, []);

    // Spotlight polling — starts after step.delay, then waits for the element
    // to stop moving/scaling (two consecutive samples must match) before
    // committing the highlight. Fixes the "modal still scaling in" jitter where
    // the spotlight would lock onto a 95%-scaled rect.
    useEffect(() => {
        clearTimeout(spotTimerRef.current);
        setSpot(null);
        if (!step.selector) return;

        let tries = 0;
        let prev: Spot | null = null;
        const waitImg = step.waitForImage ?? false;
        const tryFind = () => {
            const r = queryRect(step.selector!, waitImg);
            if (r) {
                if (prev && rectsMatch(prev, r)) {
                    setSpot(clampToViewport(r, window.innerWidth, window.innerHeight));
                    return;
                }
                prev = r;
            } else {
                prev = null;
            }
            if (++tries < 120) spotTimerRef.current = setTimeout(tryFind, 80);
        };
        spotTimerRef.current = setTimeout(tryFind, step.delay ?? 0);
        return () => clearTimeout(spotTimerRef.current);
    }, [idx, step.selector, step.delay, step.waitForImage]);

    // onEnter action — fires after the step's delay (handles both forward + backward nav)
    useEffect(() => {
        clearTimeout(enterTimerRef.current);
        if (!step.onEnter) return;
        enterTimerRef.current = setTimeout(step.onEnter, step.delay ?? 0);
        return () => clearTimeout(enterTimerRef.current);
    }, [idx]); // eslint-disable-line react-hooks/exhaustive-deps

    // Cleanup on unmount
    useEffect(() => {
        return () => {
            clearTimeout(spotTimerRef.current);
            clearTimeout(enterTimerRef.current);
            if (STEPS[idxRef.current]?.modal) closeModal();
        };
    }, []); // eslint-disable-line react-hooks/exhaustive-deps

    const transitionTo = (newIdx: number) => {
        const leavingModal = STEPS[idx].modal;
        const enteringModal = STEPS[newIdx].modal;
        if (enteringModal !== leavingModal) {
            if (leavingModal) closeModal();
            if (enteringModal) openModal(enteringModal);
        }
        idxRef.current = newIdx;
        setIdx(newIdx);
    };

    const finish = () => {
        clearTimeout(spotTimerRef.current);
        clearTimeout(enterTimerRef.current);
        if (step.modal) closeModal();
        markOnboardingDone();
        onDone();
    };

    const next = () => idx < STEPS.length - 1 ? transitionTo(idx + 1) : finish();
    const prev = () => idx > 0 && transitionTo(idx - 1);
    const isLast = idx === STEPS.length - 1;

    const cs = buildCalloutStyle(spot, step.placement, vpW, vpH);

    return (
        <div className="tutorial-overlay">
            {/* Full-screen event blocker sits behind the callout */}
            <div className="tutorial-overlay__blocker" />

            {/*
             * Spotlight: a transparent <div> whose box-shadow covers the entire
             * viewport with the dark overlay. Because the dark area and the
             * spotlight hole are ONE element, transitioning top/left/width/height
             * keeps them perfectly in sync — no SVG mask desync.
             * The ::after pseudo-element provides the animated blue ring.
             */}
            <div
                className={`tutorial-spotlight${!spot ? ' tutorial-spotlight--empty' : ''}`}
                style={{
                    top:    spot?.y ?? Math.round(vpH / 2),
                    left:   spot?.x ?? Math.round(vpW / 2),
                    width:  spot?.w ?? 0,
                    height: spot?.h ?? 0,
                }}
            />

            {/* Callout — slides to new position via CSS transition.
                Inner content has `key={idx}` so the fade/slide animation
                replays when stepping forward/back. */}
            <div className="tutorial-callout" style={cs}>
                <div className="tutorial-callout__header">
                    <span className="tutorial-callout__badge">
                        <svg viewBox="0 0 16 16" fill="currentColor" aria-hidden="true">
                            <path d="M8 1.2l1.6 4.6 4.6.6-3.5 3 1.1 4.6L8 11.7l-3.8 2.3 1.1-4.6L1.8 6.4l4.6-.6L8 1.2z" />
                        </svg>
                        Tour
                    </span>
                    <span className="tutorial-callout__counter">
                        <strong>{idx + 1}</strong> / {STEPS.length}
                    </span>
                </div>

                {/* Progress bar — fills with each forward step */}
                <div className="tutorial-callout__progress" aria-hidden="true">
                    <div
                        className="tutorial-callout__progress-fill"
                        style={{ width: `${((idx + 1) / STEPS.length) * 100}%` }}
                    />
                </div>

                {/* Step dots stay as a secondary navigator */}
                <div className="tutorial-callout__dots" aria-hidden="true">
                    {STEPS.map((_, i) => (
                        <span key={i} className={`tutorial-callout__dot${i === idx ? ' tutorial-callout__dot--active' : ''}`} />
                    ))}
                </div>

                {/* `key={idx}` forces a fresh fade-in on every step change */}
                <div className="tutorial-callout__content" key={idx}>
                    <h3 className="tutorial-callout__title">{step.title}</h3>
                    <p className="tutorial-callout__body">{step.body}</p>
                </div>

                <div className="tutorial-callout__actions">
                    <button className="tutorial-skip" onClick={finish}>Skip tour</button>
                    <div className="tutorial-callout__nav">
                        <button
                            className="tutorial-nav-btn"
                            onClick={prev}
                            disabled={idx === 0}
                            title="Previous"
                            aria-label="Previous step"
                        >
                            <svg width="11" height="11" viewBox="0 0 10 10" fill="none">
                                <path d="M7 1L3 5l4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                            </svg>
                        </button>
                        <button
                            className={`tutorial-nav-btn ${isLast ? 'tutorial-nav-btn--done' : 'tutorial-nav-btn--next'}`}
                            onClick={next}
                            title={isLast ? 'Finish' : 'Next'}
                            aria-label={isLast ? 'Finish tutorial' : 'Next step'}
                        >
                            {isLast ? (
                                <svg width="13" height="13" viewBox="0 0 12 12" fill="none">
                                    <path d="M2 6l3.5 3.5L10 2.5" stroke="currentColor" strokeWidth="1.8" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                            ) : (
                                <svg width="11" height="11" viewBox="0 0 10 10" fill="none">
                                    <path d="M3 1l4 4-4 4" stroke="currentColor" strokeWidth="1.6" strokeLinecap="round" strokeLinejoin="round"/>
                                </svg>
                            )}
                        </button>
                    </div>
                </div>
            </div>
        </div>
    );
};
