import { Button } from '../ui/Button';
import React, { useCallback, useEffect, useMemo, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { useModalStore, useNotificationStore, useProjectTabStore } from '../../lib/stores';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { VirtualList } from '../preview/VirtualList';
import {
    buildLayerTree,
    formatBytes,
    indexState,
    rangeState,
    selectionPrefix,
    type CheckState,
    type LayerTree,
    type TreeRow,
} from '../../lib/editor/layerTree';
import { useTranslation } from '../../lib/i18n';
import * as api from '../../lib/api';

const ROW_HEIGHT = 26;
const SLUG_RE = /^[a-zA-Z0-9_-]+$/;

interface CategoryChip {
    id: api.LayerCategory;
    icon: Parameters<typeof getIcon>[0];
}

const CHIPS: CategoryChip[] = [
    { id: 'model',     icon: 'model' },
    { id: 'animation', icon: 'animation' },
    { id: 'particle',  icon: 'target' },
    { id: 'audio',     icon: 'audio' },
    { id: 'data',      icon: 'bin' },
    { id: 'other',     icon: 'file' },
];

const Icon: React.FC<{ name: Parameters<typeof getIcon>[0]; className?: string }> = ({ name, className }) => (
    <span className={className} dangerouslySetInnerHTML={{ __html: getIcon(name) }} />
);

const Check: React.FC<{ state: CheckState }> = ({ state }) => (
    <span className={`al-check al-check--${state}`}>
        {state === 'on' && <Icon name="check" />}
    </span>
);

export const AddLayerModal: React.FC = () => {
    const { t } = useTranslation();
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const setFileTree = useProjectTabStore((s) => s.setFileTree);

    const activeTab = activeTabId ? openTabs.find((tab) => tab.id === activeTabId) : null;
    const projectPath = activeTab?.projectPath || null;
    const isVisible = activeModal === 'addLayer';

    const [layerName, setLayerName] = useState('');
    const [description, setDescription] = useState('');
    const [sourceLayer, setSourceLayer] = useState('base');
    const [layers, setLayers] = useState<api.ProjectLayer[]>([]);
    const [priority, setPriority] = useState('');
    const [tree, setTree] = useState<LayerTree | null>(null);
    const [selection, setSelection] = useState<Uint8Array>(() => new Uint8Array(0));
    const [expanded, setExpanded] = useState<Set<string>>(() => new Set());
    const [query, setQuery] = useState('');
    const [loading, setLoading] = useState(false);
    const [loadError, setLoadError] = useState<string | null>(null);
    const [busy, setBusy] = useState(false);
    const nameRef = useRef<HTMLInputElement | null>(null);

    useEffect(() => {
        if (!isVisible) return;
        setLayerName('');
        setDescription('');
        setPriority('');
        setQuery('');
        setBusy(false);
        const timer = setTimeout(() => nameRef.current?.focus(), 60);
        return () => clearTimeout(timer);
    }, [isVisible]);

    useEffect(() => {
        if (!isVisible || !projectPath) return;
        let cancelled = false;
        api.listProjectLayers(projectPath)
            .then((found) => {
                if (cancelled) return;
                const safe = found.length ? found : [{ name: 'base', priority: 0, description: null }];
                setLayers(safe);
                setSourceLayer((prev) => (safe.some((l) => l.name === prev) ? prev : safe[0].name));
            })
            .catch(() => {
                if (!cancelled) setLayers([{ name: 'base', priority: 0, description: null }]);
            });
        return () => {
            cancelled = true;
        };
    }, [isVisible, projectPath]);

    useEffect(() => {
        if (!isVisible || !projectPath || !sourceLayer) return;
        let cancelled = false;
        setLoading(true);
        setLoadError(null);
        api.listLayerFiles(projectPath, sourceLayer)
            .then((files) => {
                if (cancelled) return;
                const built = buildLayerTree(files);
                setTree(built);
                setSelection(new Uint8Array(built.files.length));
                setExpanded(new Set(built.rows.filter((r) => r.isDir && r.depth < 2).map((r) => r.path)));
            })
            .catch((err) => {
                if (cancelled) return;
                setTree(null);
                setLoadError((err as api.FlintError)?.getUserMessage?.() || String(err));
            })
            .finally(() => {
                if (!cancelled) setLoading(false);
            });
        return () => {
            cancelled = true;
        };
    }, [isVisible, projectPath, sourceLayer]);

    const prefix = useMemo(() => selectionPrefix(selection), [selection]);
    const selectedCount = prefix.length ? prefix[prefix.length - 1] : 0;

    const selectedBytes = useMemo(() => {
        if (!tree) return 0;
        let total = 0;
        for (let i = 0; i < selection.length; i += 1) {
            if (selection[i]) total += tree.files[i].size;
        }
        return total;
    }, [tree, selection]);

    const setRange = useCallback((start: number, end: number, on: boolean) => {
        setSelection((prev) => {
            const next = new Uint8Array(prev);
            next.fill(on ? 1 : 0, start, end);
            return next;
        });
    }, []);

    const setIndices = useCallback((indices: number[], on: boolean) => {
        setSelection((prev) => {
            const next = new Uint8Array(prev);
            for (const i of indices) next[i] = on ? 1 : 0;
            return next;
        });
    }, []);

    /* A filter turns the tree into a flat hit list. Keeping the folders would
       mean a folder row counting files the filter has hidden, so its checkbox
       would read "partial" while every row under it looks ticked. */
    const matchIndices = useMemo(() => {
        const needle = query.trim().toLowerCase();
        if (!needle || !tree) return null;
        const hits: number[] = [];
        for (let i = 0; i < tree.files.length; i += 1) {
            if (tree.files[i].path.toLowerCase().includes(needle)) hits.push(i);
        }
        return hits;
    }, [query, tree]);

    const rows = useMemo(() => {
        if (!tree) return [];
        if (matchIndices) {
            return matchIndices.map((i) => ({
                path: tree.files[i].path,
                name: tree.files[i].path,
                depth: 0,
                isDir: false,
                start: i,
                end: i + 1,
                bytes: tree.files[i].size,
                category: tree.files[i].category,
            }));
        }
        const visible: TreeRow[] = [];
        let collapsed: string | null = null;
        for (const row of tree.rows) {
            if (collapsed) {
                if (row.path.startsWith(`${collapsed}/`)) continue;
                collapsed = null;
            }
            visible.push(row);
            if (row.isDir && !expanded.has(row.path)) collapsed = row.path;
        }
        return visible;
    }, [tree, expanded, matchIndices]);

    const toggleExpand = useCallback((path: string) => {
        setExpanded((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path);
            else next.add(path);
            return next;
        });
    }, []);

    const trimmed = layerName.trim();
    const nameError = useMemo(() => {
        if (!trimmed) return null;
        if (!SLUG_RE.test(trimmed)) return t('addLayer.nameInvalid');
        if (layers.some((l) => l.name === trimmed)) return t('addLayer.nameTaken');
        return null;
    }, [trimmed, layers, t]);

    const parsedPriority = priority.trim() === '' ? null : Number(priority);
    const priorityError =
        parsedPriority !== null && (!Number.isInteger(parsedPriority) || Math.abs(parsedPriority) > 100000)
            ? t('addLayer.priorityInvalid')
            : null;
    const nextPriority = layers.reduce((max, l) => Math.max(max, l.priority), 0) + 1;
    const effectivePriority = parsedPriority ?? nextPriority;

    const canSubmit = !!projectPath && !!trimmed && !nameError && !priorityError && !busy && !loading;

    const handleSubmit = async () => {
        if (!projectPath || !canSubmit || !tree) return;
        setBusy(true);
        try {
            const files = tree.files.filter((_, i) => selection[i]).map((f) => f.path);
            const result = await api.createProjectLayer({
                projectPath,
                layerName: trimmed,
                sourceLayer,
                categories: [],
                files,
                description: description.trim() || undefined,
                priority: parsedPriority ?? undefined,
            });
            showToast(
                'success',
                result.files_copied === 0
                    ? t('addLayer.createdEmpty', { layer: result.layer_name })
                    : t('addLayer.created', {
                          layer: result.layer_name,
                          files: result.files_copied,
                          size: formatBytes(result.bytes_copied),
                      }),
            );
            if (activeTab) setFileTree(activeTab.id, await api.listProjectFiles(activeTab.projectPath));
            closeModal();
        } catch (err) {
            showToast('error', (err as api.FlintError)?.getUserMessage?.() || t('addLayer.failed'));
        } finally {
            setBusy(false);
        }
    };

    if (!isVisible) return null;

    const renderRow = (row: TreeRow) => {
        const state = rangeState(prefix, row.start, row.end);
        const open = expanded.has(row.path);
        return (
            <div
                className={`al-row${row.isDir ? ' al-row--dir' : ''}`}
                style={{ paddingLeft: 10 + row.depth * 15 }}
                onClick={() => setRange(row.start, row.end, state !== 'on')}
                role="button"
                tabIndex={0}
                onKeyDown={(e) => {
                    if (e.key === ' ' || e.key === 'Enter') {
                        e.preventDefault();
                        setRange(row.start, row.end, state !== 'on');
                    }
                }}
            >
                {row.isDir ? (
                    <button
                        className="al-row__twist"
                        onClick={(e) => {
                            e.stopPropagation();
                            toggleExpand(row.path);
                        }}
                        title={open ? t('addLayer.collapse') : t('addLayer.expand')}
                    >
                        <Icon name={open ? 'chevronDown' : 'chevronRight'} />
                    </button>
                ) : (
                    <span className="al-row__twist al-row__twist--empty" />
                )}
                <Check state={state} />
                <span className={`al-row__icon${row.isDir ? ' al-row__icon--dir' : ''}`}>
                    <Icon name={row.isDir ? (open ? 'folderOpen' : 'folder') : 'file'} />
                </span>
                <span className={`al-row__name${matchIndices ? ' al-row__name--path' : ''}`}>{row.name}</span>
                {row.isDir && <span className="al-row__count">{row.end - row.start}</span>}
                <span className="al-row__size">{formatBytes(row.bytes)}</span>
            </div>
        );
    };

    const stack = [...layers.map((l) => ({ name: l.name, priority: l.priority, isNew: false }))];
    if (trimmed && !nameError) stack.push({ name: trimmed, priority: effectivePriority, isNew: true });
    stack.sort((a, b) => a.priority - b.priority);

    return createPortal(
        <div
            className="dl-modal-backdrop"
            onMouseDown={(e) => {
                if (e.target === e.currentTarget && !busy) closeModal();
            }}
        >
            <div className="dl-modal al-modal" role="dialog" aria-modal="true" aria-label={t('addLayer.title')}>
                <div className="dl-modal__head">
                    <span className="al-mark">
                        <Icon name="layerModel" />
                    </span>
                    <h3 className="al-title">
                        {t('addLayer.title')}
                        <span className="al-title__source">{t('addLayer.from', { layer: sourceLayer })}</span>
                    </h3>
                    <div className="al-search">
                        <span className="al-search__icon">
                            <Icon name="search" />
                        </span>
                        <input
                            className="al-search__input"
                            placeholder={t('addLayer.filter')}
                            value={query}
                            onChange={(e) => setQuery(e.target.value)}
                            spellCheck={false}
                            disabled={busy}
                        />
                        {query && (
                            <button className="al-search__clear" onClick={() => setQuery('')} title={t('addLayer.clearFilter')}>
                                <Icon name="close" />
                            </button>
                        )}
                    </div>
                </div>

                <div className="dl-modal__body">
                    <div className="al-form">
                        <label className="al-field">
                            <span className="al-field__label">{t('addLayer.name')}</span>
                            <input
                                ref={nameRef}
                                className={`al-input${nameError ? ' al-input--error' : ''}`}
                                value={layerName}
                                onChange={(e) => setLayerName(e.target.value)}
                                placeholder="chroma_red"
                                spellCheck={false}
                                disabled={busy}
                            />
                            <span className={`al-field__hint${nameError ? ' al-field__hint--error' : ''}`}>
                                {nameError ?? t('addLayer.nameHint')}
                            </span>
                        </label>

                        <label className="al-field">
                            <span className="al-field__label">{t('addLayer.description')}</span>
                            <input
                                className="al-input"
                                value={description}
                                onChange={(e) => setDescription(e.target.value)}
                                placeholder={t('addLayer.descriptionPlaceholder')}
                                disabled={busy}
                            />
                        </label>

                        <label className="al-field">
                            <span className="al-field__label">{t('addLayer.copyFrom')}</span>
                            <select
                                className="al-input"
                                value={sourceLayer}
                                onChange={(e) => setSourceLayer(e.target.value)}
                                disabled={busy || layers.length <= 1}
                            >
                                {layers.map((layer) => (
                                    <option key={layer.name} value={layer.name}>
                                        {layer.name}
                                    </option>
                                ))}
                            </select>
                        </label>

                        <label className="al-field">
                            <span className="al-field__label">{t('addLayer.priority')}</span>
                            <input
                                className={`al-input${priorityError ? ' al-input--error' : ''}`}
                                value={priority}
                                onChange={(e) => setPriority(e.target.value)}
                                placeholder={String(nextPriority)}
                                inputMode="numeric"
                                disabled={busy}
                            />
                            <span className={`al-field__hint${priorityError ? ' al-field__hint--error' : ''}`}>
                                {priorityError ?? t('addLayer.priorityHint')}
                            </span>
                        </label>

                        <div className="al-stack">
                            <span className="al-stack__label">{t('addLayer.stack')}</span>
                            {stack.map((entry) => (
                                <div
                                    key={`${entry.name}-${entry.priority}`}
                                    className={`al-stack__row${entry.isNew ? ' al-stack__row--new' : ''}`}
                                >
                                    <span className="al-stack__priority">{entry.priority}</span>
                                    <span className="al-stack__name">{entry.name}</span>
                                </div>
                            ))}
                        </div>
                    </div>

                    <div className="al-pane">
                        <div className="al-chips">
                            {CHIPS.map((chip) => {
                                const indices = tree?.byCategory[chip.id] ?? [];
                                const state = indexState(prefix, indices);
                                return (
                                    <button
                                        key={chip.id}
                                        className={`al-chip al-chip--${state}`}
                                        title={t(`addLayer.cat.${chip.id}Hint`)}
                                        disabled={busy || indices.length === 0}
                                        onClick={() => setIndices(indices, state !== 'on')}
                                    >
                                        <span className="al-chip__icon">
                                            <Icon name={chip.icon} />
                                        </span>
                                        {t(`addLayer.cat.${chip.id}`)}
                                        <span className="al-chip__count">{indices.length}</span>
                                    </button>
                                );
                            })}
                            {matchIndices && (
                                <button
                                    className={`al-chip al-chip--${indexState(prefix, matchIndices)} al-chip--match`}
                                    disabled={busy || matchIndices.length === 0}
                                    onClick={() =>
                                        setIndices(matchIndices, indexState(prefix, matchIndices) !== 'on')
                                    }
                                >
                                    <span className="al-chip__icon">
                                        <Icon name="search" />
                                    </span>
                                    {t('addLayer.matches')}
                                    <span className="al-chip__count">{matchIndices.length}</span>
                                </button>
                            )}
                        </div>

                        {loading && (
                            <div className="al-state">
                                <span className="al-spin">
                                    <Icon name="refresh" />
                                </span>
                                {t('addLayer.reading', { layer: sourceLayer })}
                            </div>
                        )}
                        {!loading && loadError && <div className="al-state al-state--error">{loadError}</div>}
                        {!loading && !loadError && rows.length === 0 && (
                            <div className="al-state">
                                {tree && tree.files.length === 0
                                    ? t('addLayer.emptyLayer', { layer: sourceLayer })
                                    : t('addLayer.noMatch')}
                            </div>
                        )}
                        {!loading && !loadError && rows.length > 0 && (
                            <div className="al-list">
                                <VirtualList items={rows} rowHeight={ROW_HEIGHT} renderRow={renderRow} />
                            </div>
                        )}
                    </div>
                </div>

                <div className="dl-modal__foot">
                    <div className="al-summary">
                        {tree && (
                            <>
                                <strong>{selectedCount.toLocaleString()}</strong>
                                {` ${t('addLayer.ofFiles', { total: tree.files.length.toLocaleString() })}`}
                                {selectedCount > 0 && ` · ${formatBytes(selectedBytes)}`}
                            </>
                        )}
                    </div>
                    <Button
                        variant="ghost"
                        onClick={() => setSelection(new Uint8Array(selection.length))}
                        disabled={busy || selectedCount === 0}
                    >
                        {t('addLayer.clear')}
                    </Button>
                    <Button variant="secondary" onClick={closeModal} disabled={busy}>
                        {t('common.cancel')}
                    </Button>
                    <Button variant="primary" onClick={() => void handleSubmit()} disabled={!canSubmit}>
                        {busy ? t('addLayer.creating') : t('addLayer.create')}
                    </Button>
                </div>
            </div>
        </div>,
        document.body,
    );
};
