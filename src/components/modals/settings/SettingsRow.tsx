import React from 'react';

/**
 * The single row primitive used across every Settings tab (Paths, Integrations,
 * and General list items). One component → one look, so the tabs read as the
 * same page instead of a dozen bespoke cards.
 *
 * Layout: [icon] [ header (dot · title · tags) + sub ]        [actions]
 * `sub` can be plain text (a path/description) or a control (an input row).
 */
export const SettingsRow: React.FC<{
    icon: React.ReactNode;
    title: React.ReactNode;
    /** Green when true, muted otherwise. Omit to hide the status dot. */
    on?: boolean;
    /** Small pill tags after the title (Default, LIVE, PBE…). */
    tags?: React.ReactNode;
    /** Second line: muted text, or a control row (e.g. the path input). */
    sub?: React.ReactNode;
    subTitle?: string;
    /** Right-aligned action buttons. */
    actions?: React.ReactNode;
    /** Brand accent for the tag/hover tint. */
    accent?: string;
}> = ({ icon, title, on, tags, sub, subTitle, actions, accent }) => (
    <div className="settings-row" style={accent ? ({ ['--logo' as never]: accent }) : undefined}>
        <span className="settings-row__icon" aria-hidden="true">{icon}</span>
        <div className="settings-row__body">
            <div className="settings-row__head">
                {on !== undefined && <span className={`settings-row__dot ${on ? 'is-on' : ''}`} />}
                <strong className="settings-row__title">{title}</strong>
                {tags}
            </div>
            {sub !== undefined && (
                <div className="settings-row__sub" title={subTitle}>{sub}</div>
            )}
        </div>
        {actions && <div className="settings-row__actions">{actions}</div>}
    </div>
);

/** A small brand-tinted tag (Default / LIVE / PBE). */
export const SettingsTag: React.FC<{ children: React.ReactNode }> = ({ children }) => (
    <span className="settings-row__tag">{children}</span>
);
