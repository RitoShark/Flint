import { Button } from '../../ui/Button';
import React from 'react';

export interface PortTarget {
    id: number;
    label: string;
    imageUrl?: string | null;
}

interface TargetGridProps {
    targets: PortTarget[];
    selected: Set<number>;
    onToggle: (id: number) => void;
    onSelectAll: () => void;
    onSelectNone: () => void;
    /** `art` shows a splash tile per target; `chip` is a dense numeric grid. */
    variant: 'art' | 'chip';
    noun: string;
    /** Extra one-click preset shown beside All / None. */
    preset?: { label: string; title: string; onSelect: () => void; disabled?: boolean };
}

export const TargetGrid: React.FC<TargetGridProps> = ({
    targets,
    selected,
    onToggle,
    onSelectAll,
    onSelectNone,
    variant,
    noun,
    preset,
}) => {
    const [imgErrors, setImgErrors] = React.useState<Set<number>>(new Set());

    return (
        <>
            <div className="skin-port__toolbar">
                <Button
                    variant="ghost" size="sm"
                    onClick={onSelectAll}
                    disabled={selected.size === targets.length}
                >
                    All
                </Button>
                <Button
                    variant="ghost" size="sm"
                    onClick={onSelectNone}
                    disabled={selected.size === 0}
                >
                    None
                </Button>
                {preset && (
                    <Button
                        variant="ghost" size="sm"
                        onClick={preset.onSelect}
                        disabled={preset.disabled}
                        title={preset.title}
                    >
                        {preset.label}
                    </Button>
                )}
                <span className="skin-port__count">
                    {selected.size} / {targets.length} {noun}
                </span>
            </div>

            <div className="skin-port__gallery">
                <div className={`skin-port__grid skin-port__grid--${variant}`}>
                    {targets.map((target) => {
                        const isSel = selected.has(target.id);
                        const showImg = variant === 'art'
                            && !!target.imageUrl
                            && !imgErrors.has(target.id);
                        return (
                            <button
                                key={target.id}
                                className={`skin-port__card skin-port__card--${variant}${isSel ? ' skin-port__card--selected' : ''}`}
                                onClick={() => onToggle(target.id)}
                                title={target.label}
                            >
                                {showImg && (
                                    <img
                                        className="skin-port__card-img"
                                        src={target.imageUrl!}
                                        alt=""
                                        onError={() =>
                                            setImgErrors((prev) => new Set(prev).add(target.id))
                                        }
                                    />
                                )}
                                {variant === 'art' && !showImg && (
                                    <span className="skin-port__card-slot">{target.id}</span>
                                )}
                                <span className="skin-port__card-label">{target.label}</span>
                            </button>
                        );
                    })}
                </div>
            </div>
        </>
    );
};
