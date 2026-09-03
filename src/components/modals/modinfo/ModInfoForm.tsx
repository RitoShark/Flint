import React, { useState } from 'react';
import { getIcon } from '../../../lib/ui-helpers/fileIcons';
import {
    COMMON_LICENSES,
    WELL_KNOWN_MAPS,
    WELL_KNOWN_TAGS,
    toggleValue,
    type ModInfoDraft,
} from '../../../lib/editor/modInfo';

export type ModInfoSection = 'details' | 'people' | 'targets' | 'license';

export const MOD_INFO_SECTIONS: { id: ModInfoSection; label: string; icon: Parameters<typeof getIcon>[0] }[] = [
    { id: 'details', label: 'Details', icon: 'document' },
    { id: 'people', label: 'Contributors', icon: 'user' },
    { id: 'targets', label: 'Targets', icon: 'target' },
    { id: 'license', label: 'License', icon: 'lock' },
];

const Icon: React.FC<{ name: Parameters<typeof getIcon>[0] }> = ({ name }) => (
    <span className="mi-icon" dangerouslySetInnerHTML={{ __html: getIcon(name) }} />
);

interface Props {
    section: ModInfoSection;
    draft: ModInfoDraft;
    slug: string;
    onChange: (patch: Partial<ModInfoDraft>) => void;
}

const TokenList: React.FC<{
    values: string[];
    placeholder: string;
    onChange: (next: string[]) => void;
}> = ({ values, placeholder, onChange }) => {
    const [entry, setEntry] = useState('');
    const commit = () => {
        const value = entry.trim();
        if (!value) return;
        if (!values.includes(value)) onChange([...values, value]);
        setEntry('');
    };
    return (
        <div className="mi-tokens">
            {values.map((value) => (
                <span key={value} className="mi-token">
                    {value}
                    <button
                        className="mi-token__drop"
                        onClick={() => onChange(values.filter((v) => v !== value))}
                        title={`Remove ${value}`}
                    >
                        <Icon name="close" />
                    </button>
                </span>
            ))}
            <input
                className="mi-token__input"
                value={entry}
                placeholder={placeholder}
                spellCheck={false}
                onChange={(e) => setEntry(e.target.value)}
                onBlur={commit}
                onKeyDown={(e) => {
                    if (e.key === 'Enter' || e.key === ',') {
                        e.preventDefault();
                        commit();
                    } else if (e.key === 'Backspace' && !entry && values.length) {
                        onChange(values.slice(0, -1));
                    }
                }}
            />
        </div>
    );
};

const ChipRow: React.FC<{
    options: readonly string[];
    values: string[];
    onChange: (next: string[]) => void;
}> = ({ options, values, onChange }) => (
    <div className="mi-chips">
        {options.map((option) => (
            <button
                key={option}
                className={`mi-chip${values.includes(option) ? ' mi-chip--on' : ''}`}
                onClick={() => onChange(toggleValue(values, option))}
            >
                {option}
            </button>
        ))}
    </div>
);

