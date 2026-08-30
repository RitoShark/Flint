import React, { useCallback, useEffect, useMemo, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalStore, useNotificationStore, useProjectTabStore } from '../../lib/stores';
import { useAppMetadataStore } from '../../lib/stores/appMetadataStore';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { issueTagsFromIssues } from '../../lib/audit/projectAudit';
import { revealInTree } from '../../lib/editor/revealInTree';
import * as api from '../../lib/api';

type Tab = 'missing' | 'bloat' | 'risks';

function formatBytes(bytes: number): string {
    if (bytes < 1024) return `${bytes} B`;
    const units = ['KB', 'MB', 'GB'];
    let value = bytes / 1024;
    let unit = 0;
    while (value >= 1024 && unit < units.length - 1) {
        value /= 1024;
        unit += 1;
    }
    return `${value < 10 ? value.toFixed(1) : Math.round(value)} ${units[unit]}`;
}

const rowStyle: React.CSSProperties = {
    display: 'flex',
    alignItems: 'center',
    gap: 10,
    padding: '6px 10px',
    borderBottom: '1px solid var(--border)',
    fontSize: 12,
    fontFamily: 'var(--font-mono, ui-monospace, monospace)',
    minWidth: 0,
};

const pathStyle: React.CSSProperties = {
    flex: 1,
    minWidth: 0,
    overflow: 'hidden',
    textOverflow: 'ellipsis',
    whiteSpace: 'nowrap',
    direction: 'rtl',
    textAlign: 'left',
};

const emptyStyle: React.CSSProperties = {
    display: 'flex',
    flexDirection: 'column',
    alignItems: 'center',
    justifyContent: 'center',
    gap: 8,
    padding: '48px 16px',
    color: 'var(--text-muted)',
    fontSize: 13,
};

const statStyle: React.CSSProperties = {
    fontSize: 11.5,
    color: 'var(--text-muted)',
};

