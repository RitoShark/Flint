import React from 'react';

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
        : 'Decoding chunks';

    return (
        <div className="dl-modal-backdrop extract-modal" role="dialog" aria-live="polite" aria-label={progress.title}>
            <div className="dl-modal extract-modal__panel">
                <div className="extract-modal__head">
                    <span className="extract-modal__spinner" aria-hidden="true">
                        <svg viewBox="0 0 50 50" width="20" height="20">
                            <circle cx="25" cy="25" r="20" fill="none" strokeWidth="5"
                                stroke="color-mix(in oklab, var(--accent-primary) 20%, transparent)" />
                            <circle cx="25" cy="25" r="20" fill="none" strokeWidth="5"
                                stroke="var(--accent-primary)" strokeLinecap="round"
                                strokeDasharray="34 100" transform="rotate(-90 25 25)" />
                        </svg>
                    </span>
                    <div className="extract-modal__titles">
                        <span className="extract-modal__title">{progress.title}</span>
                        <span className="extract-modal__subtitle">{subtitle}</span>
                    </div>
                    {pct !== null && <span className="extract-modal__pct">{pct}%</span>}
                </div>

                <div className="extract-modal__body">
                    <div className="extract-modal__current" title={progress.currentLabel}>
                        {progress.currentLabel}
                    </div>

                    <div className={`dl-progress ${pct === null ? 'dl-progress--indet' : ''}`}>
                        <div
                            className="dl-progress__fill"
                            style={pct === null ? undefined : { width: `${pct}%` }}
                        />
                    </div>

                    {progress.plannedCount > 0 && (
                        <div className="extract-modal__stats">
                            <span className="extract-modal__count">
                                {progress.extractedCount.toLocaleString()} / {progress.plannedCount.toLocaleString()}
                            </span>
                            <span className="extract-modal__count-label">files extracted</span>
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
