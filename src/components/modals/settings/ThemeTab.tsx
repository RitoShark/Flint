import React, { useEffect } from 'react';
import * as api from '../../../lib/api';
import { openColorPicker } from '../../common/ColorPicker';

/* -------------------------------------------------------------------------- */
/* Theme preset grid — same 5 cards as the wizard, lives on the Theme tab     */
/* -------------------------------------------------------------------------- */
export type SettingsThemePreset = { id: string | null; name: string; bg: string; raised: string; accent: string };
export const SETTINGS_THEME_PRESETS: SettingsThemePreset[] = [
    { id: null,        name: 'Flint',     bg: '#0c0c10', raised: '#15151b', accent: '#EF4444' },
    { id: 'celestial', name: 'Celestial', bg: '#0a0a14', raised: '#13132a', accent: '#A05CF6' },
    { id: 'jade',      name: 'Jade',      bg: '#08111a', raised: '#0f1c28', accent: '#06B6D4' },
    { id: 'froggy',    name: 'Froggy',    bg: '#0a1410', raised: '#11241c', accent: '#22C55E' },
    { id: 'quartz',    name: 'Quartz',    bg: '#0f0a14', raised: '#1d1424', accent: '#EC4899' },
];
/** Default accent shown on the Custom card before the user picks one. */
const CUSTOM_DEFAULT_ACCENT = '#EF4444';
const HEX_RE = /^#[0-9a-fA-F]{6}$/;

export const ThemePresetGrid: React.FC<{
    selectedTheme: string | null;
    /** The persisted custom accent (used when selectedTheme === 'custom'). */
    customAccent?: string | null;
    onSelect: (id: string | null, accent: string) => void;
    /** Called when the user picks/changes the custom accent color. */
    onCustomAccent?: (hex: string) => void;
}> = ({ selectedTheme, customAccent, onSelect, onCustomAccent }) => {
    useEffect(() => {
        api.seedBuiltinThemes().catch(() => {});
    }, []);
    const customActive = selectedTheme === 'custom';
    const accent = (customAccent && HEX_RE.test(customAccent)) ? customAccent : CUSTOM_DEFAULT_ACCENT;
    const [hexText, setHexText] = React.useState(accent);
    useEffect(() => { setHexText(accent); }, [accent]);

    const applyCustom = (hex: string) => {
        if (!HEX_RE.test(hex)) return;
        onCustomAccent?.(hex);
    };

    return (
        <>
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

                {/* 6th card — Custom accent. Keeps the dark base, swaps only the accent. */}
                <button
                    type="button"
                    className={`theme-preset ${customActive ? 'is-active' : ''}`}
                    style={{ ['--accent' as never]: accent, ['--bg' as never]: '#0c0c10', ['--raised' as never]: '#15151b' }}
                    onClick={() => onCustomAccent?.(accent)}
                    aria-pressed={customActive}
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
                        <span className="theme-preset__name">Custom</span>
                        <span className="theme-preset__dots">
                            <span className="theme-preset__dot" style={{ background: '#0c0c10' }} />
                            <span className="theme-preset__dot" style={{ background: accent }} />
                            {customActive && (
                                <span className="theme-preset__check" style={{ background: accent }}>
                                    <svg width="10" height="10" viewBox="0 0 24 24" fill="none" stroke="#fff" strokeWidth="3.5" strokeLinecap="round" strokeLinejoin="round">
                                        <polyline points="20 6 9 17 4 12" />
                                    </svg>
                                </span>
                            )}
                        </span>
                    </span>
                </button>
            </div>

            {customActive && (
                <div className="theme-custom-accent">
                    <button
                        type="button"
                        className="theme-custom-accent__circle"
                        style={{ background: accent }}
                        title="Click to pick an accent color"
                        onClick={(e) => openColorPicker(e, accent, applyCustom)}
                    />
                    <input
                        className="dl-input theme-custom-accent__hex"
                        value={hexText}
                        spellCheck={false}
                        onChange={(e) => {
                            const v = e.target.value.startsWith('#') ? e.target.value : `#${e.target.value}`;
                            setHexText(v);
                            applyCustom(v);
                        }}
                        placeholder="#EF4444"
                    />
                    <span className="theme-custom-accent__hint">Click the circle to pick any accent — the dark base stays.</span>
                </div>
            )}
        </>
    );
};