export const WadAuditModal: React.FC = () => {
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const closeModal = useModalStore((s) => s.closeModal);
    const showToast = useNotificationStore((s) => s.showToast);

    const folderPath = (modalOptions?.folderPath as string) || '';
    const folderName = (modalOptions?.folderName as string) || 'WAD folder';
    const initialTab = (modalOptions?.tab as Tab) || 'missing';

    const [tab, setTab] = useState<Tab>(initialTab);
    const [report, setReport] = useState<api.AuditReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    const isVisible = activeModal === 'wadAudit';

    useEffect(() => {
        if (!isVisible || !folderPath) return;
        let cancelled = false;
        setLoading(true);
        setError(null);
        setReport(null);
        setTab(initialTab);
        api.auditWadFolder(folderPath)
            .then((result) => {
                if (!cancelled) setReport(result);
                useAppMetadataStore
                    .getState()
                    .replaceFileIssues(folderPath, issueTagsFromIssues(result.issues, folderPath.replaceAll('\\', '/')));
            })
            .catch((e) => {
                if (!cancelled) setError(e instanceof Error ? e.message : String(e));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isVisible, folderPath, initialTab]);

    useEffect(() => {
        if (!isVisible) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeModal();
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isVisible, closeModal]);

    const rows = useMemo(() => {
        if (!report) return [];
        if (tab === 'missing') return report.missing.map((p) => ({ path: p, size: null as number | null }));
        if (tab === 'risks') return report.issues.map((i) => ({ path: i.file, size: null as number | null }));
        return report.bloat.map((b) => ({ path: b.path, size: b.size }));
    }, [report, tab]);

    const copyList = () => {
        if (!rows.length) return;
        void navigator.clipboard.writeText(rows.map((r) => r.path).join('\n'));
        showToast('success', `${rows.length} path${rows.length === 1 ? '' : 's'} copied`);
    };

    const projectPath = useProjectTabStore((s) => {
        const tab = s.openTabs.find((t) => t.id === s.activeTabId);
        return tab?.projectPath || '';
    });

    const revealRow = useCallback(
        (relInFolder: string) => {
            if (!projectPath) return;
            const folderNorm = folderPath.replaceAll('\\', '/');
            const projectNorm = projectPath.replaceAll('\\', '/');
            if (!folderNorm.toLowerCase().startsWith(`${projectNorm.toLowerCase()}/`)) return;
            const folderRel = folderNorm.slice(projectNorm.length + 1);
            if (revealInTree(`${folderRel.toLowerCase()}/${relInFolder}`)) closeModal();
        },
        [projectPath, folderPath, closeModal],
    );

    if (!isVisible) return null;

    return createPortal(
        <div
            className="dl-modal-backdrop"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) closeModal();
            }}
        >
            <div className="dl-modal dl-modal--wide" role="dialog" aria-modal="true">
                <div className="dl-modal__head">
                    <h3 className="dl-modal__title">Check files — {folderName}</h3>
                </div>

                <div className="dl-modal__body" style={{ gap: 10, minHeight: 340 }}>
                    <div className="dl-tabs" role="tablist">
                        <button
                            className={`dl-tab${tab === 'missing' ? ' dl-tab--active' : ''}`}
                            role="tab"
                            aria-selected={tab === 'missing'}
                            onClick={() => setTab('missing')}
                        >
                            Missing{report ? ` (${report.missing.length})` : ''}
                        </button>
                        <button
                            className={`dl-tab${tab === 'bloat' ? ' dl-tab--active' : ''}`}
                            role="tab"
                            aria-selected={tab === 'bloat'}
                            onClick={() => setTab('bloat')}
                        >
                            Bloat{report ? ` (${report.bloat.length})` : ''}
                        </button>
                        <button
                            className={`dl-tab${tab === 'risks' ? ' dl-tab--active' : ''}`}
                            role="tab"
                            aria-selected={tab === 'risks'}
                            onClick={() => setTab('risks')}
                        >
                            Crash risks{report ? ` (${report.issues.length})` : ''}
                        </button>
                    </div>

                    <p style={statStyle}>
                        {tab === 'missing' &&
                            'Assets a BIN references that are not present in this folder — these show up broken in game.'}
                        {tab === 'bloat' &&
                            'Files present here that no BIN references. Anything under an icons2d folder is excluded, since those are referenced by hashes that often cannot be resolved.'}
                        {tab === 'risks' &&
                            'Files shaped in a way the client cannot load — textures, animation graphs, BIN references. Criticals break the mod for everyone who installs it.'}
                    </p>

                    <div
                        style={{
                            flex: 1,
                            minHeight: 200,
                            maxHeight: 380,
                            overflowY: 'auto',
                            border: '1px solid var(--border)',
                            borderRadius: 'var(--dl-radius, 10px)',
                            background: 'var(--bg-tertiary)',
                        }}
                    >
                        {loading && <div style={emptyStyle}>Scanning {folderName}…</div>}

                        {!loading && error && (
                            <div style={{ ...emptyStyle, color: 'var(--danger)' }}>{error}</div>
                        )}

                        {!loading && !error && rows.length === 0 && (
                            <div style={emptyStyle}>
                                <span
                                    style={{ display: 'flex', alignItems: 'center', justifyContent: 'center' }}
                                    dangerouslySetInnerHTML={{ __html: getIcon('check') }}
                                />
                                {tab === 'missing' && 'No missing references.'}
                                {tab === 'bloat' && 'No unreferenced files.'}
                                {tab === 'risks' && 'Nothing here will stop the game loading.'}
                            </div>
                        )}

                        {!loading && !error && tab === 'risks' && report
                            ? report.issues.map((issue) => (
                                <div
                                    key={`${issue.code}:${issue.file}`}
                                    style={{ ...rowStyle, display: 'block', cursor: 'pointer' }}
                                    title="Click to reveal in the file tree"
                                    onClick={() => revealRow(issue.file)}
                                >
                                    <div style={{ display: 'flex', alignItems: 'center', gap: 6 }}>
                                        <span
                                            style={{
                                                flex: 'none',
                                                fontSize: 10,
                                                fontWeight: 700,
                                                textTransform: 'uppercase',
                                                letterSpacing: '0.06em',
                                                color: issue.severity === 'critical' ? 'var(--danger)' : 'var(--color-warning, #e0a030)',
                                            }}
                                        >
                                            {issue.severity}
                                        </span>
                                        <span style={pathStyle} title={issue.file}>
                                            &#8206;{issue.file}{issue.line ? ` · line ${issue.line}` : ''}
                                        </span>
                                    </div>
                                    <div style={{ fontSize: 12, lineHeight: 1.45, paddingTop: 2 }}>{issue.message}</div>
                                    {issue.expected && (
                                        <div style={{ fontFamily: 'var(--font-mono)', fontSize: 11.5, color: 'var(--color-success, #10b981)' }}>
                                            expected {issue.expected}
                                        </div>
                                    )}
                                </div>
                            ))
                            : !loading &&
                              !error &&
                              rows.map((row) => (
                                <div
                                    key={row.path}
                                    style={tab === 'bloat' ? { ...rowStyle, cursor: 'pointer' } : rowStyle}
                                    title={tab === 'bloat' ? 'Click to reveal in the file tree' : row.path}
                                    onClick={tab === 'bloat' ? () => revealRow(row.path) : undefined}
                                >
                                    <span style={pathStyle}>&#8206;{row.path}</span>
                                    {row.size !== null && (
                                        <span style={{ ...statStyle, flex: 'none' }}>{formatBytes(row.size)}</span>
                                    )}
                                </div>
                            ))}
                    </div>

                    {report && !loading && !error && (
                        <p style={statStyle}>
                            {report.files_scanned.toLocaleString()} files, {report.bins_scanned.toLocaleString()} BINs
                            scanned
                            {report.bins_failed > 0 && ` (${report.bins_failed} unreadable)`}
                            {tab === 'bloat' && report.bloat_bytes > 0 && ` — ${formatBytes(report.bloat_bytes)} unreferenced`}
                        </p>
                    )}
                </div>

                <div className="dl-modal__foot" style={{ justifyContent: 'space-between' }}>
                    <button className="dl-btn dl-btn--ghost" onClick={copyList} disabled={!rows.length}>
                        Copy list
                    </button>
                    <button className="dl-btn dl-btn--primary" onClick={closeModal}>
                        Close
                    </button>
                </div>
            </div>
        </div>,
        document.body
    );
};
