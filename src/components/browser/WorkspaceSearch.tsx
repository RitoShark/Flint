import React, { useCallback, useState } from 'react';
import * as api from '../../lib/api';
import { Icon } from '../ui';
import { useModalStore, useNotificationStore, useNavigationStore } from '../../lib/stores';
import { requestRevealLine } from '../../lib/editor/binEditorEvents';

interface WorkspaceSearchProps {
    projectPath: string;
    /** The BIN currently open, so its out-of-project links join the sweep. */
    seedBin?: string | null;
}

const DEFAULT_OPTIONS: api.BinSearchOptions = {
    caseSensitive: false,
    wholeWord: false,
    regex: false,
};

function fileName(path: string): string {
    return path.split('/').pop() ?? path;
}

function folderOf(path: string): string {
    const parts = path.split('/');
    parts.pop();
    return parts.join('/');
}

export const WorkspaceSearch: React.FC<WorkspaceSearchProps> = ({ projectPath, seedBin }) => {
    const showToast = useNotificationStore((s) => s.showToast);
    const openConfirmDialog = useModalStore((s) => s.openConfirmDialog);
    const navigateToFileEditor = useNavigationStore((s) => s.navigateToFileEditor);

    const [query, setQuery] = useState('');
    const [replacement, setReplacement] = useState('');
    const [showReplace, setShowReplace] = useState(false);
    const [options, setOptions] = useState<api.BinSearchOptions>(DEFAULT_OPTIONS);
    const [result, setResult] = useState<api.BinSearchResult | null>(null);
    const [collapsed, setCollapsed] = useState<Set<string>>(new Set());
    const [busy, setBusy] = useState(false);
    const [error, setError] = useState<string | null>(null);

    const toggleOption = (key: keyof api.BinSearchOptions) =>
        setOptions((prev) => ({ ...prev, [key]: !prev[key] }));

    const runSearch = useCallback(async () => {
        if (!query) { setResult(null); setError(null); return; }
        setBusy(true);
        setError(null);
        try {
            setResult(await api.searchProjectBins(projectPath, query, options, seedBin));
            setCollapsed(new Set());
        } catch (e) {
            const fe = e as api.FlintError;
            setError(fe.getUserMessage?.() || (e instanceof Error ? e.message : String(e)));
            setResult(null);
        } finally {
            setBusy(false);
        }
    }, [projectPath, query, options, seedBin]);

    const open = (path: string, line: number) => {
        requestRevealLine(path, line);
        navigateToFileEditor({ filePath: path, kind: 'binText', projectPath });
    };

    const handleReplaceAll = () => {
        if (!result || result.files.length === 0) return;
        const files = result.files.length;
        const hits = result.files.reduce((sum, f) => sum + f.matches.length + f.extra, 0);
        openConfirmDialog({
            title: 'Replace across the project',
            message:
                `Replace ${hits} match${hits === 1 ? '' : 'es'} in ${files} BIN file${files === 1 ? '' : 's'}.\n\n`
                + 'Each file is rewritten in place. This cannot be undone from the editor — '
                + 'take a checkpoint first if you are unsure.',
            confirmLabel: 'Replace all',
            danger: true,
            onConfirm: () => {
                void (async () => {
                    setBusy(true);
                    try {
                        const outcome = await api.replaceInBins(
                            result.files.map((f) => f.path),
                            query,
                            replacement,
                            options,
                        );
                        if (outcome.failed.length > 0) {
                            showToast(
                                'warning',
                                `Replaced ${outcome.replacements} in ${outcome.files_changed} file(s); `
                                + `${outcome.failed.length} failed`,
                            );
                            console.error('[workspace-search] replace failures:', outcome.failed);
                        } else {
                            showToast(
                                'success',
                                `Replaced ${outcome.replacements} match${outcome.replacements === 1 ? '' : 'es'} `
                                + `in ${outcome.files_changed} file${outcome.files_changed === 1 ? '' : 's'}`,
                            );
                        }
                        await runSearch();
                    } catch (e) {
                        const fe = e as api.FlintError;
                        showToast('error', fe.getUserMessage?.() || `Replace failed: ${e}`);
                    } finally {
                        setBusy(false);
                    }
                })();
            },
        });
    };

    const totalHits = result?.files.reduce((sum, f) => sum + f.matches.length, 0) ?? 0;

    return (
        <div className="ws-search">
            <div className="ws-search__query">
                <button
                    className="ws-search__expander"
                    onClick={() => setShowReplace((v) => !v)}
                    title={showReplace ? 'Hide replace' : 'Show replace'}
                >
                    <Icon name={showReplace ? 'chevronDown' : 'chevronRight'} />
                </button>
                <div className="ws-search__fields">
                    <input
                        className="dl-input ws-search__input"
                        placeholder="Search"
                        value={query}
                        onChange={(e) => setQuery(e.target.value)}
                        onKeyDown={(e) => { if (e.key === 'Enter') void runSearch(); }}
                    />
                    {showReplace && (
                        <input
                            className="dl-input ws-search__input"
                            placeholder="Replace"
                            value={replacement}
                            onChange={(e) => setReplacement(e.target.value)}
                        />
                    )}
                </div>
            </div>

            <div className="ws-search__toggles">
                <button
                    className={`ws-search__toggle${options.caseSensitive ? ' is-on' : ''}`}
                    onClick={() => toggleOption('caseSensitive')}
                    title="Match case"
                >Aa</button>
                <button
                    className={`ws-search__toggle${options.wholeWord ? ' is-on' : ''}`}
                    onClick={() => toggleOption('wholeWord')}
                    title="Match whole word"
                >ab</button>
                <button
                    className={`ws-search__toggle${options.regex ? ' is-on' : ''}`}
                    onClick={() => toggleOption('regex')}
                    title="Use regular expression"
                >.*</button>
                <button
                    className="dl-btn dl-btn--sm dl-btn--primary ws-search__go"
                    onClick={() => void runSearch()}
                    disabled={busy || !query}
                >
                    {busy ? 'Searching…' : 'Search'}
                </button>
            </div>

            {showReplace && (
                <button
                    className="dl-btn dl-btn--sm ws-search__replace-all"
                    onClick={handleReplaceAll}
                    disabled={busy || !result || result.files.length === 0}
                >
                    Replace all in {result?.files.length ?? 0} file{(result?.files.length ?? 0) === 1 ? '' : 's'}
                </button>
            )}

            {error && <div className="ws-search__error">{error}</div>}

            {result && (
                <div className="ws-search__summary">
                    {totalHits === 0
                        ? `No results in ${result.scanned} BIN file${result.scanned === 1 ? '' : 's'}`
                        : `${totalHits} result${totalHits === 1 ? '' : 's'} in ${result.files.length} file${result.files.length === 1 ? '' : 's'}`}
                    {result.truncated && ' · capped'}
                </div>
            )}

            <div className="ws-search__results">
                {result?.files.map((file) => {
                    const isCollapsed = collapsed.has(file.path);
                    return (
                        <div className="ws-search__group" key={file.path}>
                            <button
                                className="ws-search__group-head"
                                onClick={() => setCollapsed((prev) => {
                                    const next = new Set(prev);
                                    if (next.has(file.path)) next.delete(file.path);
                                    else next.add(file.path);
                                    return next;
                                })}
                                title={file.rel_path}
                            >
                                <Icon
                                    className="ws-search__group-chev"
                                    name={isCollapsed ? 'chevronRight' : 'chevronDown'}
                                />
                                <span className="ws-search__group-name">{fileName(file.rel_path)}</span>
                                <span className="ws-search__group-dir">{folderOf(file.rel_path)}</span>
                                <span className="ws-search__group-count">
                                    {file.matches.length}{file.extra > 0 ? '+' : ''}
                                </span>
                            </button>
                            {!isCollapsed && file.matches.map((hit, i) => (
                                <button
                                    className="ws-search__hit"
                                    key={`${hit.line}-${hit.column}-${i}`}
                                    onClick={() => open(file.path, hit.line)}
                                    title={`Line ${hit.line}`}
                                >
                                    {hit.preview}
                                </button>
                            ))}
                        </div>
                    );
                })}
            </div>
        </div>
    );
};
