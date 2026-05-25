/**
 * Flint - Export Modal Component
 */

import React, { useState } from 'react';
import { useAppState } from '../../lib/stores';
import * as api from '../../lib/api';
import { save } from '@tauri-apps/plugin-dialog';
import { sanitizeChampionName } from '../../lib/util/utils';
import {
    Button,
    FormGroup,
    FormLabel,
    Icon,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    ModalLoading,
    RadioGroup,
} from '../ui';

type ExportFormat = 'fantome' | 'modpkg';

const FORMAT_OPTIONS = [
    {
        value: 'fantome' as const,
        label: (
            <>
                <span>.fantome</span>{' '}
                <span style={{ color: 'var(--text-secondary)' }}>(Fantome Mod Manager)</span>
            </>
        ),
        icon: <Icon name="package" />,
    },
    {
        value: 'modpkg' as const,
        label: (
            <>
                <span>.modpkg</span>{' '}
                <span style={{ color: 'var(--text-secondary)' }}>(League Mod Tools)</span>
            </>
        ),
        icon: <Icon name="package" />,
    },
];

export const ExportModal: React.FC = () => {
    const { state, closeModal, showToast } = useAppState();

    const [format, setFormat] = useState<ExportFormat>('fantome');
    const [isExporting, setIsExporting] = useState(false);
    const [progress, setProgress] = useState('');

    const activeTab = state.activeTabId
        ? state.openTabs.find((t) => t.id === state.activeTabId)
        : null;
    const currentProject = activeTab?.project || null;
    const currentProjectPath = activeTab?.projectPath || null;

    const isVisible = state.activeModal === 'export';
    const modalOptions = state.modalOptions as { format?: ExportFormat } | null;

    React.useEffect(() => {
        if (modalOptions?.format) setFormat(modalOptions.format);
    }, [modalOptions]);

    const handleExport = async () => {
        if (!currentProjectPath || !currentProject) return;

        const ext = format;
        const projectName = currentProject?.display_name || currentProject?.name || 'mod';

        const outputPath = await save({
            title: `Export as .${ext}`,
            defaultPath: `${projectName}.${ext}`,
            filters: [{ name: `${ext.toUpperCase()} Package`, extensions: [ext] }],
        });

        if (!outputPath) return;

        setIsExporting(true);
        setProgress('Packaging mod...');

        try {
            const result = await api.exportProject({
                projectPath: currentProjectPath,
                outputPath,
                format,
                champion: sanitizeChampionName(currentProject.champion),
                metadata: {
                    name: currentProject.name,
                    author: currentProject.creator || state.creatorName || 'Unknown',
                    version: currentProject.version || '1.0.0',
                    description: currentProject.description || '',
                },
            });

            showToast('success', `Exported to ${result.path}`);
            closeModal();
        } catch (err) {
            console.error('Export failed:', err);
            const flintError = err as api.FlintError;
            showToast('error', flintError.getUserMessage?.() || 'Export failed');
        } finally {
            setIsExporting(false);
            setProgress('');
        }
    };

    const championLabel = currentProject?.champion ? sanitizeChampionName(currentProject.champion) : '';
    const projectLabel = currentProject?.display_name || currentProject?.name || '';

    return (
        <Modal open={isVisible} onClose={closeModal} modifier="modal--export">
            {isExporting && <ModalLoading text="Exporting Mod" progress={progress} />}

            <ModalHeader title="Export Mod" onClose={closeModal} />

            <ModalBody>
                <FormGroup>
                    <FormLabel>Export Format</FormLabel>
                    <RadioGroup<ExportFormat>
                        name="format"
                        value={format}
                        onChange={setFormat}
                        options={FORMAT_OPTIONS}
                        stacked
                    />
                </FormGroup>

                <FormGroup>
                    <FormLabel>Project</FormLabel>
                    <div style={{ color: 'var(--text-secondary)' }}>
                        {championLabel} - {projectLabel}
                    </div>
                </FormGroup>
            </ModalBody>

            <ModalFooter>
                <Button variant="secondary" onClick={closeModal}>
                    Cancel
                </Button>
                <Button variant="primary" onClick={handleExport} disabled={isExporting}>
                    Export
                </Button>
            </ModalFooter>
        </Modal>
    );
};
