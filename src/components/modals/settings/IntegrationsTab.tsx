/**
 * IntegrationsTab - branded 'Connect' cards for each external app
 * (LTK Manager, Celestial launcher, Jade, Quartz). Surfaces auto-sync
 * toggle and the preferred-launcher selector.
 */
import React from 'react';
import { Button, Checkbox } from '../../ui';

/* -------------------------------------------------------------------------- */
/* Integrations tab — branded "Connect" cards for each external app           */
/* -------------------------------------------------------------------------- */
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
const IntegrationLogo: React.FC<{ id: IntegrationDisplay['id']; accent: string }> = ({ id, accent }) => (
    <div className="integration-card__logo" style={{ ['--logo' as never]: accent }}>
        <img src={INTEGRATION_LOGOS[id]} alt="" className="integration-card__logo-img" draggable={false} />
        <span className="integration-card__logo-ring" />
    </div>
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
    // Celestial is the priority launcher: when there's no explicit preference,
    // default to whichever connected launcher comes first in `launchers` (the
    // array is ordered Celestial-first), and fall back to Celestial outright.
    const effective = preferredLauncher
        ?? (launchers.find((l) => l.path.trim().length > 0)?.id as 'ltk' | 'celestial' | undefined)
        ?? 'celestial';

    const renderCard = (i: IntegrationDisplay, isLauncher: boolean) => {
        const connected = i.path.trim().length > 0;
        const isDefault = isLauncher && effective === i.id;
        return (
            <div
                key={i.id}
                className={`integration-card ${connected ? 'is-connected' : ''} ${isDefault ? 'is-default' : ''}`}
                style={{ ['--logo' as never]: i.accent }}
            >
                <IntegrationLogo id={i.id} accent={i.accent} />
                <div className="integration-card__body">
                    <div className="integration-card__head">
                        <strong>{i.name}</strong>
                        <span className={`integration-card__pill ${connected ? 'is-on' : ''}`}>
                            <span className="integration-card__pill-dot" />
                            {connected ? 'Connected' : 'Not connected'}
                        </span>
                        {isDefault && (
                            <span className="integration-card__pill integration-card__pill--default">
                                <span className="integration-card__pill-dot" />
                                Default launcher
                            </span>
                        )}
                    </div>
                    <p className="integration-card__tagline">{i.tagline}</p>
                    {connected && <p className="integration-card__path" title={i.path}>{i.path}</p>}
                </div>
                <div className="integration-card__actions">
                    {connected ? (
                        <>
                            {isLauncher && !isDefault && (
                                <Button
                                    variant="primary"
                                    size="sm"
                                    icon="check"
                                    onClick={() => onPreferredLauncherChange(i.id as 'ltk' | 'celestial')}
                                >
                                    Set as default
                                </Button>
                            )}
                            <Button variant="ghost" size="sm" icon="refresh" onClick={() => void onConnect(i)}>Change</Button>
                            <Button variant="ghost" size="sm" icon="close" onClick={() => i.setPath('')}>Disconnect</Button>
                        </>
                    ) : (
                        <>
                            <Button variant="primary" size="sm" icon="link" onClick={() => void onConnect(i)}>
                                Connect
                            </Button>
                            <Button variant="ghost" size="sm" icon="search" onClick={i.onDetect}>Auto-detect</Button>
                        </>
                    )}
                </div>
                {isDefault && connected && (
                    <div className="integration-card__extra">
                        <Checkbox
                            toggle
                            checked={autoSync}
                            onChange={(e) => onAutoSyncChange(e.target.checked)}
                            disabled={!ltkConfigured}
                            label={`Auto-Sync to ${i.name}`}
                            description="Push project changes whenever files are modified."
                        />
                    </div>
                )}
            </div>
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
