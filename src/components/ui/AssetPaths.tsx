import React from 'react';

export interface AssetPathEntry {
    path: string;
    label?: string;
}

/** Readable, selectable asset locations without truncating the underlying path. */
export const AssetPaths: React.FC<{ entries: AssetPathEntry[]; label?: string }> = ({ entries, label }) => (
    <div className="asset-paths">
        {label && <div className="asset-paths__label">{label}</div>}
        <ul className="asset-paths__list" aria-label={label ?? 'Asset paths'} tabIndex={0}>
            {entries.map(({ path, label: entryLabel }, index) => (
                <li className="asset-paths__entry" key={`${index}:${path}`}>
                    {entryLabel && <span className="asset-paths__label">{entryLabel}</span>}
                    <span className="asset-paths__name">{path.split(/[\\/]/).filter(Boolean).pop() ?? path}</span>
                    <code className="asset-paths__path">{path}</code>
                </li>
            ))}
        </ul>
    </div>
);
