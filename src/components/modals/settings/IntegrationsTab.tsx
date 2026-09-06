import { Button } from '../../ui/Button';
import React from 'react';
import { SettingsRow, SettingsTag } from './SettingsRow';
import { useTranslation } from '../../../lib/i18n';

export type IntegrationDisplay = {
    id: 'ltk' | 'celestial' | 'jade' | 'quartz';
    name: string;
    tagline: string;
    accent: string;
    path: string;
    setPath: (v: string) => void;
    onDetect: () => void;
    browseTitle: string;
    directory: boolean;
    helpUrl?: string;
    kind?: 'launcher' | 'app';
};
const INTEGRATION_LOGOS: Record<IntegrationDisplay['id'], string> = {
    ltk: '/ltk-manager-logo.svg',
    celestial: '/celestial-logo.webp',
    jade: '/jade-logo.webp',
    quartz: '/quartz-logo.webp',
};
const IntegrationLogo: React.FC<{ id: IntegrationDisplay['id'] }> = ({ id }) => (
    <img src={INTEGRATION_LOGOS[id]} alt="" className="settings-row__logo-img" draggable={false} />
);
export const IntegrationsTab: React.FC<{
    integrations: IntegrationDisplay[];
    onConnect: (i: IntegrationDisplay) => Promise<void> | void;
    autoSync: boolean;
    onAutoSyncChange: (v: boolean) => void;
    ltkConfigured: boolean;
    preferredLauncher: 'ltk' | 'celestial' | null;
    onPreferredLauncherChange: (l: 'ltk' | 'celestial' | null) => void;
}> = ({ integrations, onConnect, autoSync, onAutoSyncChange, ltkConfigured, preferredLauncher, onPreferredLauncherChange }) => {
    const { t } = useTranslation();
    const launchers = integrations.filter((i) => i.kind === 'launcher');
    const apps = integrations.filter((i) => i.kind !== 'launcher');
    const effective = preferredLauncher
        ?? (launchers.find((l) => l.path.trim().length > 0)?.id as 'ltk' | 'celestial' | undefined)
        ?? 'celestial';

    const renderCard = (i: IntegrationDisplay, isLauncher: boolean) => {
        const connected = i.path.trim().length > 0;
        const isDefault = isLauncher && effective === i.id;
        return (
            <SettingsRow
                key={i.id}
                accent={i.accent}
                icon={<IntegrationLogo id={i.id} />}
                on={connected}
                title={i.name}
                tags={isDefault ? <SettingsTag>{t('common.default')}</SettingsTag> : undefined}
                sub={connected ? i.path : i.tagline}
                subTitle={connected ? i.path : undefined}
                actions={connected ? (
                    <>
                        {isLauncher && !isDefault && (
                            <Button variant="primary" size="sm" onClick={() => onPreferredLauncherChange(i.id as 'ltk' | 'celestial')}>
                                {t('settings.integrations.setDefault')}
                            </Button>
                        )}
                        {isLauncher && isDefault && (
                            <Button
                                size="sm" active={autoSync}
                                disabled={!ltkConfigured}
                                onClick={() => onAutoSyncChange(!autoSync)}
                                title={t('settings.integrations.autoSyncTitle')}
                            >
                                {autoSync ? t('settings.integrations.autoSyncOn') : t('settings.integrations.autoSyncOff')}
                            </Button>
                        )}
                        <Button variant="ghost" size="sm" onClick={() => void onConnect(i)}>{t('common.change')}</Button>
                        <Button variant="ghost" size="sm" onClick={() => i.setPath('')}>{t('common.disconnect')}</Button>
                    </>
                ) : (
                    <>
                        <Button variant="primary" size="sm" onClick={() => void onConnect(i)}>{t('common.connect')}</Button>
                        <Button variant="ghost" size="sm" onClick={i.onDetect}>{t('common.detect')}</Button>
                    </>
                )}
            />
        );
    };

    return (
        <div className="integrations-tab">
            <p className="integrations-tab__intro">
                {t('settings.integrations.intro')}
            </p>
            <div className="integrations-tab__group-label">{t('settings.integrations.launchers')}</div>
            {launchers.map((i) => renderCard(i, true))}
            <div className="integrations-tab__group-label">{t('settings.integrations.externalApps')}</div>
            {apps.map((i) => renderCard(i, false))}
        </div>
    );
};

