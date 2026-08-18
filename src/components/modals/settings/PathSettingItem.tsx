import React from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Icon, type IconName, Input } from '../../ui';
import { getIcon } from '../../../lib/ui-helpers/fileIcons';
import { SettingsRow, SettingsTag } from './SettingsRow';
import { useTranslation } from '../../../lib/i18n';

export interface PathSetting {
    label: string;
    badge?: string;
    placeholder: string;
    value: string;
    onChange: (v: string) => void;
    browseTitle: string;
    onDetect?: () => void;
    detectLabel?: string;
    /** Treat as file picker rather than directory. */
    file?: boolean;
    hint?: string;
    disabled?: boolean;
    /** Optional brand logo image; renders inside the icon frame. */
    logoSrc?: string;
    /** Optional brand colour; drives the connected glow + badge tint. */
    logoColor?: string;
    /** Optional generic icon name (Icon glyph) when no logoSrc. */
    iconName?: IconName;
}

export const PathSettingItem: React.FC<{ setting: PathSetting }> = ({ setting }) => {
    const { t } = useTranslation();
    const handleBrowse = async () => {
        const selected = await open({
            title: setting.browseTitle,
            directory: !setting.file,
        });
        if (selected) setting.onChange(selected as string);
    };
    const filled = setting.value.trim().length > 0;
    return (
        <SettingsRow
            accent={setting.logoColor}
            icon={setting.logoSrc
                ? <img src={setting.logoSrc} alt="" className="settings-row__logo-img" draggable={false} />
                : <Icon name={setting.iconName ?? 'folder'} className={`settings-row__glyph settings-row__glyph--${setting.iconName ?? 'folder'}`} />}
            on={filled}
            title={setting.label}
            tags={setting.badge ? <SettingsTag>{setting.badge}</SettingsTag> : undefined}
            sub={
                <div className="settings-row__field">
                    <Input
                        placeholder={setting.placeholder}
                        value={setting.value}
                        onChange={(e) => setting.onChange(e.target.value)}
                        buttonLabel={t('common.browse')}
                        onButtonClick={handleBrowse}
                    />
                    {setting.onDetect && setting.detectLabel && (
                        <button
                            type="button"
                            className="dl-btn dl-btn--ghost dl-btn--sm dl-btn--icon settings-row__detect"
                            onClick={setting.onDetect}
                            disabled={setting.disabled}
                            title={setting.detectLabel}
                            aria-label={setting.detectLabel}
                            dangerouslySetInnerHTML={{ __html: getIcon('search') }}
                        />
                    )}
                </div>
            }
        />
    );
};

