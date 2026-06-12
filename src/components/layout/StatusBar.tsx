/**
 * Flint - Log Panel Component
 * Displays application logs captured by the logger service.
 *
 * Polished version: selectable text, per-line copy on hover, level pills
 * (no emoji), filter input, level chips, copy/clear actions via the shared
 * Button primitive.
 */

import React, { useEffect, useMemo, useRef, useState } from 'react';
import { useAppMetadataStore, useNotificationStore } from '../../lib/stores';
import { setLogStore } from '../../lib/util/logger';
import { Button, Icon } from '../ui';

type LogLevel = 'info' | 'warning' | 'error';
type FilterLevel = 'all' | LogLevel;

// Virtualized log list. Retention is unbounded in the store; only the rows in
// (and just around) the viewport are ever in the DOM — so memory/DOM stay tiny
// no matter how many heavy lines pile up. ROW_H must match the fixed row height
// the CSS/inline style enforces; OVERSCAN renders a few extra rows above/below
// for smooth scrolling. Copy All / range-copy read from the store, so off-screen
// (un-rendered) lines copy fine.
const ROW_H = 26;        // px, single-line row height (must match logger-polish.css row sizing)
const OVERSCAN = 12;     // rows rendered beyond the viewport on each side

const LEVEL_LABEL: Record<LogLevel, string> = {
    info: 'INFO',
    warning: 'WARN',
    error: 'ERROR',
};

const FILTER_OPTIONS: { value: FilterLevel; label: string }[] = [
    { value: 'all',     label: 'All'   },
    { value: 'info',    label: 'Info'  },
    { value: 'warning', label: 'Warn'  },
    { value: 'error',   label: 'Error' },
];

function formatTime(timestamp: number): string {
    const d = new Date(timestamp);
    return d.toLocaleTimeString('en-US', {
        hour12: false,
        hour: '2-digit',
        minute: '2-digit',
        second: '2-digit',
    });
}

