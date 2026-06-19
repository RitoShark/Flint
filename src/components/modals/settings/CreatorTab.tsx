import React from 'react';
import { Icon, Input, Textarea } from '../../ui';

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
        <div className="creator-tab">
            <div className="settings-item">
                <label className="settings-item__label">
                    <Icon name="user" /> Creator name
                </label>
                <Input
                    placeholder="Your handle (for mod credits)"
                    value={name}
                    onChange={(e) => onName(e.target.value)}
                />
            </div>

            <div className="settings-item">
                <label className="settings-item__label">
                    <Icon name="info" /> Default description
                    <span className="settings-item__badge">Optional</span>
                </label>
                <Textarea
                    placeholder="Short tagline shown on every imported / new mod (e.g. “Stylized recolors for Aatrox”)"
                    value={description}
                    onChange={(e) => onDescription(e.target.value)}
                    rows={2}
                    maxLength={280}
                />
                <div className="settings-item__hint">
                    Pre-fills the description on every new project — editable per-project later. {description.length}/280
                </div>
            </div>

            <div className="settings-item">
                <label className="settings-item__label">
                    <Icon name="globe" /> Home URL
                    <span className="settings-item__badge">Optional</span>
                </label>
                <Input
                    type="url"
                    placeholder="https://yoursite.com or your socials"
                    value={home}
                    onChange={(e) => onHome(e.target.value)}
                />
                <div className="settings-item__hint">
                    Shown as a “Home” link on every mod you publish.
                </div>
            </div>

            <div className="settings-item">
                <label className="settings-item__label">
                    <Icon name="heart" /> Tip URL
                    <span className="settings-item__badge">Optional</span>
                </label>
                <Input
                    type="url"
                    placeholder="https://ko-fi.com/you  ·  buymeacoffee.com/you"
                    value={tip}
                    onChange={(e) => onTip(e.target.value)}
                />
                <div className="settings-item__hint">
                    Shown as a tip-jar link so users can support your work.
                </div>
            </div>
        </div>
    );
};
