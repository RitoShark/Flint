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

// Max log rows painted into the (non-virtualized) panel at once. Retention is
// unbounded in the store; this only bounds the live DOM so the panel stays
// responsive. Copy All exports the full history regardless of this window.
const LOG_RENDER_WINDOW = 4000;

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

    // Log retention is unbounded (see appMetadataStore) so copying never loses
    // lines, but the panel is NOT virtualized — painting tens of thousands of
    // rows would freeze the UI. Window the DOM to the most recent slice; counts
    // and Copy All still use the full filteredLogs. Bump if you need to scroll
    // further back live (you can always Copy All to get everything).
    const truncated = Math.max(0, filteredLogs.length - LOG_RENDER_WINDOW);
    const visibleLogs = truncated > 0 ? filteredLogs.slice(-LOG_RENDER_WINDOW) : filteredLogs;

    // Auto-scroll to bottom when new logs appear
    useEffect(() => {
        if (contentRef.current && logPanelExpanded) {
            contentRef.current.scrollTop = contentRef.current.scrollHeight;
        }
    }, [filteredLogs, logPanelExpanded]);

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

                    {/* Content */}
                    <div className="log-panel__content" ref={contentRef}>
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
                            <>
                            {truncated > 0 && (
                                <div className="log-panel__empty" style={{ padding: '6px 12px', opacity: 0.6 }}>
                                    <small>{truncated.toLocaleString()} older line{truncated === 1 ? '' : 's'} hidden for performance — use <strong>Copy All</strong> to export the full history.</small>
                                </div>
                            )}
                            {visibleLogs.map((log) => (
                                <div
                                    key={log.id}
                                    className={`log-panel__entry log-panel__entry--${log.level}`}
                                >
                                    <span className="log-panel__time">{formatTime(log.timestamp)}</span>
                                    <span className={`log-panel__level-pill log-panel__level-pill--${log.level}`}>
                                        {LEVEL_LABEL[log.level as LogLevel]}
                                    </span>
                                    <span className="log-panel__message">{log.message}</span>
                                    <button
                                        className="log-panel__entry-copy"
                                        onClick={() => copyLine(log.message)}
                                        title="Copy line"
                                        aria-label="Copy log line"
                                    >
                                        <Icon name="copy" />
                                    </button>
                                </div>
                            ))}
                            </>
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
