import React from 'react';
import { Icon, Input, Textarea } from '../../ui';
import { SettingsRow, SettingsTag } from './SettingsRow';

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
    return (
        <div className="settings-panel settings-panel--flush">
            <SettingsRow
                icon={<Icon name="user" />}
                on={name.trim().length > 0}
                title="Creator name"
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
                title="Default description"
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
                            Pre-fills the description on every new project — editable per-project later. {description.length}/280
                        </p>
                    </div>
                }
            />

            <SettingsRow
                icon={<Icon name="globe" />}
                title="Home URL"
                tags={<SettingsTag>Optional</SettingsTag>}
                sub={
                    <div className="creator-field">
                        <Input
                            type="url"
                            placeholder="https://yoursite.com or your socials"
                            value={home}
                            onChange={(e) => onHome(e.target.value)}
                        />
                        <p className="creator-field__hint">Shown as a “Home” link on every mod you publish.</p>
                    </div>
                }
            />

            <SettingsRow
                icon={<Icon name="heart" />}
                title="Tip URL"
                tags={<SettingsTag>Optional</SettingsTag>}
                sub={
                    <div className="creator-field">
                        <Input
                            type="url"
                            placeholder="https://ko-fi.com/you  ·  buymeacoffee.com/you"
                            value={tip}
                            onChange={(e) => onTip(e.target.value)}
                        />
                        <p className="creator-field__hint">Shown as a tip-jar link so users can support your work.</p>
                    </div>
                }
            />
        </div>
    );
};
