import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useModelEditorStore } from '../../lib/stores/modelEditorStore';
import { useModalStore } from '../../lib/stores/modalStore';
import { buildBoneTree, type BoneNode } from '../../lib/editor3d/boneTree';
import { validateSubmeshName } from '../../lib/editor3d/renameValidation';
import { usableForms } from '../../lib/editor3d/submeshBaseline';
import { beginPointerDrag } from '../../lib/pointerDrag';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import type { ContextMenuOption } from '../../lib/types';
import type { ModelEdit } from '../../lib/api/modelEdit';
import type { Selection } from '../../lib/stores/modelEditorStore';

export interface OutlinerProps {
    onEdit: (edit: ModelEdit) => Promise<void>;
    onIsolate: (name: string | null) => void;
}

/** Keep a joint whose name matches the filter, OR which has a matching
 *  descendant, so the path down to a match stays visible. */
function filterBoneTree(nodes: BoneNode[], query: string): BoneNode[] {
    if (!query) return nodes;
    const filterNode = (node: BoneNode): BoneNode | null => {
        const children = node.children
            .map(filterNode)
            .filter((n): n is BoneNode => n !== null);
        const selfMatches = node.bone.name.toLowerCase().includes(query);
        if (!selfMatches && children.length === 0) return null;
        return { bone: node.bone, children };
    };
    return nodes.map(filterNode).filter((n): n is BoneNode => n !== null);
}

interface BoneRowProps {
    node: BoneNode;
    depth: number;
    forceExpanded: boolean;
    collapsedIds: Set<number>;
    onToggleCollapse: (id: number) => void;
    selection: Selection;
    onSelect: (selection: Selection) => void;
}

const BoneRow: React.FC<BoneRowProps> = ({
    node,
    depth,
    forceExpanded,
    collapsedIds,
    onToggleCollapse,
    selection,
    onSelect,
}) => {
    const hasChildren = node.children.length > 0;
    const expanded = forceExpanded || !collapsedIds.has(node.bone.id);
    const selected = selection?.kind === 'joint' && selection.id === node.bone.id;

    return (
        <>
            <div
                className={`m3d__row m3d__row--bone${selected ? ' m3d__row--selected' : ''}`}
                style={{ paddingLeft: 6 + depth * 14 }}
                onClick={() => onSelect({ kind: 'joint', id: node.bone.id })}
            >
                {hasChildren ? (
                    <button
                        type="button"
                        className="m3d__tree-toggle"
                        onClick={(e) => {
                            e.stopPropagation();
                            onToggleCollapse(node.bone.id);
                        }}
                        aria-label={expanded ? 'Collapse' : 'Expand'}
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon(expanded ? 'chevronDown' : 'chevronRight') }} />
                    </button>
                ) : (
                    <span className="m3d__tree-toggle m3d__tree-toggle--spacer" />
                )}
                <span className="m3d__row-icon" dangerouslySetInnerHTML={{ __html: getIcon('skeleton') }} />
                <span className="m3d__row-name">{node.bone.name}</span>
            </div>
            {hasChildren && expanded && node.children.map((child) => (
                <BoneRow
                    key={child.bone.id}
                    node={child}
                    depth={depth + 1}
                    forceExpanded={forceExpanded}
                    collapsedIds={collapsedIds}
                    onToggleCollapse={onToggleCollapse}
                    selection={selection}
                    onSelect={onSelect}
                />
            ))}
        </>
    );
};