export const LogPanel: React.FC = () => {
    const logs = useAppMetadataStore((s) => s.logs);
    const logPanelExpanded = useAppMetadataStore((s) => s.logPanelExpanded);
    const status = useAppMetadataStore((s) => s.status);
    const statusMessage = useAppMetadataStore((s) => s.statusMessage);
    const toggleLogPanel = useAppMetadataStore((s) => s.toggleLogPanel);
    const clearLogs = useAppMetadataStore((s) => s.clearLogs);
    const addLog = useAppMetadataStore((s) => s.addLog);
    const addLogsBatch = useAppMetadataStore((s) => s.addLogsBatch);
    const showToast = useNotificationStore((s) => s.showToast);
    const contentRef = useRef<HTMLDivElement>(null);
    const hasConnectedRef = useRef(false);

    const [filter, setFilter] = useState('');
    const [levelFilter, setLevelFilter] = useState<FilterLevel>('all');

    // Connect the logger to the store on mount
    useEffect(() => {
        if (hasConnectedRef.current) return;
        hasConnectedRef.current = true;
        setLogStore(addLog, addLogsBatch);
    }, [addLog, addLogsBatch]);

    // Counts per level (compute before filtering)
    const counts = useMemo(() => {
        let info = 0, warning = 0, error = 0;
        for (const l of logs) {
            if (l.level === 'error') error++;
            else if (l.level === 'warning') warning++;
            else info++;
        }
        return { info, warning, error };
    }, [logs]);

    // Filtered logs (level + text)
    const filteredLogs = useMemo(() => {
        const q = filter.trim().toLowerCase();
        return logs.filter((l) => {
            if (levelFilter !== 'all' && l.level !== levelFilter) return false;
            if (q && !l.message.toLowerCase().includes(q)) return false;
            return true;
        });
    }, [logs, filter, levelFilter]);

    // ── Virtualization state ────────────────────────────────────────────────
    const [scrollTop, setScrollTop] = useState(0);
    const [viewportH, setViewportH] = useState(400);
    const stickToBottomRef = useRef(true);

    // ── Range selection (click → anchor, shift-click → extend) ──────────────
    // Indices are into filteredLogs. Copy reads from the store array, so it
    // works across rows that aren't currently rendered.
    const [selAnchor, setSelAnchor] = useState<number | null>(null);
    const [selFocus, setSelFocus] = useState<number | null>(null);
    const selLo = selAnchor === null || selFocus === null ? -1 : Math.min(selAnchor, selFocus);
    const selHi = selAnchor === null || selFocus === null ? -1 : Math.max(selAnchor, selFocus);
    const selCount = selLo < 0 ? 0 : selHi - selLo + 1;

    const total = filteredLogs.length;
    const totalHeight = total * ROW_H;
    const startIndex = Math.max(0, Math.floor(scrollTop / ROW_H) - OVERSCAN);
    const endIndex = Math.min(total, Math.ceil((scrollTop + viewportH) / ROW_H) + OVERSCAN);
    const windowRows = filteredLogs.slice(startIndex, endIndex);

    // Auto-scroll to bottom when new logs appear — but ONLY if the user is
    // already pinned to the bottom. If they scrolled up (to read/select older
    // lines), incoming logs must not yank them back down.
    useEffect(() => {
        const el = contentRef.current;
        if (el && logPanelExpanded && stickToBottomRef.current) {
            el.scrollTop = el.scrollHeight;
            setScrollTop(el.scrollTop);
        }
    }, [filteredLogs, logPanelExpanded]);

    // Measure viewport height (drives how many rows are virtualized)
    useEffect(() => {
        if (!logPanelExpanded) return;
        const el = contentRef.current;
        if (!el) return;
        const measure = () => setViewportH(el.clientHeight);
        measure();
        const ro = new ResizeObserver(measure);
        ro.observe(el);
        return () => ro.disconnect();
    }, [logPanelExpanded]);

    const handleScroll = (e: React.UIEvent<HTMLDivElement>) => {
        const el = e.currentTarget;
        setScrollTop(el.scrollTop);
        // Pinned-to-bottom if within ~2 rows of the end.
        stickToBottomRef.current = el.scrollHeight - el.scrollTop - el.clientHeight < ROW_H * 2;
    };

    // Click selects a single line; Shift-click extends the range from the anchor.
    const handleRowClick = (index: number, e: React.MouseEvent) => {
        if (e.shiftKey && selAnchor !== null) {
            setSelFocus(index);
            // Prevent the browser's native text-selection from fighting the range UI.
            window.getSelection?.()?.removeAllRanges();
        } else {
            setSelAnchor(index);
            setSelFocus(index);
        }
    };

    const formatRange = (lo: number, hi: number) =>
        filteredLogs.slice(lo, hi + 1).map((log) => {
            const time = formatTime(log.timestamp);
            const level = LEVEL_LABEL[log.level as LogLevel].padEnd(5);
            return `[${time}] ${level} ${log.message}`;
        }).join('\n');

    const copySelection = () => {
        if (selLo < 0) return;
        navigator.clipboard.writeText(formatRange(selLo, selHi))
            .then(() => showToast('success', `${selCount} line${selCount === 1 ? '' : 's'} copied`))
            .catch(() => showToast('error', 'Failed to copy selection'));
    };

    // Ctrl/Cmd+C copies the selected range (reads from the store, so off-screen
    // rows are included) instead of only the natively-selected visible text.
    const handleKeyDown = (e: React.KeyboardEvent) => {
        if ((e.ctrlKey || e.metaKey) && e.key.toLowerCase() === 'c' && selLo >= 0) {
            const nativeSel = window.getSelection?.()?.toString();
            if (!nativeSel) { e.preventDefault(); copySelection(); }
        }
    };

    const latestLog = logs.length > 0 ? logs[logs.length - 1] : null;
    const displayMessage = latestLog ? latestLog.message : statusMessage || 'Ready';
    const displayLevel: LogLevel = latestLog?.level || 'info';

    // Indicator class on the collapsed bar
    const indicatorClass = (() => {
        if (!latestLog) {
            switch (status) {
                case 'working': return 'log-panel__indicator--working';
                case 'error':   return 'log-panel__indicator--error';
                default:        return 'log-panel__indicator--ready';
            }
        }
        switch (latestLog.level) {
            case 'error':   return 'log-panel__indicator--error';
            case 'warning': return 'log-panel__indicator--warning';
            default:        return 'log-panel__indicator--ready';
        }
    })();

    const copyAll = () => {
        const text = filteredLogs.map((log) => {
            const time = formatTime(log.timestamp);
            const level = LEVEL_LABEL[log.level as LogLevel].padEnd(5);
            return `[${time}] ${level} ${log.message}`;
        }).join('\n');
        navigator.clipboard.writeText(text)
            .then(() => showToast('success', `${filteredLogs.length} log${filteredLogs.length === 1 ? '' : 's'} copied`))
            .catch(() => showToast('error', 'Failed to copy logs'));
    };

    const copyLine = (msg: string) => {
        navigator.clipboard.writeText(msg)
            .then(() => showToast('info', 'Line copied'))
            .catch(() => showToast('error', 'Failed to copy'));
    };

    if (logPanelExpanded) {
        return (
            <div className="log-panel log-panel--expanded" onClick={toggleLogPanel}>
                <div className="log-panel__container" onClick={(e) => e.stopPropagation()}>
                    {/* Header */}
                    <div className="log-panel__header">
                        <span className="log-panel__title">
                            <span className="log-panel__title-icon"><Icon name="info" /></span>
                            <span>
                                <span className="log-panel__title-name">Output</span>
                                <span className="log-panel__title-sub">
                                    {logs.length} entr{logs.length === 1 ? 'y' : 'ies'}
                                    {logs.length !== filteredLogs.length && ` · ${filteredLogs.length} shown`}
                                </span>
                            </span>
                        </span>
                        <div className="log-panel__actions">
                            {selCount > 0 && (
                                <Button size="sm" variant="primary" icon="copy" onClick={copySelection}>
                                    Copy selection ({selCount})
                                </Button>
                            )}
                            <Button size="sm" icon="copy" onClick={copyAll} disabled={filteredLogs.length === 0}>
                                Copy logs
                            </Button>
                            <Button size="sm" variant="danger" icon="trash" onClick={clearLogs} disabled={logs.length === 0}>
                                Clear
                            </Button>
                            <button className="modal__close" onClick={toggleLogPanel} aria-label="Close">
                                <Icon name="close" />
                            </button>
                        </div>
                    </div>

                    {/* Toolbar */}
                    <div className="log-panel__toolbar">
                        <div className="log-panel__search">
                            <Icon name="search" />
                            <input
                                type="text"
                                className="log-panel__search-input"
                                placeholder="Filter logs…"
                                value={filter}
                                onChange={(e) => setFilter(e.target.value)}
                            />
                            {filter && (
                                <button
                                    className="log-panel__search-clear"
                                    onClick={() => setFilter('')}
                                    aria-label="Clear filter"
                                    title="Clear filter"
                                >
                                    <Icon name="close" />
                                </button>
                            )}
                        </div>
                        <div className="log-panel__levels">
                            {FILTER_OPTIONS.map((opt) => {
                                const count = opt.value === 'all'
                                    ? logs.length
                                    : counts[opt.value as LogLevel];
                                return (
                                    <button
                                        key={opt.value}
                                        className={`log-panel__chip log-panel__chip--${opt.value} ${levelFilter === opt.value ? 'log-panel__chip--active' : ''}`}
                                        onClick={() => setLevelFilter(opt.value)}
                                    >
                                        <span>{opt.label}</span>
                                        <span className="log-panel__chip-count">{count}</span>
                                    </button>
                                );
                            })}
                        </div>
                    </div>

                    {/* Content (virtualized — only the rows near the viewport are
                        in the DOM; click a line / shift-click another to select a
                        range, then Ctrl+C or "Copy selection") */}
                    <div
                        className="log-panel__content"
                        ref={contentRef}
                        onScroll={handleScroll}
                        onKeyDown={handleKeyDown}
                        tabIndex={0}
                    >
                        {logs.length === 0 ? (
                            <div className="log-panel__empty">
                                <span className="log-panel__empty-icon"><Icon name="info" /></span>
                                <strong>No logs yet</strong>
                                <span>Logs will appear here as you use Flint.</span>
                                <small>Enable verbose logging in Settings to see more details.</small>
                            </div>
                        ) : filteredLogs.length === 0 ? (
                            <div className="log-panel__empty">
                                <span className="log-panel__empty-icon"><Icon name="search" /></span>
                                <strong>No matching logs</strong>
                                <span>{filter ? `Nothing matches "${filter}"` : `No ${levelFilter} entries.`}</span>
                            </div>
                        ) : (
                            <div style={{ height: totalHeight, position: 'relative' }}>
                                {windowRows.map((log, i) => {
                                    const index = startIndex + i;
                                    const selected = selLo >= 0 && index >= selLo && index <= selHi;
                                    return (
                                        <div
                                            key={log.id}
                                            className={`log-panel__entry log-panel__entry--${log.level}`}
                                            style={{
                                                position: 'absolute',
                                                top: index * ROW_H,
                                                left: 0,
                                                right: 0,
                                                height: ROW_H,
                                                padding: '0 14px',
                                                background: selected
                                                    ? 'color-mix(in oklab, var(--accent-primary) 24%, transparent)'
                                                    : undefined,
                                            }}
                                            onClick={(e) => handleRowClick(index, e)}
                                        >
                                            <span className="log-panel__time">{formatTime(log.timestamp)}</span>
                                            <span className={`log-panel__level-pill log-panel__level-pill--${log.level}`}>
                                                {LEVEL_LABEL[log.level as LogLevel]}
                                            </span>
                                            <span
                                                className="log-panel__message"
                                                style={{ whiteSpace: 'nowrap', overflow: 'hidden', textOverflow: 'ellipsis' }}
                                                title={log.message}
                                            >
                                                {log.message}
                                            </span>
                                            <button
                                                className="log-panel__entry-copy"
                                                onClick={(e) => { e.stopPropagation(); copyLine(log.message); }}
                                                title="Copy line"
                                                aria-label="Copy log line"
                                            >
                                                <Icon name="copy" />
                                            </button>
                                        </div>
                                    );
                                })}
                            </div>
                        )}
                    </div>
                </div>
            </div>
        );
    }

    return (
        <footer className="log-panel log-panel--collapsed" onClick={toggleLogPanel}>
            <div className="log-panel__left">
                <span className={`log-panel__indicator ${indicatorClass}`} />
                <span className={`log-panel__text log-panel__text--${displayLevel}`}>
                    {displayMessage.length > 100 ? displayMessage.substring(0, 100) + '…' : displayMessage}
                </span>
            </div>
            <div className="log-panel__right">
                <span className="log-panel__hint">
                    <Icon name="info" /> {logs.length}
                </span>
            </div>
        </footer>
    );
};

// Re-export as StatusBar for backward compatibility
export const StatusBar = LogPanel;
