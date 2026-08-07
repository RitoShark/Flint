import React, { useState } from 'react';
import { useModalStore, useNotificationStore, useProjectTabStore, useConfigStore } from '../../lib/stores';
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

const missingListStyle: React.CSSProperties = {
    maxHeight: 260,
    overflowY: 'auto',
    border: '1px solid var(--border)',
    borderRadius: 'var(--dl-radius, 10px)',
    background: 'var(--bg-tertiary)',
    padding: '6px 0',
};

const wadHeadingStyle: React.CSSProperties = {
    padding: '6px 10px 4px',
    fontSize: 11.5,
    fontWeight: 600,
    color: 'var(--text-secondary)',
};

const missingRowStyle: React.CSSProperties = {
    padding: '3px 10px 3px 20px',
    fontSize: 12,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    direction: 'rtl',
    textAlign: 'left',
};

const noteStyle: React.CSSProperties = {
    fontSize: 11.5,
    color: 'var(--text-muted)',
};

export const ExportModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const showToast = useNotificationStore((s) => s.showToast);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const creatorName = useConfigStore((s) => s.creatorName);

    const [format, setFormat] = useState<ExportFormat>('fantome');
    const [isExporting, setIsExporting] = useState(false);
    const [isChecking, setIsChecking] = useState(false);
    const [progress, setProgress] = useState('');
    const [missingReport, setMissingReport] = useState<api.ProjectMissingReport | null>(null);

    const activeTab = activeTabId
        ? openTabs.find((t) => t.id === activeTabId)
        : null;
    const currentProject = activeTab?.project || null;
    const currentProjectPath = activeTab?.projectPath || null;

    const isVisible = activeModal === 'export';
    const exportModalOptions = modalOptions as { format?: ExportFormat } | null;

    React.useEffect(() => {
        if (exportModalOptions?.format) setFormat(exportModalOptions.format);
    }, [exportModalOptions]);

    React.useEffect(() => {
        if (!isVisible) setMissingReport(null);
    }, [isVisible]);

    const runExport = async () => {
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
                    author: currentProject.creator || creatorName || 'Unknown',
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

    const handleExport = async () => {
        if (!currentProjectPath || !currentProject) return;

        setIsChecking(true);
        try {
            const report = await api.auditProjectMissingRefs(currentProjectPath);
            if (report.total_missing > 0) {
                setMissingReport(report);
                return;
            }
        } catch (err) {
            console.debug('Missing-reference check failed, exporting anyway:', err);
        } finally {
            setIsChecking(false);
        }

        await runExport();
    };

    const championLabel = currentProject?.champion ? sanitizeChampionName(currentProject.champion) : '';
    const projectLabel = currentProject?.display_name || currentProject?.name || '';

    if (missingReport) {
        const single = missingReport.total_missing === 1;
        return (
            <Modal open={isVisible} onClose={closeModal} modifier="modal--export">
                {isExporting && <ModalLoading text="Exporting Mod" progress={progress} />}

                <ModalHeader title="Missing file references" />

                <ModalBody>
                    <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                        <Icon name="warning" />
                        <span>
                            {missingReport.total_missing} {single ? 'file' : 'files'} referenced by this
                            mod&apos;s BINs {single ? 'is' : 'are'} not in the project.
                        </span>
                    </div>

                    <div style={missingListStyle}>
                        {missingReport.wads.map((wad) => (
                            <div key={wad.wad}>
                                <div style={wadHeadingStyle}>
                                    {wad.wad} — {wad.missing.length}
                                </div>
                                {wad.missing.map((path) => (
                                    <div key={path} style={missingRowStyle} title={path}>
                                        &#8206;{path}
                                    </div>
                                ))}
                            </div>
                        ))}
                    </div>

                    <p style={noteStyle}>
                        These show up broken in game — usually a magenta texture or a missing effect.
                        Exporting anyway ships the mod as it is.
                    </p>
                </ModalBody>

                <ModalFooter>
                    <Button variant="secondary" onClick={closeModal}>
                        Cancel
                    </Button>
                    <Button variant="primary" onClick={runExport} disabled={isExporting}>
                        Export anyway
                    </Button>
                </ModalFooter>
            </Modal>
        );
    }

    return (
        <Modal open={isVisible} onClose={closeModal} modifier="modal--export">
            {isExporting && <ModalLoading text="Exporting Mod" progress={progress} />}
            {isChecking && <ModalLoading text="Checking file references" />}

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
                <Button variant="primary" onClick={handleExport} disabled={isExporting || isChecking}>
                    Export
                </Button>
            </ModalFooter>
        </Modal>
    );
};