export const ModInfoForm: React.FC<Props> = ({ section, draft, slug, onChange }) => {
    const customTags = draft.tags.filter((tag) => !WELL_KNOWN_TAGS.includes(tag as never));
    const customMaps = draft.maps.filter((map) => !WELL_KNOWN_MAPS.includes(map as never));

    if (section === 'details') {
        return (
            <div className="mi-pane">
                <label className="mi-field">
                    <span className="mi-field__label">Display name</span>
                    <input
                        className="mi-input"
                        value={draft.displayName}
                        placeholder="My Awesome Mod"
                        onChange={(e) => onChange({ displayName: e.target.value })}
                    />
                    <span className="mi-field__hint">Shown in the launcher and in the packaged mod.</span>
                </label>

                <label className="mi-field">
                    <span className="mi-field__label">Version</span>
                    <input
                        className="mi-input mi-input--short"
                        value={draft.version}
                        placeholder="1.0.0"
                        spellCheck={false}
                        onChange={(e) => onChange({ version: e.target.value })}
                    />
                    <span className="mi-field__hint">Semver, e.g. 1.2.0 or 0.3.0-beta.1.</span>
                </label>

                <label className="mi-field">
                    <span className="mi-field__label">Description</span>
                    <textarea
                        className="mi-input mi-textarea"
                        rows={4}
                        value={draft.description}
                        placeholder="What this mod changes"
                        onChange={(e) => onChange({ description: e.target.value })}
                    />
                </label>

                <label className="mi-field">
                    <span className="mi-field__label">Thumbnail</span>
                    <input
                        className="mi-input"
                        value={draft.thumbnail}
                        placeholder="thumbnail.webp"
                        spellCheck={false}
                        onChange={(e) => onChange({ thumbnail: e.target.value })}
                    />
                    <span className="mi-field__hint">Path relative to the project folder. Blank uses the default.</span>
                </label>

                <div className="mi-field">
                    <span className="mi-field__label">Folder name</span>
                    <div className="mi-static">{slug || '—'}</div>
                    <span className="mi-field__hint">
                        Set when the project was created. Change it with Rename Project, which also rewrites asset paths.
                    </span>
                </div>
            </div>
        );
    }

    if (section === 'people') {
        return (
            <div className="mi-pane">
                <div className="mi-field">
                    <div className="mi-field__head">
                        <span className="mi-field__label">Contributors</span>
                        <button
                            className="dl-btn dl-btn--secondary dl-btn--sm"
                            onClick={() => onChange({ authors: [...draft.authors, { name: '', role: '' }] })}
                        >
                            Add
                        </button>
                    </div>
                    {draft.authors.length === 0 && <div className="mi-empty">Nobody credited yet.</div>}
                    {draft.authors.map((author, index) => (
                        <div key={index} className="mi-author">
                            <input
                                className="mi-input"
                                value={author.name}
                                placeholder="Name"
                                onChange={(e) =>
                                    onChange({
                                        authors: draft.authors.map((a, i) =>
                                            i === index ? { ...a, name: e.target.value } : a,
                                        ),
                                    })
                                }
                            />
                            <input
                                className="mi-input"
                                value={author.role}
                                placeholder="Role (optional)"
                                onChange={(e) =>
                                    onChange({
                                        authors: draft.authors.map((a, i) =>
                                            i === index ? { ...a, role: e.target.value } : a,
                                        ),
                                    })
                                }
                            />
                            <button
                                className="mi-author__drop"
                                title="Remove contributor"
                                onClick={() => onChange({ authors: draft.authors.filter((_, i) => i !== index) })}
                            >
                                <Icon name="trash" />
                            </button>
                        </div>
                    ))}
                    <span className="mi-field__hint">
                        A contributor with no role is written as a plain name, the way League Toolkit reads it.
                    </span>
                </div>
            </div>
        );
    }

    if (section === 'targets') {
        return (
            <div className="mi-pane">
                <div className="mi-field">
                    <span className="mi-field__label">Tags</span>
                    <ChipRow options={WELL_KNOWN_TAGS} values={draft.tags} onChange={(tags) => onChange({ tags })} />
                    <span className="mi-field__hint">What kind of mod this is. Launchers filter on these.</span>
                </div>

                <div className="mi-field">
                    <span className="mi-field__label">Custom tags</span>
                    <TokenList
                        values={customTags}
                        placeholder="Add a tag"
                        onChange={(next) => onChange({ tags: [...draft.tags.filter((t) => !customTags.includes(t)), ...next] })}
                    />
                </div>

                <div className="mi-field">
                    <span className="mi-field__label">Champions</span>
                    <TokenList
                        values={draft.champions}
                        placeholder="Ahri"
                        onChange={(champions) => onChange({ champions })}
                    />
                    <span className="mi-field__hint">Internal names, one per champion this mod touches.</span>
                </div>

                <div className="mi-field">
                    <span className="mi-field__label">Maps</span>
                    <ChipRow options={WELL_KNOWN_MAPS} values={draft.maps} onChange={(maps) => onChange({ maps })} />
                    <TokenList
                        values={customMaps}
                        placeholder="Add a map"
                        onChange={(next) => onChange({ maps: [...draft.maps.filter((m) => !customMaps.includes(m)), ...next] })}
                    />
                </div>
            </div>
        );
    }

    return (
        <div className="mi-pane">
            <div className="mi-field">
                <span className="mi-field__label">License</span>
                <div className="mi-chips">
                    {(['none', 'spdx', 'custom'] as const).map((kind) => (
                        <button
                            key={kind}
                            className={`mi-chip${draft.licenseKind === kind ? ' mi-chip--on' : ''}`}
                            onClick={() => onChange({ licenseKind: kind })}
                        >
                            {kind === 'none' ? 'Unspecified' : kind === 'spdx' ? 'SPDX id' : 'Custom'}
                        </button>
                    ))}
                </div>
            </div>

            {draft.licenseKind === 'spdx' && (
                <>
                    <label className="mi-field">
                        <span className="mi-field__label">Identifier</span>
                        <input
                            className="mi-input mi-input--short"
                            value={draft.licenseSpdx}
                            placeholder="MIT"
                            spellCheck={false}
                            onChange={(e) => onChange({ licenseSpdx: e.target.value })}
                        />
                    </label>
                    <div className="mi-field">
                        <span className="mi-field__label">Common</span>
                        <div className="mi-chips">
                            {COMMON_LICENSES.map((id) => (
                                <button
                                    key={id}
                                    className={`mi-chip${draft.licenseSpdx === id ? ' mi-chip--on' : ''}`}
                                    onClick={() => onChange({ licenseSpdx: id })}
                                >
                                    {id}
                                </button>
                            ))}
                        </div>
                    </div>
                </>
            )}

            {draft.licenseKind === 'custom' && (
                <>
                    <label className="mi-field">
                        <span className="mi-field__label">Name</span>
                        <input
                            className="mi-input"
                            value={draft.licenseName}
                            placeholder="My terms"
                            onChange={(e) => onChange({ licenseName: e.target.value })}
                        />
                    </label>
                    <label className="mi-field">
                        <span className="mi-field__label">URL</span>
                        <input
                            className="mi-input"
                            value={draft.licenseUrl}
                            placeholder="https://example.com/license"
                            spellCheck={false}
                            onChange={(e) => onChange({ licenseUrl: e.target.value })}
                        />
                    </label>
                </>
            )}

            {draft.licenseKind === 'none' && (
                <div className="mi-empty">
                    Without a license nobody knows what they may do with the mod. An SPDX id is the short way to say it.
                </div>
            )}
        </div>
    );
};
