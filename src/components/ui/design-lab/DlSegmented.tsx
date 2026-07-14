import React from 'react';
import { DlIcon, type DlIconName } from './DlIcon';

export interface DlSegmentedOption<T extends string = string> {
    value: T;
    label: React.ReactNode;
    icon?: DlIconName;
}

export interface DlSegmentedProps<T extends string = string> {
    value: T;
    onChange: (value: T) => void;
    options: DlSegmentedOption<T>[];
    /** Stretch each segment to fill the row equally. */
    fill?: boolean;
    disabled?: boolean;
    'aria-label'?: string;
}

/**
 * Design-lab segmented control (`.dl-tabs` + `.dl-tab`). Replaces the ad-hoc
 * `.seg` two-state toggle with the themed tab pill group — used for
 * Regular/Italic, Behind/Front, and similar mutually-exclusive choices.
 */
export function DlSegmented<T extends string = string>({
    value,
    onChange,
    options,
    fill,
    disabled,
    ...aria
}: DlSegmentedProps<T>) {
    return (
        <div
            className="dl-tabs"
            role="tablist"
            aria-label={aria['aria-label']}
            style={fill ? { display: 'flex' } : undefined}
        >
            {options.map((o) => (
                <button
                    key={o.value}
                    type="button"
                    role="tab"
                    aria-selected={o.value === value}
                    disabled={disabled}
                    className={`dl-tab ${o.value === value ? 'dl-tab--active' : ''}`.trim()}
                    style={fill ? { flex: 1 } : undefined}
                    onClick={() => onChange(o.value)}
                >
                    {o.icon && <DlIcon name={o.icon} style={{ marginRight: o.label ? 6 : 0 }} />}
                    {o.label}
                </button>
            ))}
        </div>
    );
}
