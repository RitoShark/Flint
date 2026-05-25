/**
 * Full-bleed dimmer + progress card shown while WadExplorer is performing
 * a batched extract. Determinate bar when extracting multiple WADs;
 * indeterminate animation when only one is in flight.
 */
import React from 'react';

/* ----------------------------------------------------------------------------
   ExtractOverlay — full-bleed dimmer with a glassy card containing a spinner,
   the user's selection summary, and a determinate progress bar that fills as
   each WAD finishes (we don't have per-chunk progress events). When only one
   WAD is in flight the bar uses an indeterminate animation instead so the
   user still sees motion.
---------------------------------------------------------------------------- */
export const ExtractOverlay: React.FC<{
    progress: {
        title: string;
        currentLabel: string;
        currentIndex: number;
        totalGroups: number;
        extractedCount: number;
        plannedCount: number;
    };
}> = ({ progress }) => {
    const pct = progress.totalGroups > 1
        ? Math.min(100, Math.round((progress.currentIndex / progress.totalGroups) * 100))
        : null; // null → indeterminate
    const subtitle = progress.totalGroups > 1
        ? `WAD ${Math.min(progress.currentIndex + 1, progress.totalGroups)} of ${progress.totalGroups}`
        : `Decoding chunks…`;
    return (
        <div className="extract-overlay" role="dialog" aria-live="polite" aria-label={progress.title}>
            <div className="extract-overlay__backdrop" />
            <div className="extract-overlay__card">
                <div className="extract-overlay__spinner" aria-hidden="true">
                    <svg viewBox="0 0 50 50" width="40" height="40">
                        <circle cx="25" cy="25" r="20" fill="none" strokeWidth="4"
                            stroke="color-mix(in oklab, var(--accent-primary) 18%, transparent)" />
                        <circle cx="25" cy="25" r="20" fill="none" strokeWidth="4"
                            stroke="var(--accent-primary)"
                            strokeLinecap="round"
                            strokeDasharray="40 100"
                            transform="rotate(-90 25 25)" />
                    </svg>
                </div>
                <div className="extract-overlay__title">{progress.title}</div>
                <div className="extract-overlay__subtitle">{subtitle}</div>
                <div className="extract-overlay__current" title={progress.currentLabel}>
                    {progress.currentLabel}
                </div>
                <div className={`extract-overlay__bar ${pct === null ? 'is-indeterminate' : ''}`}>
                    <div
                        className="extract-overlay__bar-fill"
                        style={pct === null ? undefined : { width: `${pct}%` }}
                    />
                </div>
                <div className="extract-overlay__stats">
                    {progress.plannedCount > 0 && (
                        <span><strong>{progress.extractedCount.toLocaleString()}</strong> / {progress.plannedCount.toLocaleString()} files</span>
                    )}
                    {progress.totalGroups > 1 && pct !== null && <span>{pct}%</span>}
                </div>
            </div>
        </div>
    );
};
