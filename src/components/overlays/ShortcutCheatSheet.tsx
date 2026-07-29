import React from 'react';
import { buildCheatSheet, scopeHint } from '../../lib/shortcuts/cheatSheet';
import { SHORTCUTS } from '../../lib/shortcuts/manifest';
import { useAction, useScope } from '../../lib/shortcuts/hooks';

/** Split a formatted combo ('Ctrl+Shift+Tab') into individual key caps. */
function keyCaps(keys: string): string[] {
    // A trailing '+' key would split to an empty tail; keep it as a literal cap.
    return keys.split('+').map((k) => (k === '' ? '+' : k));
}

interface Props {
    onClose: () => void;
}

/**
 * Keyboard-shortcut reference, rendered entirely from the manifest.
 *
 * Nothing here is hand-maintained: add a shortcut to manifest.ts and it shows up,
 * with its real combo. Distinct from WadCheatSheetModal, which documents WAD
 * filenames rather than keys.
 */
export const ShortcutCheatSheet: React.FC<Props> = ({ onClose }) => {
    // Only pushed while open, so 'escape' here can't compete with modal.close.
    useScope('cheat-sheet');
    useAction('help.closeCheatSheet', onClose);

    const groups = React.useMemo(() => buildCheatSheet(SHORTCUTS), []);

    const handleOverlayClick = (e: React.MouseEvent) => {
        if (e.target === e.currentTarget) onClose();
    };

    return (
        <div className="sc-sheet__overlay" onClick={handleOverlayClick}>
            <div
                className="sc-sheet"
                role="dialog"
                aria-modal="true"
                aria-label="Keyboard shortcuts"
            >
                <header className="sc-sheet__header">
                    <h2 className="sc-sheet__title">Keyboard Shortcuts</h2>
                    <button className="sc-sheet__close" onClick={onClose} title="Close (Esc)">
                        <svg viewBox="0 0 16 16" width="14" height="14">
                            <path
                                d="M4.5 4.5l7 7m0-7l-7 7"
                                stroke="currentColor"
                                strokeWidth="1.5"
                                strokeLinecap="round"
                                fill="none"
                            />
                        </svg>
                    </button>
                </header>

                <div className="sc-sheet__body">
                    {groups.map((group) => (
                        <section className="sc-sheet__group" key={group.group}>
                            <h3 className="sc-sheet__group-title">{group.group}</h3>
                            <ul className="sc-sheet__rows">
                                {group.rows.map((row, i) => {
                                    const hint = scopeHint(row.scope);
                                    return (
                                        <li className="sc-sheet__row" key={`${row.keys}-${i}`}>
                                            <span className="sc-sheet__label">
                                                {row.label}
                                                {hint && (
                                                    <span className="sc-sheet__hint"> {hint}</span>
                                                )}
                                            </span>
                                            <span className="sc-sheet__keys">
                                                {keyCaps(row.keys).map((cap, j) => (
                                                    <kbd className="sc-sheet__kbd" key={j}>{cap}</kbd>
                                                ))}
                                            </span>
                                        </li>
                                    );
                                })}
                            </ul>
                        </section>
                    ))}
                </div>

                <footer className="sc-sheet__footer">
                    Press <kbd className="sc-sheet__kbd">F1</kbd> any time to reopen this list.
                </footer>
            </div>
        </div>
    );
};
