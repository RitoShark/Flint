import React, { useEffect, useState } from 'react';
import { open } from '@tauri-apps/plugin-dialog';
import { useModalStore, useNotificationStore, useAppMetadataStore } from '../../lib/stores';
import { createSkinProject, resolveProjectsDir } from '../../lib/projectOpen';
import { liveChampionAlias } from '../../lib/data/datadragon';
import * as api from '../../lib/api';
import {
    Button,
    Field,
    FormGroup,
    FormHint,
    FormLabel,
    Input,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
} from '../ui';

export interface CreateProjectFromWadOptions {
    champion: string;
    skinId: number;
    leaguePath: string;
}

function titleCase(s: string): string {
    return s ? s.charAt(0).toUpperCase() + s.slice(1) : s;
}

function suggestedName(champion: string, skinId: number): string {
    return `${titleCase(liveChampionAlias(champion))} Skin${skinId}`;
}

export const CreateProjectFromWadModal: React.FC = () => {
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const closeModal = useModalStore((s) => s.closeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const setWorking = useAppMetadataStore((s) => s.setWorking);
    const setReady = useAppMetadataStore((s) => s.setReady);

    const isVisible = activeModal === 'createProjectFromWad';
    const opts = modalOptions as unknown as CreateProjectFromWadOptions | null;

    const [name, setName] = useState('');
    const [path, setPath] = useState('');
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!isVisible || !opts) return;
        setName(suggestedName(opts.champion, opts.skinId));
        setBusy(false);
        resolveProjectsDir().then(setPath).catch(() => setPath(''));
    }, [isVisible, opts?.champion, opts?.skinId]); // eslint-disable-line react-hooks/exhaustive-deps

    if (!isVisible || !opts) return null;

    const handleBrowse = async () => {
        const picked = await open({ title: 'Choose Project Location', directory: true });
        if (picked) setPath(picked as string);
    };

    const canSubmit = !busy && name.trim().length > 0 && path.trim().length > 0;

    const handleSubmit = async () => {
        if (!canSubmit) return;
        setBusy(true);
        setWorking(`Creating ${name.trim()}…`);
        try {
            await createSkinProject({
                name: name.trim(),
                champion: opts.champion,
                skinId: opts.skinId,
                outputPath: path.trim(),
                leaguePath: opts.leaguePath,
            });
            setReady();
            closeModal();
            showToast('success', 'Project created successfully!');
        } catch (err) {
            const flintError = err as api.FlintError;
            const message = flintError?.getUserMessage?.()
                || (err instanceof Error ? err.message : String(err));
            console.error('[CreateProjectFromWad] failed:', err);
            setReady();
            setBusy(false);
            showToast('error', message);
        }
    };

    return (
        <Modal open onClose={busy ? () => { } : closeModal}>
            <ModalHeader title="Create Project" onClose={busy ? undefined : closeModal} />

            <ModalBody>
                <FormGroup>
                    <FormLabel>Source</FormLabel>
                    <FormHint>
                        {titleCase(opts.champion)} — skin {opts.skinId}. Assets are extracted from your
                        League install, not from the WAD you are browsing.
                    </FormHint>
                </FormGroup>

                <Field
                    label="Project Name"
                    value={name}
                    onChange={(e) => setName(e.target.value)}
                    placeholder={suggestedName(opts.champion, opts.skinId)}
                    autoFocus
                    disabled={busy}
                    onKeyDown={(e) => { if (e.key === 'Enter' && canSubmit) handleSubmit(); }}
                />

                <FormGroup>
                    <FormLabel>Location</FormLabel>
                    <Input
                        placeholder="Select folder…"
                        value={path}
                        onChange={(e) => setPath(e.target.value)}
                        buttonLabel="Browse"
                        onButtonClick={handleBrowse}
                        disabled={busy}
                    />
                </FormGroup>
            </ModalBody>

            <ModalFooter>
                <Button variant="secondary" onClick={closeModal} disabled={busy}>
                    Cancel
                </Button>
                <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
                    {busy ? 'Creating…' : 'Create Project'}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
