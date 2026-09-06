import { Button } from '../ui/Button';
import React, { useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalStore } from '../../lib/stores';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { MOD_INFO_SECTIONS, ModInfoForm, type ModInfoSection } from './modinfo/ModInfoForm';
import { useModInfo } from './modinfo/useModInfo';

const Icon: React.FC<{ name: Parameters<typeof getIcon>[0]; className?: string }> = ({ name, className }) => (
    <span className={className} dangerouslySetInnerHTML={{ __html: getIcon(name) }} />
);

export const ModConfigEditorModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);

    const isVisible = activeModal === 'modConfig';
    const filePath = (modalOptions as { filePath?: string } | null)?.filePath ?? null;

    const [section, setSection] = useState<ModInfoSection>('details');
    const { draft, slug, dirty, saving, update, save } = useModInfo(filePath, isVisible, closeModal);

    if (!isVisible) return null;

    return createPortal(
        <div
            className="dl-modal-backdrop"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget && !saving) closeModal();
            }}
        >
            <div className="dl-modal mi-modal" role="dialog" aria-modal="true" aria-label="Project info">
                <div className="dl-modal__head">
                    <span className="mi-mark">
                        <Icon name="settings" />
                    </span>
                    <h3 className="mi-title">
                        Project info
                        <span className="mi-title__slug">{draft?.displayName || slug}</span>
                    </h3>
                    {dirty && <span className="mi-dirty">Unsaved</span>}
                </div>

                <div className="dl-modal__body">
                    <nav className="mi-nav" role="tablist" aria-orientation="vertical">
                        {MOD_INFO_SECTIONS.map((entry) => (
                            <button
                                key={entry.id}
                                role="tab"
                                aria-selected={section === entry.id}
                                className={`mi-nav__item${section === entry.id ? ' is-active' : ''}`}
                                onClick={() => setSection(entry.id)}
                            >
                                <Icon name={entry.icon} className="mi-nav__icon" />
                                <span className="mi-nav__label">{entry.label}</span>
                            </button>
                        ))}
                    </nav>

                    <div className="mi-body" role="tabpanel">
                        {draft ? (
                            <ModInfoForm section={section} draft={draft} slug={slug} onChange={update} />
                        ) : (
                            <div className="mi-empty">Loading project info…</div>
                        )}
                    </div>
                </div>

                <div className="dl-modal__foot">
                    <span className="mi-foot__path">mod.config.json</span>
                    <Button variant="secondary" onClick={closeModal} disabled={saving}>
                        {dirty ? 'Discard' : 'Close'}
                    </Button>
                    <Button
                        variant="primary"
                        onClick={() => void save().then((ok) => ok && closeModal())}
                        disabled={!dirty || saving}
                    >
                        {saving ? 'Saving…' : 'Save'}
                    </Button>
                </div>
            </div>
        </div>,
        document.body,
    );
};