export const Outliner: React.FC<OutlinerProps> = ({ onEdit, onIsolate }) => {
    const summary = useModelEditorStore((s) => s.summary);
    const skeleton = useModelEditorStore((s) => s.skeleton);
    const selection = useModelEditorStore((s) => s.selection);
    const clipboard = useModelEditorStore((s) => s.clipboard);
    const sourcePath = useModelEditorStore((s) => s.sourcePath);
    const select = useModelEditorStore((s) => s.select);
    const setClipboard = useModelEditorStore((s) => s.setClipboard);
    const openContextMenu = useModalStore((s) => s.openContextMenu);
    const openConfirmDialog = useModalStore((s) => s.openConfirmDialog);

    // Baseline + gear-form visibility (GearSkinUpgrade, e.g. Kayn's Assassin/
    // Slayer) and the resulting hidden set — view state, never staged as ops.
    // The viewport (EditorViewport) reacts to `hiddenNames`/`activeForm` the
    // same way it reacts to selection, so either side can drive it.
    const animationList = useModelEditorStore((s) => s.animationList);
    const activeForm = useModelEditorStore((s) => s.activeForm);
    const setActiveForm = useModelEditorStore((s) => s.setActiveForm);
    const hiddenNames = useModelEditorStore((s) => s.hiddenNames);
    const toggleHiddenName = useModelEditorStore((s) => s.toggleHiddenName);

    const submeshes = useMemo(() => summary?.submeshes ?? [], [summary]);
    const names = useMemo(() => submeshes.map((s) => s.name), [submeshes]);

    const forms = useMemo(
        () => usableForms(animationList?.initial_hide, animationList?.forms, names),
        [animationList, names],
    );

    const [isolatedName, setIsolatedName] = useState<string | null>(null);

    const [renameIndex, setRenameIndex] = useState<number | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [renameError, setRenameError] = useState<string | null>(null);
    const renameInputRef = useRef<HTMLInputElement>(null);

    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);

    const [boneFilter, setBoneFilter] = useState('');
    const [collapsedIds, setCollapsedIds] = useState<Set<number>>(() => new Set());

    const uniqueName = useCallback(
        (base: string): string => {
            if (validateSubmeshName(base, names, null) === null) return base;
            let n = 2;
            while (validateSubmeshName(`${base}_${n}`, names, null) !== null) n++;
            return `${base}_${n}`;
        },
        [names],
    );

    const startRename = useCallback(
        (index: number) => {
            setRenameIndex(index);
            setRenameValue(names[index] ?? '');
            setRenameError(null);
        },
        [names],
    );

    const cancelRename = useCallback(() => {
        setRenameIndex(null);
        setRenameError(null);
    }, []);

    const commitRename = useCallback(() => {
        if (renameIndex === null) return;
        const trimmed = renameValue.trim();
        const err = validateSubmeshName(trimmed, names, renameIndex);
        if (err) {
            setRenameError(err);
            renameInputRef.current?.focus();
            return;
        }
        const index = renameIndex;
        const original = names[index];
        setRenameIndex(null);
        setRenameError(null);
        if (trimmed === original) return; // no-op — nothing to stage
        void onEdit({ kind: 'renameSubmesh', index, name: trimmed });
    }, [renameIndex, renameValue, names, onEdit]);

    const toggleVisible = useCallback(
        (name: string) => {
            toggleHiddenName(name);
        },
        [toggleHiddenName],
    );

    const toggleIsolate = useCallback(
        (name: string) => {
            setIsolatedName((prev) => {
                const next = prev === name ? null : name;
                onIsolate(next);
                return next;
            });
        },
        [onIsolate],
    );

    const handleReorderDragStart = useCallback(
        (e: React.PointerEvent, index: number) => {
            beginPointerDrag(e, {
                label: names[index] ?? 'submesh',
                // Only fires once real pointer movement crosses the drag threshold, so a
                // plain click never flashes the "dragging" look on the row.
                onMove: (x, y) => {
                    setDragIndex(index);
                    const el = document.elementFromPoint(x, y) as HTMLElement | null;
                    const row = el?.closest<HTMLElement>('[data-submesh-index]');
                    const raw = row?.getAttribute('data-submesh-index');
                    const idx = raw !== undefined && raw !== null ? Number(raw) : NaN;
                    setDropIndex(Number.isFinite(idx) ? idx : null);
                },
                onDrop: ({ clientX, clientY }) => {
                    const el = document.elementFromPoint(clientX, clientY) as HTMLElement | null;
                    const row = el?.closest<HTMLElement>('[data-submesh-index]');
                    const raw = row?.getAttribute('data-submesh-index');
                    const to = raw !== undefined && raw !== null ? Number(raw) : NaN;
                    if (Number.isFinite(to) && to !== index) {
                        void onEdit({ kind: 'reorderSubmesh', from: index, to });
                    }
                },
                onEnd: () => {
                    setDragIndex(null);
                    setDropIndex(null);
                },
            });
        },
        [names, onEdit],
    );

    const handleContextMenu = useCallback(
        (e: React.MouseEvent, index: number) => {
            e.preventDefault();
            const name = names[index];
            const options: ContextMenuOption[] = [
                {
                    label: 'Rename',
                    icon: getIcon('file-edit'),
                    onClick: () => startRename(index),
                },
                {
                    label: 'Duplicate',
                    icon: getIcon('copy'),
                    onClick: () => {
                        void onEdit({ kind: 'duplicateSubmesh', index, name: uniqueName(`${name}_copy`) });
                    },
                },
                {
                    label: 'Delete',
                    icon: getIcon('trash'),
                    danger: true,
                    onClick: () => {
                        openConfirmDialog({
                            title: 'Delete submesh',
                            message: `Delete "${name}"? This can only be undone with Undo in this session.`,
                            confirmLabel: 'Delete',
                            danger: true,
                            onConfirm: () => {
                                void onEdit({ kind: 'deleteSubmesh', index });
                            },
                        });
                    },
                },
                {
                    label: 'Copy',
                    icon: getIcon('copy'),
                    disabled: !sourcePath,
                    onClick: () => {
                        if (!sourcePath) return;
                        setClipboard({ sourceSkn: sourcePath, sourceIndex: index, name });
                    },
                },
                {
                    label: 'Paste',
                    icon: getIcon('import'),
                    disabled: clipboard === null,
                    onClick: () => {
                        if (!clipboard) return;
                        void onEdit({
                            kind: 'pasteSubmesh',
                            sourceSkn: clipboard.sourceSkn,
                            sourceIndex: clipboard.sourceIndex,
                            name: uniqueName(clipboard.name),
                        });
                    },
                },
                {
                    label: isolatedName === name ? 'Clear isolation' : 'Isolate',
                    icon: getIcon('target'),
                    onClick: () => toggleIsolate(name),
                },
            ];
            openContextMenu(e.clientX, e.clientY, options);
        },
        [names, sourcePath, clipboard, isolatedName, onEdit, uniqueName, openConfirmDialog, openContextMenu, setClipboard, toggleIsolate, startRename],
    );

    const toggleBoneCollapse = useCallback((id: number) => {
        setCollapsedIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id);
            else next.add(id);
            return next;
        });
    }, []);

    const boneTree = useMemo(() => (skeleton ? buildBoneTree(skeleton.bones) : []), [skeleton]);
    const trimmedFilter = boneFilter.trim().toLowerCase();
    const filteredBoneTree = useMemo(
        () => filterBoneTree(boneTree, trimmedFilter),
        [boneTree, trimmedFilter],
    );

    return (
        <div className="m3d__outliner">
            <div className="m3d__section">
                <div className="m3d__section-title">Meshes</div>
                {forms.length > 0 && (
                    <div className="m3d__forms">
                        <button
                            type="button"
                            className={`m3d__form-btn ${activeForm === -1 ? 'm3d__form-btn--active' : ''}`}
                            onClick={() => setActiveForm(-1)}
                        >
                            Base
                        </button>
                        {forms.map(({ form, index }) => (
                            <button
                                type="button"
                                key={index}
                                className={`m3d__form-btn ${activeForm === index ? 'm3d__form-btn--active' : ''}`}
                                onClick={() => setActiveForm(index)}
                            >
                                {form.name}
                            </button>
                        ))}
                    </div>
                )}
                {submeshes.length === 0 ? (
                    <div className="m3d__hint">No submeshes.</div>
                ) : (
                    <ul className="m3d__list" role="list">
                        {submeshes.map((s, index) => {
                            const selected = selection?.kind === 'submesh' && selection.name === s.name;
                            const hidden = hiddenNames.has(s.name);
                            const isolated = isolatedName === s.name;
                            const isRenaming = renameIndex === index;
                            const rowClass = [
                                'm3d__row',
                                selected && 'm3d__row--selected',
                                dragIndex === index && 'm3d__row--dragging',
                                dropIndex === index && dragIndex !== null && dragIndex !== index && 'm3d__row--drop-target',
                            ].filter(Boolean).join(' ');
                            return (
                                <li
                                    key={`${index}-${s.name}`}
                                    className={rowClass}
                                    data-submesh-index={index}
                                    tabIndex={0}
                                    onClick={() => select({ kind: 'submesh', name: s.name })}
                                    onDoubleClick={() => startRename(index)}
                                    onKeyDown={(e) => {
                                        if (e.key === 'F2') {
                                            e.preventDefault();
                                            startRename(index);
                                        }
                                    }}
                                    onContextMenu={(e) => handleContextMenu(e, index)}
                                    onPointerDown={(e) => {
                                        if (isRenaming) return;
                                        handleReorderDragStart(e, index);
                                    }}
                                >
                                    <button
                                        type="button"
                                        className="m3d__eye"
                                        title={hidden ? 'Hidden — click to show' : 'Visible — click to hide'}
                                        onClick={(e) => {
                                            e.stopPropagation();
                                            toggleVisible(s.name);
                                        }}
                                    >
                                        <span dangerouslySetInnerHTML={{ __html: getIcon(hidden ? 'eye-off' : 'eye') }} />
                                    </button>
                                    {isRenaming ? (
                                        <span className="m3d__name-edit">
                                            <input
                                                ref={renameInputRef}
                                                className="m3d__name-input"
                                                value={renameValue}
                                                autoFocus
                                                onChange={(e) => {
                                                    setRenameValue(e.target.value);
                                                    setRenameError(null);
                                                }}
                                                onBlur={commitRename}
                                                onKeyDown={(e) => {
                                                    e.stopPropagation();
                                                    if (e.key === 'Enter') commitRename();
                                                    else if (e.key === 'Escape') cancelRename();
                                                }}
                                                onClick={(e) => e.stopPropagation()}
                                                onPointerDown={(e) => e.stopPropagation()}
                                            />
                                            {renameError && <span className="m3d__name-error">{renameError}</span>}
                                        </span>
                                    ) : (
                                        <span className={`m3d__row-name${isolated ? ' m3d__row-name--isolated' : ''}`}>
                                            {s.name}
                                        </span>
                                    )}
                                </li>
                            );
                        })}
                    </ul>
                )}
            </div>

            <div className="m3d__section">
                <div className="m3d__section-title">Skeleton</div>
                {!skeleton ? (
                    <div className="m3d__hint">This .skn has no sibling .skl — skeleton unavailable.</div>
                ) : (
                    <>
                        <input
                            className="m3d__filter"
                            placeholder="Filter joints…"
                            value={boneFilter}
                            onChange={(e) => setBoneFilter(e.target.value)}
                        />
                        <div className="m3d__tree">
                            {filteredBoneTree.length === 0 && trimmedFilter ? (
                                <div className="m3d__hint">No joints match “{boneFilter.trim()}”.</div>
                            ) : (
                                filteredBoneTree.map((node) => (
                                    <BoneRow
                                        key={node.bone.id}
                                        node={node}
                                        depth={0}
                                        forceExpanded={!!trimmedFilter}
                                        collapsedIds={collapsedIds}
                                        onToggleCollapse={toggleBoneCollapse}
                                        selection={selection}
                                        onSelect={select}
                                    />
                                ))
                            )}
                        </div>
                    </>
                )}
            </div>
        </div>
    );
};
