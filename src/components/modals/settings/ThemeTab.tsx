/**
 * ThemePresetGrid - 5 brand-themed cards on the Settings 'Theme' tab.
 * Selecting one routes to setSelectedTheme(id, accent).
 */
import React, { useEffect } from 'react';
import * as api from '../../../lib/api';

/* -------------------------------------------------------------------------- */
/* Theme preset grid — same 5 cards as the wizard, lives on the Theme tab     */
/* -------------------------------------------------------------------------- */
/* Flint is the default — `id: null` means "no theme override, fall back to
   index.css :root defaults". Selecting it routes to setSelectedTheme(null).
   The other 4 bind to real `themes/<id>.json` files seeded by the Rust
   `seed_builtin_themes` command. */
export type SettingsThemePreset = { id: string | null; name: string; bg: string; raised: string; accent: string };
export const SETTINGS_THEME_PRESETS: SettingsThemePreset[] = [
    { id: null,        name: 'Flint',     bg: '#0c0c10', raised: '#15151b', accent: '#EF4444' },
    { id: 'celestial', name: 'Celestial', bg: '#0a0a14', raised: '#13132a', accent: '#A05CF6' },
    { id: 'jade',      name: 'Jade',      bg: '#08111a', raised: '#0f1c28', accent: '#06B6D4' },
    { id: 'froggy',    name: 'Froggy',    bg: '#0a1410', raised: '#11241c', accent: '#22C55E' },
    { id: 'quartz',    name: 'Quartz',    bg: '#0f0a14', raised: '#1d1424', accent: '#EC4899' },
];
export const ThemePresetGrid: React.FC<{
    selectedTheme: string | null;
    onSelect: (id: string | null, accent: string) => void;
}> = ({ selectedTheme, onSelect }) => {
    // Seed the JSON theme files on first render so clicking a card actually
    // resolves to a real `themes/<id>.json` via the existing apply path.
    useEffect(() => {
        api.seedBuiltinThemes().catch(() => { /* non-fatal */ });
    }, []);
    return (
        <div className="theme-preset-grid">
            {SETTINGS_THEME_PRESETS.map((t) => {
                const active = selectedTheme === t.id;
                return (
                    <button
                        key={t.id ?? '__default__'}
                        type="button"
                        className={`theme-preset ${active ? 'is-active' : ''}`}
                        style={{ ['--accent' as never]: t.accent, ['--bg' as never]: t.bg, ['--raised' as never]: t.raised }}
                        onClick={() => onSelect(t.id, t.accent)}
                        aria-pressed={active}
                    >
                        <span className="theme-preset__mock">
                            <span className="theme-preset__mock-rail" />
                            <span className="theme-preset__mock-rows">
                                <span className="theme-preset__mock-row">
                                    <span className="theme-preset__mock-tile" />
                                    <span className="theme-preset__mock-tile theme-preset__mock-tile--accent" />
                                </span>
                                <span className="theme-preset__mock-row">
                                    <span className="theme-preset__mock-tile theme-preset__mock-tile--accent-soft" />
                                    <span className="theme-preset__mock-tile" />
                                </span>
                            </span>
                        </span>
                        <span className="theme-preset__foot">
                            <span className="theme-preset__name">{t.name}</span>
                            <span className="theme-preset__dots">
                                <span className="theme-preset__dot" style={{ background: t.bg }} />
                                <span className="theme-preset__dot" style={{ background: t.accent }} />
                                {active && (
                                    <span className="theme-preset__check" style={{ background: t.accent }}>
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
    );
};
