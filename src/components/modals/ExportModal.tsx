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
import { useTranslation } from '../../lib/i18n';

type ExportFormat = 'fantome' | 'modpkg';

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

const issueRowStyle: React.CSSProperties = {
    padding: '5px 10px 6px 20px',
    fontSize: 12,
    lineHeight: 1.45,
};

const issueFileStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 11.5,
    color: 'var(--text-secondary)',
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    direction: 'rtl',
    textAlign: 'left',
};

const expectedStyle: React.CSSProperties = {
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    fontSize: 11.5,
    color: 'var(--color-success, #10b981)',
};

const IssueList: React.FC<{ heading: string; issues: api.CheckIssue[]; color: string }> = ({ heading, issues, color }) => (
    <>
        <div style={{ ...wadHeadingStyle, color }}>
            {heading} — {issues.length}
        </div>
        {issues.map((issue) => (
            <div key={`${issue.code}:${issue.file}`} style={issueRowStyle}>
                <div style={issueFileStyle} title={issue.file}>
                    &#8206;{issue.file}{issue.line ? ` · line ${issue.line}` : ''}
                </div>
                <div>{issue.message}</div>
                {issue.expected && <div style={expectedStyle}>expected {issue.expected}</div>}
            </div>
        ))}
    </>
);

export const ExportModal: React.FC = () => {
    const { t } = useTranslation();
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const showToast = useNotificationStore((s) => s.showToast);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const creatorName = useConfigStore((s) => s.creatorName);

    const [format, setFormat] = useState<ExportFormat>('modpkg');
    const [isExporting, setIsExporting] = useState(false);
    const [isChecking, setIsChecking] = useState(false);
    const [progress, setProgress] = useState('');
    const [missingReport, setMissingReport] = useState<api.ProjectMissingReport | null>(null);

    const formatOptions = React.useMemo(() => [
        {
            value: 'modpkg' as const,
            label: (
                <>
                    <span>.modpkg</span>{' '}
                    <span
                        style={{
                            display: 'inline-flex',
                            alignItems: 'center',
                            verticalAlign: 'middle',
                            fontSize: 9,
                            fontWeight: 600,
                            lineHeight: 1,
                            textTransform: 'uppercase',
                            letterSpacing: '0.05em',
                            padding: '3px 6px',
                            borderRadius: 999,
                            whiteSpace: 'nowrap',
                            color: 'var(--color-success, #10b981)',
                            border: '1px solid color-mix(in oklab, var(--color-success, #10b981) 35%, transparent)',
                            background: 'color-mix(in oklab, var(--color-success, #10b981) 10%, transparent)',
                        }}
                    >
                        {t('export.recommended')}
                    </span>{' '}
                    <span style={{ color: 'var(--text-secondary)' }}>{t('export.modpkgDesc')}</span>
                </>
            ),
            icon: <Icon name="package" />,
        },
        {
            value: 'fantome' as const,
            label: (
                <>
                    <span>.fantome</span>{' '}
                    <span style={{ color: 'var(--text-secondary)' }}>{t('export.fantomeDesc')}</span>
                </>
            ),
            icon: <Icon name="package" />,
        },
    ], [t]);

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
        setProgress(t('export.packaging'));

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

            showToast('success', t('export.exportedSuccess', { path: result.path }));
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
            if (report.total_missing > 0 || report.issues.length > 0) {
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
        const critical = missingReport.issues.filter((i) => i.severity === 'critical');
        const warnings = missingReport.issues.filter((i) => i.severity === 'warning');
        return (
            <Modal open={isVisible} onClose={closeModal} modifier="modal--export">
                {isExporting && <ModalLoading text={t('export.exporting')} progress={progress} />}

                <ModalHeader title={t('export.preflightTitle')} />

                <ModalBody>
                    {missingReport.total_missing > 0 && (
                        <div style={{ display: 'flex', alignItems: 'center', gap: 8 }}>
                            <Icon name="warning" />
                            <span>
                                {single
                                    ? t('export.missingRefsWarning', { count: missingReport.total_missing })
                                    : t('export.missingRefsWarningPlural', { count: missingReport.total_missing })}
                            </span>
                        </div>
                    )}

                    <div style={missingListStyle}>
                        {critical.length > 0 && (
                            <IssueList heading={t('export.crashRisksHeading')} issues={critical} color="var(--error, #f44)" />
                        )}
                        {warnings.length > 0 && (
                            <IssueList heading={t('export.crashWarningsHeading')} issues={warnings} color="var(--color-warning, #e0a030)" />
                        )}
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
                        {critical.length > 0 ? t('export.crashRisksNote') : t('export.missingRefsNote')}
                    </p>
                </ModalBody>

                <ModalFooter>
                    <Button variant="secondary" onClick={closeModal}>
                        {t('common.cancel')}
                    </Button>
                    <Button variant="primary" onClick={runExport} disabled={isExporting}>
                        {t('export.exportAnyway')}
                    </Button>
                </ModalFooter>
            </Modal>
        );
    }

    return (
        <Modal open={isVisible} onClose={closeModal} modifier="modal--export">
            {isExporting && <ModalLoading text={t('export.exporting')} progress={progress} />}
            {isChecking && <ModalLoading text={t('export.checkingRefs')} />}

            <ModalHeader title={t('export.title')} onClose={closeModal} />

            <ModalBody>
                <FormGroup>
                    <FormLabel>{t('export.format')}</FormLabel>
                    <RadioGroup<ExportFormat>
                        name="format"
                        value={format}
                        onChange={setFormat}
                        options={formatOptions}
                        stacked
                    />
                </FormGroup>

                <FormGroup>
                    <FormLabel>{t('export.project')}</FormLabel>
                    <div style={{ color: 'var(--text-secondary)' }}>
                        {championLabel} - {projectLabel}
                    </div>
                </FormGroup>
            </ModalBody>

            <ModalFooter>
                <Button variant="secondary" onClick={closeModal}>
                    {t('common.cancel')}
                </Button>
                <Button variant="primary" onClick={handleExport} disabled={isExporting || isChecking}>
                    {t('common.export')}
                </Button>
            </ModalFooter>
        </Modal>
    );
};
