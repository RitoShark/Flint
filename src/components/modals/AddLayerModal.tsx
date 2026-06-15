import React, { useEffect, useMemo, useState } from 'react';
import { useModalStore, useNotificationStore, useProjectTabStore } from '../../lib/stores';
import * as api from '../../lib/api';
import {
    Button,
    Checkbox,
    Field,
    FormGroup,
    FormHint,
    FormLabel,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    ModalLoading,
    Select,
} from '../ui';

type CategoryId = 'animation' | 'model' | 'particle' | 'audio';

interface Category {
    id: CategoryId;
    label: string;
    hint: string;
}

const CATEGORIES: Category[] = [
    { id: 'animation', label: 'Animations', hint: '.anm files and content under animations/' },
    { id: 'model',     label: 'Models',     hint: '.skn / .scb / .sco meshes plus the textures sitting next to them' },
    { id: 'particle',  label: 'Particles (VFX)', hint: 'particles/ folders + matching VFX .bin' },
    { id: 'audio',     label: 'Audio',      hint: '.bnk / .wpk / .wem and sounds/ folders' },
];

const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

export const AddLayerModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);

    const activeTab = activeTabId
        ? openTabs.find((t) => t.id === activeTabId)
        : null;
    const projectPath = activeTab?.projectPath || null;

    const isVisible = activeModal === 'addLayer';

    const [layerName, setLayerName] = useState('');
    const [description, setDescription] = useState('');
    const [sourceLayer, setSourceLayer] = useState('base');
    const [layerOptions, setLayerOptions] = useState<string[]>(['base']);
    const [selected, setSelected] = useState<Set<CategoryId>>(
        () => new Set(['animation', 'model', 'particle', 'audio']),
    );
    const [busy, setBusy] = useState(false);

    useEffect(() => {
        if (!isVisible || !projectPath) return;
        let cancelled = false;
        api.listProjectLayers(projectPath)
            .then((names) => {
                if (cancelled) return;
                const safe = names.length > 0 ? names : ['base'];
                setLayerOptions(safe);
                setSourceLayer((prev) => (safe.includes(prev) ? prev : safe[0]));
            })
            .catch(() => {
                if (!cancelled) setLayerOptions(['base']);
            });
        return () => {
            cancelled = true;
        };
    }, [isVisible, projectPath]);

    useEffect(() => {
        if (isVisible) {
            setLayerName('');
            setDescription('');
            setSelected(new Set(['animation', 'model', 'particle', 'audio']));
            setBusy(false);
        }
    }, [isVisible]);

    const trimmed = layerName.trim();
    const slugError = useMemo(() => {
        if (!trimmed) return null;
        if (!SLUG_RE.test(trimmed)) {
            return 'Use letters, digits, underscores, and hyphens only.';
        }
        if (layerOptions.includes(trimmed)) {
            return 'A layer with that name already exists.';
        }
        return null;
    }, [trimmed, layerOptions]);

    const canSubmit = !!projectPath && !!trimmed && !slugError && !busy;

    const toggle = (id: CategoryId) => {
        setSelected((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    };

    const handleSubmit = async () => {
        if (!projectPath || !trimmed || slugError) return;
        setBusy(true);
        try {
            const result = await api.createProjectLayer({
                projectPath,
                layerName: trimmed,
                sourceLayer,
                categories: Array.from(selected),
                description: description.trim() || undefined,
            });
            const sizeMb = (result.bytes_copied / (1024 * 1024)).toFixed(1);
            showToast(
                'success',
                `Layer "${result.layer_name}" created — ${result.files_copied} file${
                    result.files_copied === 1 ? '' : 's'
                } copied (${sizeMb} MB)`,
            );
            closeModal();
        } catch (err) {
            const flintError = err as api.FlintError;
            showToast(
                'error',
                flintError.getUserMessage?.() || 'Failed to create layer',
            );
        } finally {
            setBusy(false);
        }
    };

    return (
        <Modal open={isVisible} onClose={busy ? () => {} : closeModal}>
            {busy && <ModalLoading text="Creating Layer" progress="Copying files..." />}

            <ModalHeader title="Add Layer" onClose={closeModal} />

            <ModalBody>
                <Field
                    label="Layer name"
                    hint="No spaces. Letters, digits, underscores, hyphens. Example: chroma_red"
                    error={slugError ?? undefined}
                    value={layerName}
                    onChange={(e) => setLayerName(e.target.value)}
                    placeholder="my_layer"
                    autoFocus
                    disabled={busy}
                />

                <Field
                    label="Description (optional)"
                    value={description}
                    onChange={(e) => setDescription(e.target.value)}
                    placeholder="High-res chroma textures"
                    disabled={busy}
                />

                <FormGroup>
                    <FormLabel>Copy from</FormLabel>
                    <Select
                        value={sourceLayer}
                        onChange={(e) => setSourceLayer(e.target.value)}
                        disabled={busy || layerOptions.length <= 1}
                    >
                        {layerOptions.map((name) => (
                            <option key={name} value={name}>
                                {name}
                            </option>
                        ))}
                    </Select>
                    <FormHint>The new layer is seeded from this existing layer.</FormHint>
                </FormGroup>

                <FormGroup>
                    <FormLabel>Categories to copy</FormLabel>
                    <FormHint>
                        Only files matching these categories are copied into the new layer.
                        Uncheck everything to create an empty layer.
                    </FormHint>
                    <div style={{ display: 'flex', flexDirection: 'column', gap: 6, marginTop: 6 }}>
                        {CATEGORIES.map((cat) => (
                            <Checkbox
                                key={cat.id}
                                checked={selected.has(cat.id)}
                                onChange={() => toggle(cat.id)}
                                disabled={busy}
                                label={
                                    <span>
                                        <span style={{ fontWeight: 500 }}>{cat.label}</span>
                                        <span style={{ color: 'var(--text-secondary)', marginLeft: 8 }}>
                                            — {cat.hint}
                                        </span>
                                    </span>
                                }
                            />
                        ))}
                    </div>
                </FormGroup>
            </ModalBody>

            <ModalFooter>
                <Button variant="secondary" onClick={closeModal} disabled={busy}>
                    Cancel
                </Button>
                <Button variant="primary" onClick={handleSubmit} disabled={!canSubmit}>
                    Create Layer
                </Button>
            </ModalFooter>
        </Modal>
    );
};
