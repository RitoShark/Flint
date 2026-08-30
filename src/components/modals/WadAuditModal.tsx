import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalStore, useNavigationStore, useNotificationStore, useProjectTabStore } from '../../lib/stores';
import { useAppMetadataStore } from '../../lib/stores/appMetadataStore';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { issueTagsFromIssues } from '../../lib/audit/projectAudit';
import { requestRevealLine } from '../../lib/editor/binEditorEvents';
import { revealInTree } from '../../lib/editor/revealInTree';
import { VirtualList } from '../preview/VirtualList';
import * as api from '../../lib/api';

type View = 'risks' | 'missing' | 'bloat';

interface FlatRow {
    path: string;
    size: number | null;
    tone: 'warning' | 'muted';
    reveal: boolean;
}

const FLAT_ROW_HEIGHT = 30;

/** The one finding a one-click resize actually resolves. */
const ALIGNMENT_CODE = 'texture.block-misaligned';

const VIEW_HINT: Record<View, string> = {
    risks: 'Files the client cannot load — textures, animation clips, BIN references. A critical breaks the mod for everyone who installs it.',
    missing: 'Assets a BIN points at that are not in this folder. They render broken in game.',
    bloat: 'Files here that no BIN points at. Anything under an icons2d folder is left out, since those are referenced by hashes that often cannot be resolved.',
};

const VIEW_EMPTY: Record<View, string> = {
    risks: 'Nothing here will stop the game loading.',
    missing: 'Every referenced asset is present.',
    bloat: 'Every file here is referenced.',
};

const Icon: React.FC<{ name: Parameters<typeof getIcon>[0]; className?: string }> = ({ name, className }) => (
    <span className={className} dangerouslySetInnerHTML={{ __html: getIcon(name) }} />
);

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

