import React from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { Button, Icon, type IconName, Input } from '../../ui';

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
    const handleBrowse = async () => {
        const selected = await open({
            title: setting.browseTitle,
            directory: !setting.file,
        });
        if (selected) setting.onChange(selected as string);
    };
    const filled = setting.value.trim().length > 0;
    const style = setting.logoColor ? ({ ['--logo' as never]: setting.logoColor } as React.CSSProperties) : undefined;
    return (
        <div
            className={`settings-prow ${filled ? 'is-filled' : ''} ${setting.logoSrc ? 'has-logo' : ''}`}
            style={style}
        >
            <span className="settings-prow__icon" aria-hidden="true">
                {setting.logoSrc
                    ? <img src={setting.logoSrc} alt="" className="settings-prow__logo-img" draggable={false} />
                    : <Icon name={setting.iconName ?? 'folder'} />}
            </span>
            <div className="settings-prow__body">
                <div className="settings-prow__head">
                    <span className={`settings-prow__dot ${filled ? 'is-on' : ''}`} />
                    <strong className="settings-prow__name">{setting.label}</strong>
                    {setting.badge && <span className="settings-prow__badge">{setting.badge}</span>}
                </div>
                <div className="settings-prow__field">
                    <Input
                        placeholder={setting.placeholder}
                        value={setting.value}
                        onChange={(e) => setting.onChange(e.target.value)}
                        buttonLabel="Browse"
                        onButtonClick={handleBrowse}
                    />
                    {setting.onDetect && setting.detectLabel && (
                        <Button
                            variant="ghost"
                            size="sm"
                            icon="search"
                            onClick={setting.onDetect}
                            disabled={setting.disabled}
                        >
                            {setting.detectLabel}
                        </Button>
                    )}
                </div>
            </div>
        </div>
    );
};
