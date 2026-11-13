import { Button } from '../../ui/Button';
import React, { useState } from 'react';
import { getIcon } from '../../../lib/ui-helpers/fileIcons';
import {
    WELL_KNOWN_MAPS,
    WELL_KNOWN_TAGS,
    toggleValue,
    type ModInfoDraft,
} from '../../../lib/editor/modInfo';
import {
    CC_LICENSE_CATALOG,
    CcLicensePresetPicker,
    OPEN_SOURCE_LICENSE_CATALOG,
    formatLicenseFileText,
    lookupLicenseDetails,
    parseCcLicenseSpdx,
} from '../../../lib/editor/ccLicense';

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
                        <Button
                            variant="secondary" size="sm"
                            onClick={() => onChange({ authors: [...draft.authors, { name: '', role: '' }] })}
                        >
                            Add
                        </Button>
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

    const parsedCc = draft.licenseKind === 'spdx' ? parseCcLicenseSpdx(draft.licenseSpdx) : null;
    const nonCcDetails =
        draft.licenseKind === 'spdx' && !parsedCc ? lookupLicenseDetails(draft.licenseSpdx) : null;
    const isAllRightsReserved =
        draft.licenseKind === 'custom' && draft.licenseName.trim().toLowerCase() === 'all rights reserved';

    const activeLicenseId =
        draft.licenseKind === 'spdx'
            ? draft.licenseSpdx.trim()
            : draft.licenseKind === 'custom'
                ? draft.licenseName.trim()
                : '';

    const licensePreviewText = activeLicenseId
        ? formatLicenseFileText({
              spdx: activeLicenseId,
              url: draft.licenseKind === 'custom' ? draft.licenseUrl.trim() : undefined,
              author: draft.authors.map((a) => a.name.trim()).filter(Boolean).join(', '),
              year: new Date().getFullYear(),
              modName: draft.displayName.trim() || slug,
          })
        : '';

    return (
        <div className="mi-pane">
            <div className="mi-field">
                <span className="mi-field__label">License Mode</span>
                <div className="mi-chips">
                    <button
                        type="button"
                        className={`mi-chip${draft.licenseKind === 'none' ? ' mi-chip--on' : ''}`}
                        onClick={() => onChange({ licenseKind: 'none' })}
                    >
                        Unspecified
                    </button>
                    <button
                        type="button"
                        className={`mi-chip${draft.licenseKind === 'spdx' ? ' mi-chip--on' : ''}`}
                        onClick={() =>
                            onChange({
                                licenseKind: 'spdx',
                                licenseSpdx: draft.licenseSpdx.trim() || 'CC-BY-4.0',
                            })
                        }
                    >
                        Standard / CC / SPDX
                    </button>
                    <button
                        type="button"
                        className={`mi-chip${isAllRightsReserved ? ' mi-chip--on' : ''}`}
                        onClick={() =>
                            onChange({
                                licenseKind: 'custom',
                                licenseName: 'All Rights Reserved',
                                licenseUrl: '',
                            })
                        }
                    >
                        All Rights Reserved
                    </button>
                    <button
                        type="button"
                        className={`mi-chip${draft.licenseKind === 'custom' && !isAllRightsReserved ? ' mi-chip--on' : ''}`}
                        onClick={() =>
                            onChange({
                                licenseKind: 'custom',
                                licenseName: isAllRightsReserved ? '' : draft.licenseName,
                            })
                        }
                    >
                        Custom Terms
                    </button>
                </div>
            </div>

            <div className="mi-field">
                <span className="mi-field__label">Creative Commons Builder (Credits & Permissions)</span>
                <CcLicensePresetPicker
                    value={
                        parsedCc ?? {
                            giveCredit: true,
                            noEdits: false,
                            noCommercial: false,
                            shareAlike: false,
                        }
                    }
                    onChange={(_state, resolved) => onChange({ licenseKind: 'spdx', licenseSpdx: resolved.spdx })}
                />
            </div>

            <div className="mi-field">
                <span className="mi-field__label">Creative Commons Presets</span>
                <div className="mi-chips">
                    {Object.values(CC_LICENSE_CATALOG).map((item) => (
                        <button
                            key={item.spdx}
                            type="button"
                            className={`mi-chip${draft.licenseKind === 'spdx' && draft.licenseSpdx === item.spdx ? ' mi-chip--on' : ''}`}
                            title={item.fullTitle}
                            onClick={() => onChange({ licenseKind: 'spdx', licenseSpdx: item.spdx })}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            </div>

            <div className="mi-field">
                <span className="mi-field__label">Open Source & Code Presets</span>
                <div className="mi-chips">
                    {Object.values(OPEN_SOURCE_LICENSE_CATALOG).map((item) => (
                        <button
                            key={item.spdx}
                            type="button"
                            className={`mi-chip${draft.licenseKind === 'spdx' && draft.licenseSpdx === item.spdx ? ' mi-chip--on' : ''}`}
                            title={item.fullTitle}
                            onClick={() => onChange({ licenseKind: 'spdx', licenseSpdx: item.spdx })}
                        >
                            {item.label}
                        </button>
                    ))}
                </div>
            </div>

            {nonCcDetails && (
                <div className="cc-preset">
                    <div className="cc-preset__summary">
                        <span className="cc-preset__badge">{nonCcDetails.spdx}</span>
                        <span className="cc-preset__summary-text">{nonCcDetails.summary}</span>
                    </div>
                    <div className="cc-preset__breakdown">
                        <div className="cc-preset__col">
                            <span className="cc-preset__col-title cc-preset__col-title--can">Can do</span>
                            <div className="cc-preset__tags">
                                {nonCcDetails.permissions.map((item) => (
                                    <span key={item} className="cc-preset__tag cc-preset__tag--can">
                                        {item}
                                    </span>
                                ))}
                            </div>
                        </div>
                        <div className="cc-preset__col">
                            <span className="cc-preset__col-title cc-preset__col-title--must">Must do (Credits)</span>
                            <div className="cc-preset__tags">
                                {nonCcDetails.conditions.map((item) => (
                                    <span key={item} className="cc-preset__tag cc-preset__tag--must">
                                        {item}
                                    </span>
                                ))}
                            </div>
                        </div>
                        <div className="cc-preset__col">
                            <span className="cc-preset__col-title cc-preset__col-title--cannot">Cannot do</span>
                            <div className="cc-preset__tags">
                                {nonCcDetails.limitations.map((item) => (
                                    <span key={item} className="cc-preset__tag cc-preset__tag--cannot">
                                        {item}
                                    </span>
                                ))}
                            </div>
                        </div>
                    </div>
                </div>
            )}

            {draft.licenseKind === 'spdx' && (
                <label className="mi-field">
                    <span className="mi-field__label">SPDX Identifier</span>
                    <input
                        className="mi-input mi-input--short"
                        value={draft.licenseSpdx}
                        placeholder="CC-BY-NC-4.0"
                        spellCheck={false}
                        onChange={(e) => onChange({ licenseSpdx: e.target.value })}
                    />
                </label>
            )}

            {draft.licenseKind === 'custom' && (
                <>
                    <label className="mi-field">
                        <span className="mi-field__label">License Name</span>
                        <input
                            className="mi-input"
                            value={draft.licenseName}
                            placeholder="All Rights Reserved / Custom Mod License"
                            onChange={(e) => onChange({ licenseName: e.target.value })}
                        />
                    </label>
                    <label className="mi-field">
                        <span className="mi-field__label">License URL (optional)</span>
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
                    Without a license nobody knows what they may do with the mod. Pick a Creative Commons or open-source preset above to generate a LICENSE file in the project root.
                </div>
            )}

            {licensePreviewText && (
                <div className="mi-field">
                    <span className="mi-field__label">Generated LICENSE File Preview</span>
                    <pre className="mi-license-preview">{licensePreviewText}</pre>
                    <span className="mi-field__hint">
                        Written to LICENSE in the project root and shipped inside exported .modpkg packages.
                    </span>
                </div>
            )}
        </div>
    );
};