export const WadAuditModal: React.FC = () => {
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const closeModal = useModalStore((s) => s.closeModal);
    const showToast = useNotificationStore((s) => s.showToast);

    const folderPath = (modalOptions?.folderPath as string) || '';
    const folderName = (modalOptions?.folderName as string) || 'WAD folder';

    const [view, setView] = useState<View>('risks');
    const [query, setQuery] = useState('');
    const [report, setReport] = useState<api.AuditReport | null>(null);
    const [loading, setLoading] = useState(true);
    const [fixing, setFixing] = useState(false);
    const [error, setError] = useState<string | null>(null);
    const searchRef = useRef<HTMLInputElement | null>(null);

    const isVisible = activeModal === 'wadAudit';

    /* `pickView` is only true for the first scan of a folder — a rescan after a fix must
       leave the user on the view they are working in. */
    const scan = useCallback(
        async (pickView: boolean) => {
            if (!folderPath) return;
            setLoading(true);
            setError(null);
            try {
                const result = await api.auditWadFolder(folderPath);
                setReport(result);
                if (pickView) {
                    setView(result.issues.length ? 'risks' : result.missing.length ? 'missing' : 'bloat');
                }
                useAppMetadataStore
                    .getState()
                    .replaceFileIssues(
                        folderPath,
                        issueTagsFromIssues(result.issues, folderPath.replaceAll('\\', '/')),
                    );
            } catch (e) {
                setError(e instanceof Error ? e.message : String(e));
            } finally {
                setLoading(false);
            }
        },
        [folderPath],
    );

    useEffect(() => {
        if (!isVisible || !folderPath) return;
        setReport(null);
        setQuery('');
        void scan(true);
    }, [isVisible, folderPath, scan]);

    useEffect(() => {
        if (!isVisible) return;
        const onKey = (e: KeyboardEvent) => {
            if (e.key === 'Escape') closeModal();
            if (e.key === 'f' && (e.ctrlKey || e.metaKey)) {
                e.preventDefault();
                searchRef.current?.focus();
            }
        };
        window.addEventListener('keydown', onKey);
        return () => window.removeEventListener('keydown', onKey);
    }, [isVisible, closeModal]);

    const needle = query.trim().toLowerCase();

    const issues = useMemo(() => {
        if (!report) return [];
        if (!needle) return report.issues;
        return report.issues.filter(
            (i) =>
                i.file.toLowerCase().includes(needle) ||
                i.message.toLowerCase().includes(needle) ||
                i.code.toLowerCase().includes(needle),
        );
    }, [report, needle]);

    const missing = useMemo(() => {
        if (!report) return [];
        return needle ? report.missing.filter((p) => p.toLowerCase().includes(needle)) : report.missing;
    }, [report, needle]);

    const bloat = useMemo(() => {
        if (!report) return [];
        return needle ? report.bloat.filter((b) => b.path.toLowerCase().includes(needle)) : report.bloat;
    }, [report, needle]);

    const criticalCount = useMemo(() => issues.filter((i) => i.severity === 'critical').length, [issues]);

    const shownPaths = useMemo(() => {
        if (view === 'risks') return issues.map((i) => i.file);
        if (view === 'missing') return missing;
        return bloat.map((b) => b.path);
    }, [view, issues, missing, bloat]);

    const copyList = () => {
        if (!shownPaths.length) return;
        void navigator.clipboard.writeText(shownPaths.join('\n'));
        showToast('success', `${shownPaths.length} path${shownPaths.length === 1 ? '' : 's'} copied`);
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

    const navigateToFileEditor = useNavigationStore((s) => s.navigateToFileEditor);

    const absPath = useCallback(
        (rel: string) => `${folderPath}\\${rel.replaceAll('/', '\\')}`,
        [folderPath],
    );

    /* A finding on a BIN carries the line it sits on, so the useful destination is the
       editor at that line, not the tree row. Everything else — textures, meshes — has
       nothing to open a line in, so those still reveal in the tree. */
    const openIssue = useCallback(
        (issue: api.CheckIssue) => {
            if (!issue.file.toLowerCase().endsWith('.bin')) {
                revealRow(issue.file);
                return;
            }
            const target = absPath(issue.file);
            if (issue.line) requestRevealLine(target, issue.line);
            navigateToFileEditor({ filePath: target, kind: 'binText', projectPath });
            closeModal();
        },
        [absPath, revealRow, navigateToFileEditor, projectPath, closeModal],
    );

    const fixable = useMemo(
        () => issues.filter((i) => i.code === ALIGNMENT_CODE).map((i) => i.file),
        [issues],
    );

    const fixAlignment = useCallback(
        async (files: string[]) => {
            if (!files.length || fixing) return;
            setFixing(true);
            const failures: string[] = [];
            for (const file of files) {
                try {
                    await api.fixTextureAlignment(absPath(file));
                } catch (e) {
                    failures.push(`${file}: ${e instanceof Error ? e.message : String(e)}`);
                }
            }
            setFixing(false);
            const fixed = files.length - failures.length;
            if (fixed) showToast('success', `Resized ${fixed} texture${fixed === 1 ? '' : 's'} to the block grid`);
            if (failures.length) {
                showToast('error', `${failures.length} could not be resized — ${failures[0]}`);
            }
            if (fixed) await scan(false);
        },
        [absPath, fixing, showToast, scan],
    );

    if (!isVisible) return null;

    const navItem = (
        id: View,
        icon: Parameters<typeof getIcon>[0],
        label: string,
        count: number,
        tone: 'danger' | 'warn' | null,
    ) => {
        const clean = count === 0;
        const toneClass = clean ? 'clean' : tone ?? '';
        return (
            <button
                key={id}
                className={`wa-nav__item${toneClass ? ` wa-nav__item--${toneClass}` : ''}${view === id ? ' is-active' : ''}`}
                role="tab"
                aria-selected={view === id}
                onClick={() => setView(id)}
            >
                <Icon name={clean ? 'check' : icon} className="wa-nav__icon" />
                <span className="wa-nav__label">{label}</span>
                <span className={`wa-count${clean || !tone ? '' : ` wa-count--${tone}`}`}>{count}</span>
            </button>
        );
    };

    const flatRow = (row: FlatRow) => (
        <div
            className={`wa-row wa-row--flat wa-row--${row.tone}${row.reveal ? ' wa-row--click' : ''}`}
            title={row.reveal ? `${row.path} — click to reveal in the file tree` : row.path}
            role={row.reveal ? 'button' : undefined}
            tabIndex={row.reveal ? 0 : undefined}
            onClick={row.reveal ? () => revealRow(row.path) : undefined}
            onKeyDown={
                row.reveal
                    ? (e) => {
                        if (e.key === 'Enter' || e.key === ' ') {
                            e.preventDefault();
                            revealRow(row.path);
                        }
                    }
                    : undefined
            }
        >
            <Icon name={row.tone === 'warning' ? 'warning' : 'trash'} className="wa-row__icon" />
            <div className="wa-row__main">
                <span className="wa-row__path">&#8206;{row.path}</span>
                {row.size !== null && <span className="wa-row__size">{formatBytes(row.size)}</span>}
            </div>
        </div>
    );

    const body = () => {
        if (loading) {
            return (
                <div className="wa-state wa-state--neutral">
                    <span className="wa-state__mark">
                        <Icon name="refresh" className="wa-spin" />
                    </span>
                    Scanning {folderName}…
                </div>
            );
        }
        if (error) {
            return (
                <div className="wa-state wa-state--error">
                    <span className="wa-state__mark">
                        <Icon name="error" />
                    </span>
                    {error}
                </div>
            );
        }

        if (view === 'risks') {
            if (!issues.length) {
                return (
                    <div className="wa-state">
                        <span className="wa-state__mark">
                            <Icon name="check" />
                        </span>
                        {needle ? 'No finding matches that search.' : VIEW_EMPTY.risks}
                    </div>
                );
            }
            return (
                <div className="wa-list">
                    {issues.map((issue) => (
                        <div
                            key={`${issue.code}:${issue.file}`}
                            className={`wa-row wa-row--${issue.severity} wa-row--click`}
                            role="button"
                            tabIndex={0}
                            title={
                                issue.file.toLowerCase().endsWith('.bin')
                                    ? `${issue.code} — click to open the BIN${issue.line ? ` at line ${issue.line}` : ''}`
                                    : `${issue.code} — click to reveal in the file tree`
                            }
                            onClick={() => openIssue(issue)}
                            onKeyDown={(e) => {
                                if (e.key === 'Enter' || e.key === ' ') {
                                    e.preventDefault();
                                    openIssue(issue);
                                }
                            }}
                        >
                            <Icon
                                name={issue.severity === 'critical' ? 'error' : 'warning'}
                                className="wa-row__icon"
                            />
                            <div className="wa-row__main">
                                <div className="wa-row__head">
                                    <span className="wa-row__path">&#8206;{issue.file}</span>
                                    {issue.line ? <span className="wa-row__line">line {issue.line}</span> : null}
                                    {issue.code === ALIGNMENT_CODE && (
                                        <button
                                            className="wa-fix"
                                            disabled={fixing}
                                            title="Resize up to the next multiple of 4 and rewrite this file"
                                            onClick={(e) => {
                                                e.stopPropagation();
                                                void fixAlignment([issue.file]);
                                            }}
                                        >
                                            Resize to fit
                                        </button>
                                    )}
                                </div>
                                <div className="wa-row__msg">{issue.message}</div>
                                {issue.expected && (
                                    <div className="wa-row__expected">
                                        <b>expected</b>
                                        {issue.expected}
                                    </div>
                                )}
                            </div>
                        </div>
                    ))}
                </div>
            );
        }

        const rows: FlatRow[] =
            view === 'missing'
                ? missing.map((path) => ({ path, size: null, tone: 'warning' as const, reveal: false }))
                : bloat.map((b) => ({ path: b.path, size: b.size, tone: 'muted' as const, reveal: true }));
        if (!rows.length) {
            return (
                <div className="wa-state">
                    <span className="wa-state__mark">
                        <Icon name="check" />
                    </span>
                    {needle ? 'No path matches that search.' : VIEW_EMPTY[view]}
                </div>
            );
        }
        return (
            <div className="wa-list wa-list--virtual">
                <VirtualList items={rows} rowHeight={FLAT_ROW_HEIGHT} renderRow={flatRow} />
            </div>
        );
    };

    return createPortal(
        <div
            className="dl-modal-backdrop"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget) closeModal();
            }}
        >
            <div className="dl-modal wa-modal" role="dialog" aria-modal="true" aria-label="Check files">
                <div className="dl-modal__head">
                    <span className="wa-mark">
                        <Icon name="search" />
                    </span>
                    <h3 className="wa-title">
                        Check files
                        <span className="wa-title__folder">{folderName}</span>
                    </h3>
                    <div className="wa-search">
                        <span className="wa-search__icon">
                            <Icon name="search" />
                        </span>
                        <input
                            ref={searchRef}
                            className="wa-search__input"
                            placeholder="Filter paths"
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            spellCheck={false}
                        />
                        {query && (
                            <button className="wa-search__clear" onClick={() => setQuery('')} title="Clear filter">
                                <Icon name="close" />
                            </button>
                        )}
                    </div>
                </div>

                <div className="dl-modal__body">
                    <nav className="wa-nav" role="tablist" aria-orientation="vertical">
                        {navItem('risks', 'error', 'Crash risks', issues.length, criticalCount ? 'danger' : 'warn')}
                        {navItem('missing', 'warning', 'Missing', missing.length, 'warn')}
                        {navItem('bloat', 'trash', 'Unreferenced', bloat.length, null)}
                        <span className="wa-nav__spacer" />
                        {report && !loading && !error && (
                            <div className="wa-nav__stats">
                                <span>{report.files_scanned.toLocaleString()} files</span>
                                <span>
                                    {report.bins_scanned.toLocaleString()} BINs
                                    {report.bins_failed > 0 && ` · ${report.bins_failed} unreadable`}
                                </span>
                                {report.bloat_bytes > 0 && <span>{formatBytes(report.bloat_bytes)} unreferenced</span>}
                            </div>
                        )}
                    </nav>

                    <div className="wa-pane" role="tabpanel">
                        <p className="wa-pane__hint">{VIEW_HINT[view]}</p>
                        {body()}
                    </div>
                </div>

                <div className="dl-modal__foot">
                    <div className="wa-foot__actions">
                        <button className="dl-btn dl-btn--ghost" onClick={copyList} disabled={!shownPaths.length}>
                            Copy list
                        </button>
                        {view === 'risks' && fixable.length > 1 && (
                            <button
                                className="dl-btn dl-btn--secondary"
                                disabled={fixing || loading}
                                onClick={() => void fixAlignment(fixable)}
                            >
                                {fixing ? 'Resizing…' : `Resize ${fixable.length} textures to fit`}
                            </button>
                        )}
                    </div>
                    <button className="dl-btn dl-btn--primary" onClick={closeModal}>
                        Close
                    </button>
                </div>
            </div>
        </div>,
        document.body,
    );
};
