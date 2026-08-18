import React from 'react';
import { Icon, Input, Textarea } from '../../ui';
import { SettingsRow, SettingsTag } from './SettingsRow';
import { useTranslation } from '../../../lib/i18n';

export const CreatorTab: React.FC<{
    name: string;
    onName: (v: string) => void;
    description: string;
    onDescription: (v: string) => void;
    home: string;
    onHome: (v: string) => void;
    tip: string;
    onTip: (v: string) => void;
}> = ({ name, onName, description, onDescription, home, onHome, tip, onTip }) => {
    const { t } = useTranslation();

    return (
        <div className="settings-panel settings-panel--flush">
            <SettingsRow
                icon={<Icon name="user" />}
                on={name.trim().length > 0}
                title={t('settings.creator.name')}
                sub={
                    <div className="creator-field">
                        <Input
                            placeholder="Your handle (for mod credits)"
                            value={name}
                            onChange={(e) => onName(e.target.value)}
                        />
                    </div>
                }
            />

            <SettingsRow
                icon={<Icon name="info" />}
                title={t('settings.creator.description')}
                tags={<SettingsTag>Optional</SettingsTag>}
                sub={
                    <div className="creator-field">
                        <Textarea
                            placeholder="Short tagline shown on every imported / new mod (e.g. “Stylized recolors for Aatrox”)"
                            value={description}
                            onChange={(e) => onDescription(e.target.value)}
                            rows={2}
                            maxLength={280}
                        />
                        <p className="creator-field__hint">
                            {t('settings.creator.descriptionSub')} {description.length}/280
                        </p>
                    </div>
                }
            />

            <SettingsRow
                icon={<Icon name="globe" />}
                title={t('settings.creator.home')}
                tags={<SettingsTag>Optional</SettingsTag>}
                sub={
                    <div className="creator-field">
                        <Input
                            type="url"
                            placeholder="https://yoursite.com or your socials"
                            value={home}
                            onChange={(e) => onHome(e.target.value)}
                        />
                        <p className="creator-field__hint">{t('settings.creator.homeSub')}</p>
                    </div>
                }
            />

            <SettingsRow
                icon={<Icon name="heart" />}
                title={t('settings.creator.tip')}
                tags={<SettingsTag>Optional</SettingsTag>}
                sub={
                    <div className="creator-field">
                        <Input
                            type="url"
                            placeholder="https://ko-fi.com/you  ·  buymeacoffee.com/you"
                            value={tip}
                            onChange={(e) => onTip(e.target.value)}
                        />
                        <p className="creator-field__hint">{t('settings.creator.tipSub')}</p>
                    </div>
                }
            />
        </div>
    );
};

