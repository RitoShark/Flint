import React, { useEffect, useState } from 'react';
import { createPortal } from 'react-dom';
import { Button } from '../ui/Button';
import { DlIcon } from '../ui/design-lab';
import { useModalStore } from '../../lib/stores';
import { projectFilePath, rubyBinLabel } from '../../lib/rubyTargets';
import { sendToRuby } from '../../lib/sendToRuby';
import './SendToRubyModal.css';

/** Which BIN to open in RubyRe, when the project has more than one and none is selected. */
export const SendToRubyModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const options = useModalStore((s) => s.modalOptions) as { projectPath?: string; bins?: string[] } | null;
    const projectPath = options?.projectPath ?? '';
    const bins = options?.bins ?? [];
    const [sending, setSending] = useState<string | null>(null);

    useEffect(() => {
        const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape' && !sending) closeModal(); };
        document.addEventListener('keydown', onKey);
        return () => document.removeEventListener('keydown', onKey);
    }, [sending, closeModal]);

    const pick = async (rel: string) => {
        setSending(rel);
        await sendToRuby(projectFilePath(projectPath, rel));
        setSending(null);
        closeModal();
    };

    return createPortal(
        <div
            className="dl-modal-backdrop"
            onMouseDown={(e) => { if (e.target === e.currentTarget && !sending) closeModal(); }}
        >
            <div className="dl-modal send-ruby" role="dialog" aria-modal="true" aria-label="Open in RubyRe" style={{ maxWidth: 520 }}>
                <div className="dl-modal__head">
                    <h3 className="dl-modal__title">Open in RubyRe</h3>
                    <Button className="dl-modal__close" variant="ghost" size="sm" iconOnly onClick={closeModal} title="Close" disabled={!!sending}>
                        <DlIcon name="close" />
                    </Button>
                </div>
                <div className="dl-modal__body">
                    <p className="send-ruby__hint">This project has {bins.length} BINs. Pick the one to open.</p>
                    <div className="send-ruby__list" role="listbox" aria-label="BINs">
                        {bins.map((rel) => {
                            const { name, where } = rubyBinLabel(rel);
                            return (
                                <button
                                    key={rel}
                                    type="button"
                                    role="option"
                                    aria-selected={sending === rel}
                                    className="send-ruby__row"
                                    disabled={!!sending}
                                    title={rel}
                                    onClick={() => void pick(rel)}
                                >
                                    <span className="send-ruby__name">{name}</span>
                                    <span className="send-ruby__where">{where}</span>
                                </button>
                            );
                        })}
                    </div>
                </div>
            </div>
        </div>,
        document.body,
    );
};
