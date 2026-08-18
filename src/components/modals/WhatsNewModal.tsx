import React from 'react';
import { useModalStore } from '../../lib/stores';
import { CHANGELOG, type ChangelogEntry, type ChangelogTag } from '../../lib/data/changelog';
import { getVersion } from '@tauri-apps/api/app';
import {
    Button,
    Icon,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
} from '../ui';
import { useTranslation } from '../../lib/i18n';

const TAG_META: Record<ChangelogTag, { label: string; cls: string }> = {
    feature:     { label: 'New Feature',  cls: 'wn-tag--feature' },
    improvement: { label: 'Improvement',  cls: 'wn-tag--improvement' },
    fix:         { label: 'Fix',          cls: 'wn-tag--fix' },
    breaking:    { label: 'Breaking',     cls: 'wn-tag--breaking' },
};

const EntryCard: React.FC<{ entry: ChangelogEntry; index: number }> = ({ entry, index }) => {
    const meta = TAG_META[entry.tag];
    return (
        <div
            className="wn-entry"
            style={{ animationDelay: `${index * 60}ms` }}
        >
            {entry.image && (
                <div className="wn-entry__image">
                    <img src={entry.image} alt={entry.title} draggable={false} />
                </div>
            )}
            <div className="wn-entry__content">
                <div className="wn-entry__head">
                    <span className="wn-entry__icon" aria-hidden>
                        <Icon name={entry.icon as any} />
                    </span>
                    <span className={`wn-tag ${meta.cls}`}>{meta.label}</span>
                </div>
                <strong className="wn-entry__title">{entry.title}</strong>
                {entry.description && (
                    <p className="wn-entry__desc">{entry.description}</p>
                )}
            </div>
        </div>
    );
};

export const WhatsNewModal: React.FC = () => {
    const { t } = useTranslation();
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);

    const isVisible = activeModal === 'whatsNew';

    const [currentVersion, setCurrentVersion] = React.useState<string>('');
    React.useEffect(() => {
        if (isVisible) {
            getVersion().then(setCurrentVersion).catch(() => setCurrentVersion('0.0.0'));
        }
    }, [isVisible]);

    const changelog = CHANGELOG.find((c) => c.version === currentVersion);

    if (!isVisible) return null;

    return (
        <Modal
            open={isVisible}
            onClose={closeModal}
            modifier="modal--whats-new"
        >
            <ModalHeader
                title={
                    <span className="wn-title">
                        <span className="wn-title__icon">
                            <svg width="18" height="18" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                <polygon points="12 2 15.09 8.26 22 9.27 17 14.14 18.18 21.02 12 17.77 5.82 21.02 7 14.14 2 9.27 8.91 8.26 12 2" />
                            </svg>
                        </span>
                        <span className="wn-title__text">
                            <span className="wn-title__name">{t('whatsNew.title')}</span>
                            <span className="wn-title__sub">
                                {changelog
                                    ? `v${changelog.version} · ${changelog.date}`
                                    : currentVersion
                                        ? `v${currentVersion}`
                                        : t('common.loading')}
                            </span>
                        </span>
                    </span>
                }
                onClose={closeModal}
            />

            <ModalBody className="wn-body">
                {changelog ? (
                    <>
                        {changelog.headline && (
                            <div className="wn-hero">
                                <h3 className="wn-hero__title">{changelog.headline}</h3>
                                {changelog.subtitle && (
                                    <p className="wn-hero__sub">{changelog.subtitle}</p>
                                )}
                            </div>
                        )}

                        <div className="wn-entries">
                            {changelog.entries.map((entry, i) => (
                                <EntryCard key={i} entry={entry} index={i} />
                            ))}
                        </div>
                    </>
                ) : (
                    <div className="wn-empty">
                        <Icon name="info" />
                        <p>{t('whatsNew.noChangelog')}</p>
                    </div>
                )}
            </ModalBody>

            <ModalFooter>
                <span className="wn-footer-hint">
                    <Icon name="info" />
                    {t('whatsNew.footerHint')}
                </span>
                <Button variant="primary" onClick={closeModal}>
                    {t('whatsNew.gotIt')}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
