import React from 'react';
import type { ProjectType } from './helpers';

export type CreatePhase =
    | 'init' | 'create' | 'extract' | 'voiceover'
    | 'concat' | 'repath' | 'encode' | 'inject' | 'complete';

interface Step {
    phase: CreatePhase;
    label: string;
}

const SKIN_STEPS: Step[] = [
    { phase: 'init', label: 'Reading the game files' },
    { phase: 'create', label: 'Laying out the project' },
    { phase: 'extract', label: 'Pulling the skin out of the WAD' },
    { phase: 'concat', label: 'Merging the linked BINs' },
    { phase: 'repath', label: 'Repathing onto your own folder' },
];

const VOICEOVER_STEP: Step = { phase: 'voiceover', label: 'Pulling the voiceover banks' };

const MAP_STEPS: Step[] = [
    { phase: 'init', label: 'Locating the map WADs' },
    { phase: 'create', label: 'Laying out the project' },
    { phase: 'extract', label: 'Extracting the map' },
];

const LOADSCREEN_STEPS: Step[] = [
    { phase: 'create', label: 'Laying out the project' },
    { phase: 'encode', label: 'Encoding the spritesheet' },
    { phase: 'extract', label: 'Extracting the UI base' },
    { phase: 'inject', label: 'Injecting the animation config' },
];

export function stepsFor(type: ProjectType, withVoiceover: boolean): Step[] {
    if (type === 'map') return MAP_STEPS;
    if (type === 'loading-screen') return LOADSCREEN_STEPS;
    if (!withVoiceover) return SKIN_STEPS;
    const steps = [...SKIN_STEPS];
    steps.splice(3, 0, VOICEOVER_STEP);
    return steps;
}

const CheckIcon: React.FC = () => (
    <svg viewBox="0 0 16 16" fill="none" aria-hidden="true">
        <path d="M3.5 8.5l3 3 6-7" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round" />
    </svg>
);

interface Props {
    steps: Step[];
    /** Latest phase reported by the backend; null before the first event. */
    phase: CreatePhase | null;
    /** Latest human-readable line from the backend. */
    message: string;
    title: string;
}

export const CreateProgress: React.FC<Props> = ({ steps, phase, message, title }) => {
    const done = phase === 'complete';
    const activeIndex = done
        ? steps.length
        : Math.max(0, steps.findIndex((s) => s.phase === phase));

    return (
        <div className="np-progress" role="status" aria-live="polite">
            <div className="np-progress__inner">
                <div className={`np-progress__badge${done ? ' np-progress__badge--done' : ''}`}>
                    {done ? <CheckIcon /> : <span className="np-progress__spinner" />}
                </div>

                <h3 className="np-progress__title">{done ? 'Ready' : title}</h3>
                <p className="np-progress__message">{done ? 'Opening the project' : (message || 'Starting up')}</p>

                <ol className="np-progress__steps">
                    {steps.map((step, i) => {
                        const state = i < activeIndex ? 'done' : i === activeIndex ? 'active' : 'pending';
                        return (
                            <li key={step.phase} className={`np-step np-step--${state}`}>
                                <span className="np-step__marker">
                                    {state === 'done' ? <CheckIcon /> : <span className="np-step__dot" />}
                                </span>
                                <span className="np-step__label">{step.label}</span>
                            </li>
                        );
                    })}
                </ol>

                <div className="np-progress__bar">
                    <span
                        className="np-progress__fill"
                        style={{ width: `${Math.round((activeIndex / steps.length) * 100)}%` }}
                    />
                </div>
            </div>
        </div>
    );
};
