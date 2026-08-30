import React from 'react';
import { useUxStore } from '../../../lib/stores/uxStore';
import { Checkbox, Icon } from '../../ui';
import { SettingsRow, SettingsTag } from './SettingsRow';
import { RITOBIN_PRESETS } from '../../../lib/editor/ritobinThemes';
import { useTranslation } from '../../../lib/i18n';

const TOOLS_SECTIONS = [
    'Skin Scale',
    'Material Override',
    'Idle Particles',
    'Persistent VFX',
    'VFX Emitters',
    'VFX Systems',
];

const DEFAULT_EXPANDED: Record<string, boolean> = {
    'Skin Scale': true,
    'Material Override': true,
    'Idle Particles': false,
    'Persistent VFX': false,
    'VFX Emitters': true,
    'VFX Systems': true,
};

export function sectionStartsExpanded(
    title: string,
    stored: Record<string, boolean>,
): boolean {
    return stored[title] ?? DEFAULT_EXPANDED[title] ?? true;
}

export const BinEditorTab: React.FC = () => {
    const ux = useUxStore();
    const { t } = useTranslation();

    const setSection = (title: string, expanded: boolean) =>
        ux.setBinEditorPrefs({
            binEditorExpandedSections: { ...ux.binEditorExpandedSections, [title]: expanded },
        });

    return (
        <div className="settings-panel">
            <div className="settings-subhead">{t('settings.binEditor.editor')}</div>

            <SettingsRow
                icon={<Icon name="text" />}
                title={t('settings.binEditor.wordWrap')}
                sub={<span className="settings-row__sub">{t('settings.binEditor.wordWrapSub')}</span>}
                onActivate={() => ux.setBinEditorPrefs({ binEditorWordWrap: !ux.binEditorWordWrap })}
                actions={
                    <Checkbox
                        toggle
                        checked={ux.binEditorWordWrap}
                        onChange={(e) => ux.setBinEditorPrefs({ binEditorWordWrap: e.target.checked })}
                    />
                }
            />

            <SettingsRow
                icon={<Icon name="settings" />}
                title={t('settings.binEditor.fontSize')}
                sub={
                    <input
                        type="range"
                        min={10}
                        max={20}
                        step={1}
                        value={ux.binEditorFontSize}
                        onChange={(e) => ux.setBinEditorPrefs({ binEditorFontSize: Number(e.target.value) })}
                        className="theme-range"
                    />
                }
                actions={<span className="settings-row__metric">{ux.binEditorFontSize}px</span>}
            />

            <SettingsRow
                icon={<Icon name="layerText" />}
                title={t('settings.binEditor.minimap')}
                sub={<span className="settings-row__sub">{t('settings.binEditor.minimapSub')}</span>}
                onActivate={() => ux.setBinEditorMinimap(!ux.binEditorMinimap)}
                actions={
                    <Checkbox
                        toggle
                        checked={ux.binEditorMinimap}
                        onChange={(e) => ux.setBinEditorMinimap(e.target.checked)}
                    />
                }
            />

            <SettingsRow
                icon={<Icon name="refresh" />}
                title={t('settings.binEditor.minimapLineLimit')}
                tags={<SettingsTag>{t('settings.theme.performance')}</SettingsTag>}
                sub={
                    <span className="settings-row__sub" style={{ whiteSpace: 'normal' }}>
                        {t('settings.binEditor.minimapLineLimitSub')}
                    </span>
                }
                actions={
                    <input
                        className="dl-input"
                        style={{ width: 110, fontFamily: 'var(--font-mono)' }}
                        value={String(ux.binEditorMinimapMaxLines)}
                        onChange={(e) => {
                            const parsed = parseInt(e.target.value.replace(/\D/g, ''), 10);
                            ux.setBinEditorPrefs({
                                binEditorMinimapMaxLines: Number.isNaN(parsed) ? 0 : parsed,
                            });
                        }}
                    />
                }
            />

            <SettingsRow
                icon={<Icon name="chevronDown" />}
                title={t('settings.binEditor.leapBar')}
                sub={
                    <span className="settings-row__sub" style={{ whiteSpace: 'normal' }}>
                        {t('settings.binEditor.leapBarSub')}
                    </span>
                }
                onActivate={() => ux.setBinEditorPrefs({ binEditorLeapBar: !ux.binEditorLeapBar })}
                actions={
                    <Checkbox
                        toggle
                        checked={ux.binEditorLeapBar}
                        onChange={(e) => ux.setBinEditorPrefs({ binEditorLeapBar: e.target.checked })}
                    />
                }
            />

            <SettingsRow
                icon={<Icon name="search" />}
                title={t('settings.binEditor.autoUnhash')}
                sub={
                    <span className="settings-row__sub" style={{ whiteSpace: 'normal' }}>
                        {t('settings.binEditor.autoUnhashSub')}
                    </span>
                }
                onActivate={() => ux.setBinEditorPrefs({ binEditorAutoUnhash: !ux.binEditorAutoUnhash })}
                actions={
                    <Checkbox
                        toggle
                        checked={ux.binEditorAutoUnhash}
                        onChange={(e) => ux.setBinEditorPrefs({ binEditorAutoUnhash: e.target.checked })}
                    />
                }
            />

            <SettingsRow
                icon={<Icon name="code" />}
                title={t('settings.binEditor.autoSuggestions')}
                sub={
                    <span className="settings-row__sub" style={{ whiteSpace: 'normal' }}>
                        {t('settings.binEditor.autoSuggestionsSub')}
                    </span>
                }
                onActivate={() => ux.setBinEditorPrefs({ binEditorAutoSuggestions: !ux.binEditorAutoSuggestions })}
                actions={
                    <Checkbox
                        toggle
                        checked={ux.binEditorAutoSuggestions}
                        onChange={(e) => ux.setBinEditorPrefs({ binEditorAutoSuggestions: e.target.checked })}
                    />
                }
            />

            <div className="settings-subhead">{t('settings.binEditor.syntaxColors')}</div>
            <div className="bin-theme-grid">
                {RITOBIN_PRESETS.map((preset) => {
                    const active = ux.binEditorSyntaxTheme === preset.id;
                    const swatches = ['type', 'type.identifier', 'string', 'number', 'variable']
                        .map((token) => preset.rules.find((r) => r.token === token)?.foreground ?? 'c0c0c0');
                    return (
                        <button
                            key={preset.id}
                            className={`bin-theme-card${active ? ' bin-theme-card--active' : ''}`}
                            onClick={() => ux.setBinEditorPrefs({ binEditorSyntaxTheme: preset.id })}
                            style={{ background: preset.colors['editor.background'] }}
                        >
                            <span className="bin-theme-card__swatches">
                                {swatches.map((hex, i) => (
                                    <span key={i} style={{ background: `#${hex}` }} />
                                ))}
                            </span>
                            <span
                                className="bin-theme-card__name"
                                style={{ color: preset.colors['editor.foreground'] }}
                            >
                                {preset.label}
                            </span>
                        </button>
                    );
                })}
            </div>

            <div className="settings-subhead">{t('settings.binEditor.toolsPanel')}</div>
            {TOOLS_SECTIONS.map((title) => {
                const expanded = sectionStartsExpanded(title, ux.binEditorExpandedSections);
                return (
                    <SettingsRow
                        key={title}
                        icon={<Icon name="chevronDown" />}
                        title={title}
                        sub={<span className="settings-row__sub">{expanded ? t('settings.binEditor.startsExpanded') : t('settings.binEditor.startsCollapsed')}</span>}
                        onActivate={() => setSection(title, !expanded)}
                        actions={
                            <Checkbox
                                toggle
                                checked={expanded}
                                onChange={(e) => setSection(title, e.target.checked)}
                            />
                        }
                    />
                );
            })}
        </div>
    );
};

