import React, { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { MOD_INFO_SECTIONS, ModInfoForm, type ModInfoSection } from '../modals/modinfo/ModInfoForm';
import { useModInfo } from '../modals/modinfo/useModInfo';

type EditorTab = ModInfoSection | 'json';

const Icon: React.FC<{ name: Parameters<typeof getIcon>[0]; className?: string }> = ({ name, className }) => (
    <span className={className} dangerouslySetInnerHTML={{ __html: getIcon(name) }} />
);

interface ModConfigEditorProps {
    filePath: string;
}

export const ModConfigEditor: React.FC<ModConfigEditorProps> = ({ filePath }) => {
    const [tab, setTab] = useState<EditorTab>('details');
    const { draft, rawJson, slug, dirty, saving, update, save } = useModInfo(filePath, true, () => {});

    useEffect(() => {
        const onKeyDown = (e: KeyboardEvent) => {
            if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 's') {
                e.preventDefault();
                if (dirty && !saving) {
                    void save();
                }
            }
        };
        window.addEventListener('keydown', onKeyDown);
        return () => window.removeEventListener('keydown', onKeyDown);
    }, [dirty, saving, save]);

    return (
        <div className="mi-inline">
            <div className="mi-inline__head">
                <span className="mi-inline__mark">
                    <Icon name="settings" />
                </span>
                <div className="mi-inline__titles">
                    <h3 className="mi-inline__title">
                        {draft?.displayName || slug || 'Project Config'}
                        <span className="mi-inline__badge">mod.config.json</span>
                    </h3>
                    <span className="mi-inline__sub">
                        Configure project metadata, contributors, targets, and Creative Commons / SPDX license
                    </span>
                </div>
                <div className="mi-inline__actions">
                    {dirty && <span className="mi-dirty">Unsaved</span>}
                    {tab !== 'license' && (
                        <Button
                            variant="secondary"
                            size="sm"
                            onClick={() => setTab('license')}
                        >
                            Set License…
                        </Button>
                    )}
                    <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void save()}
                        disabled={!dirty || saving}
                    >
                        {saving ? 'Saving…' : 'Save Config'}
                    </Button>
                </div>
            </div>

            <div className="mi-inline__workspace">
                <nav className="mi-nav" role="tablist" aria-orientation="vertical">
                    {MOD_INFO_SECTIONS.map((entry) => (
                        <button
                            key={entry.id}
                            type="button"
                            role="tab"
                            aria-selected={tab === entry.id}
                            className={`mi-nav__item${tab === entry.id ? ' is-active' : ''}`}
                            onClick={() => setTab(entry.id)}
                        >
                            <Icon name={entry.icon} className="mi-nav__icon" />
                            <span className="mi-nav__label">{entry.label}</span>
                        </button>
                    ))}
                    <button
                        type="button"
                        role="tab"
                        aria-selected={tab === 'json'}
                        className={`mi-nav__item${tab === 'json' ? ' is-active' : ''}`}
                        onClick={() => setTab('json')}
                    >
                        <Icon name="code" className="mi-nav__icon" />
                        <span className="mi-nav__label">Raw JSON</span>
                    </button>
                </nav>

                <div className="mi-body" role="tabpanel">
                    {!draft ? (
                        <div className="mi-pane">
                            <div className="mi-empty">Loading mod.config.json…</div>
                        </div>
                    ) : tab === 'json' ? (
                        <div className="mi-pane mi-pane--wide">
                            <div className="mi-field">
                                <span className="mi-field__label">mod.config.json Preview</span>
                                <pre className="mi-license-preview mi-license-preview--json">{rawJson}</pre>
                            </div>
                        </div>
                    ) : (
                        <ModInfoForm section={tab} draft={draft} slug={slug} onChange={update} />
                    )}
                </div>
            </div>
        </div>
    );
};

