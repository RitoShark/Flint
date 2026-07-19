import React from 'react';
import { SettingsRow, SettingsTag } from './SettingsRow';

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
                tags={isDefault ? <SettingsTag>Default</SettingsTag> : undefined}
                sub={connected ? i.path : i.tagline}
                subTitle={connected ? i.path : undefined}
                actions={connected ? (
                    <>
                        {isLauncher && !isDefault && (
                            <button className="dl-btn dl-btn--primary dl-btn--sm" onClick={() => onPreferredLauncherChange(i.id as 'ltk' | 'celestial')}>
                                Set default
                            </button>
                        )}
                        {isLauncher && isDefault && (
                            <button
                                className={`dl-btn dl-btn--sm ${autoSync ? 'dl-btn--active' : ''}`}
                                disabled={!ltkConfigured}
                                onClick={() => onAutoSyncChange(!autoSync)}
                                title="Push project changes to this launcher whenever files are modified"
                            >
                                Auto-Sync {autoSync ? 'On' : 'Off'}
                            </button>
                        )}
                        <button className="dl-btn dl-btn--ghost dl-btn--sm" onClick={() => void onConnect(i)}>Change</button>
                        <button className="dl-btn dl-btn--ghost dl-btn--sm" onClick={() => i.setPath('')}>Disconnect</button>
                    </>
                ) : (
                    <>
                        <button className="dl-btn dl-btn--primary dl-btn--sm" onClick={() => void onConnect(i)}>Connect</button>
                        <button className="dl-btn dl-btn--ghost dl-btn--sm" onClick={i.onDetect}>Auto-detect</button>
                    </>
                )}
            />
        );
    };

    return (
        <div className="integrations-tab">
            <p className="integrations-tab__intro">
                Connect external tools so Flint can hand off work to them. Each one is fully optional — you can swap them any time.
            </p>
            <div className="integrations-tab__group-label">Launchers</div>
            {launchers.map((i) => renderCard(i, true))}
            <div className="integrations-tab__group-label">External apps</div>
            {apps.map((i) => renderCard(i, false))}
        </div>
    );
};
