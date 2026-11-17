import React, { useEffect, useState } from 'react';
import { Button } from '../ui/Button';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { ModInfoForm, type ModInfoSection } from '../modals/modinfo/ModInfoForm';
import { useModInfo } from '../modals/modinfo/useModInfo';

const Icon: React.FC<{ name: Parameters<typeof getIcon>[0]; className?: string }> = ({ name, className }) => (
    <span className={className} dangerouslySetInnerHTML={{ __html: getIcon(name) }} />
);

interface ModConfigEditorProps {
    filePath: string;
}

export const ModConfigEditor: React.FC<ModConfigEditorProps> = ({ filePath }) => {
    const [showRawJson, setShowRawJson] = useState(false);
    const [section, setSection] = useState<ModInfoSection>('details');
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
                        Your mod, ready to share.
                    </span>
                </div>
                <div className="mi-inline__actions">
                    {dirty && <span className="mi-dirty">Unsaved</span>}
                    <Button
                        variant="secondary"
                        size="sm"
                        onClick={() => setShowRawJson((v) => !v)}
                    >
                        {showRawJson ? 'Visual Editor' : 'Raw JSON'}
                    </Button>
                    <Button
                        variant="primary"
                        size="sm"
                        onClick={() => void save()}
                        disabled={!dirty || saving}
                    >
                        {saving ? 'Saving…' : 'Save changes'}
                    </Button>
                </div>
            </div>

            <nav className="mi-inline__tabs" aria-label="Mod information">
                {([
                    ['details', 'Overview'], ['people', 'People & targets'], ['license', 'License & credits'],
                ] as const).map(([id, label]) => (
                    <Button key={id} variant={!showRawJson && section === id ? 'primary' : 'ghost'} size="sm"
                        aria-pressed={!showRawJson && section === id}
                        onClick={() => { setSection(id); setShowRawJson(false); }}>{label}</Button>
                ))}
            </nav>
            <div className="mi-inline__workspace">
                <div className="mi-body">
                    {!draft ? (
                        <div className="mi-pane">
                            <div className="mi-empty">Loading mod.config.json…</div>
                        </div>
                    ) : showRawJson ? (
                        <div className="mi-pane mi-pane--wide">
                            <div className="mi-field">
                                <span className="mi-field__label">mod.config.json Preview</span>
                                <pre className="mi-license-preview mi-license-preview--json">{rawJson}</pre>
                            </div>
                        </div>
                    ) : (
                        <div className="mi-inline__content">
                            <aside className="mi-summary">
                                <span className="mi-summary__eyebrow">MOD INFORMATION</span>
                                <h2>{draft.displayName || slug || 'Untitled mod'}</h2>
                                <span className="mi-inline__badge">{draft.version || 'No version'}</span>
                                <p>{draft.description || 'Add a description so players know what your mod changes.'}</p>
                                <dl>
                                    <dt>By</dt><dd>{draft.authors.map(a => a.name).filter(Boolean).join(', ') || 'Add a contributor'}</dd>
                                    <dt>Champions</dt><dd>{draft.champions.join(', ') || 'Not specified'}</dd>
                                    <dt>License</dt><dd>{draft.licenseKind === 'spdx' ? draft.licenseSpdx : draft.licenseName || 'Not specified'}</dd>
                                </dl>
                            </aside>
                            <ModInfoForm section={section} draft={draft} slug={slug} onChange={update} />
                        </div>
                    )}
                </div>
            </div>
        </div>
    );
};
