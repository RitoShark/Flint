import React, { useCallback, useMemo, useRef, useState } from 'react';
import { useModelEditorStore } from '../../lib/stores/modelEditorStore';
import { useModalStore } from '../../lib/stores/modalStore';
import { useNotificationStore } from '../../lib/stores';
import { buildBoneTree, type BoneNode } from '../../lib/editor3d/boneTree';
import { validateSubmeshName, validateJointName } from '../../lib/editor3d/renameValidation';
import { usableForms } from '../../lib/editor3d/submeshBaseline';
import { fnv1a32Lower } from '../../lib/babylon/submeshVisibility';
import { beginPointerDrag } from '../../lib/pointerDrag';
import { getIcon } from '../../lib/ui-helpers/fileIcons';
import { readAnimationList } from '../../lib/api/mesh';
import { previewJointRename, assignSubmeshToForm, type JointRenameImpact } from '../../lib/api/modelEdit';
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
    renamingId: number | null;
    renameValue: string;
    renameError: string | null;
    renameInputRef: React.RefObject<HTMLInputElement>;
    onStartRename: (node: BoneNode) => void;
    onRenameValueChange: (value: string) => void;
    onCommitRename: () => void;
    onCancelRename: () => void;
    onBoneContextMenu: (e: React.MouseEvent, node: BoneNode) => void;
}

const BoneRow: React.FC<BoneRowProps> = ({
    node,
    depth,
    forceExpanded,
    collapsedIds,
    onToggleCollapse,
    selection,
    onSelect,
    renamingId,
    renameValue,
    renameError,
    renameInputRef,
    onStartRename,
    onRenameValueChange,
    onCommitRename,
    onCancelRename,
    onBoneContextMenu,
}) => {
    const hasChildren = node.children.length > 0;
    const expanded = forceExpanded || !collapsedIds.has(node.bone.id);
    const selected = selection?.kind === 'joint' && selection.id === node.bone.id;
    // A root joint (there can be more than one) has no parent to re-anchor
    // renamed references onto in the backend's eyes — it's rejected there too,
    // this just keeps the UI from offering a doomed op.
    const isRoot = node.bone.parent_id === -1;
    const isRenaming = renamingId === node.bone.id;

    return (
        <>
            <div
                className={`m3d__row m3d__row--bone${selected ? ' m3d__row--selected' : ''}`}
                style={{ paddingLeft: 6 + depth * 14 }}
                tabIndex={0}
                title={isRoot ? 'Root joints cannot be renamed.' : undefined}
                onClick={() => onSelect({ kind: 'joint', id: node.bone.id })}
                onDoubleClick={() => {
                    if (!isRoot) onStartRename(node);
                }}
                onKeyDown={(e) => {
                    if (e.key === 'F2' && !isRoot) {
                        e.preventDefault();
                        onStartRename(node);
                    }
                }}
                onContextMenu={(e) => {
                    if (!isRoot) onBoneContextMenu(e, node);
                }}
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
                {isRenaming ? (
                    <span className="m3d__name-edit">
                        <input
                            ref={renameInputRef}
                            className="m3d__name-input"
                            value={renameValue}
                            autoFocus
                            onChange={(e) => onRenameValueChange(e.target.value)}
                            onBlur={onCommitRename}
                            onKeyDown={(e) => {
                                e.stopPropagation();
                                if (e.key === 'Enter') onCommitRename();
                                else if (e.key === 'Escape') onCancelRename();
                            }}
                            onClick={(e) => e.stopPropagation()}
                            onPointerDown={(e) => e.stopPropagation()}
                        />
                        {renameError && <span className="m3d__name-error">{renameError}</span>}
                    </span>
                ) : (
                    <span className="m3d__row-name">{node.bone.name}</span>
                )}
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
                    renamingId={renamingId}
                    renameValue={renameValue}
                    renameError={renameError}
                    renameInputRef={renameInputRef}
                    onStartRename={onStartRename}
                    onRenameValueChange={onRenameValueChange}
                    onCommitRename={onCommitRename}
                    onCancelRename={onCancelRename}
                    onBoneContextMenu={onBoneContextMenu}
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
    const showToast = useNotificationStore((s) => s.showToast);
    const sessionId = useModelEditorStore((s) => s.sessionId);

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
    // Every gear form, unfiltered — unlike `forms` above (only the ones that
    // currently change baseline visibility, for the top form-switch buttons),
    // "Assign to Form" must offer every form so a currently-inert form can be
    // given its first show/hide rule.
    const allForms = animationList?.forms ?? [];

    const [isolatedName, setIsolatedName] = useState<string | null>(null);

    const [renameIndex, setRenameIndex] = useState<number | null>(null);
    const [renameValue, setRenameValue] = useState('');
    const [renameError, setRenameError] = useState<string | null>(null);
    const renameInputRef = useRef<HTMLInputElement>(null);

    const [dragIndex, setDragIndex] = useState<number | null>(null);
    const [dropIndex, setDropIndex] = useState<number | null>(null);

    const [boneFilter, setBoneFilter] = useState('');
    const [collapsedIds, setCollapsedIds] = useState<Set<number>>(() => new Set());

    const boneNames = useMemo(() => skeleton?.bones.map((b) => b.name) ?? [], [skeleton]);
    const [boneRenameId, setBoneRenameId] = useState<number | null>(null);
    const [boneRenameValue, setBoneRenameValue] = useState('');
    const [boneRenameError, setBoneRenameError] = useState<string | null>(null);
    const boneRenameInputRef = useRef<HTMLInputElement>(null);

    // Impact-preview dialog for a pending joint rename — populated by
    // `previewJointRename` before the rename is staged, so the user sees the
    // blast radius (every `.anm` + BIN reference hashing this joint's name)
    // before committing. `impact === null` while the preview is in flight.
    const [jointImpact, setJointImpact] = useState<{
        index: number;
        oldName: string;
        newName: string;
        impact: JointRenameImpact | null;
    } | null>(null);

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

    const startBoneRename = useCallback((node: BoneNode) => {
        setBoneRenameId(node.bone.id);
        setBoneRenameValue(node.bone.name);
        setBoneRenameError(null);
    }, []);

    const cancelBoneRename = useCallback(() => {
        setBoneRenameId(null);
        setBoneRenameError(null);
    }, []);

    const requestJointRenameImpact = useCallback(
        async (index: number, oldName: string, newName: string) => {
            if (!sessionId) return;
            setJointImpact({ index, oldName, newName, impact: null });
            try {
                const impact = await previewJointRename(sessionId, index);
                setJointImpact({ index, oldName, newName, impact });
            } catch (err) {
                setJointImpact(null);
                showToast('error', String(err));
            }
        },
        [sessionId, showToast],
    );

    const commitBoneRename = useCallback(() => {
        if (boneRenameId === null || !skeleton) return;
        const index = skeleton.bones.findIndex((b) => b.id === boneRenameId);
        if (index < 0) {
            setBoneRenameId(null);
            return;
        }
        const trimmed = boneRenameValue.trim();
        const err = validateJointName(trimmed, boneNames, index);
        if (err) {
            setBoneRenameError(err);
            boneRenameInputRef.current?.focus();
            return;
        }
        const original = boneNames[index];
        setBoneRenameId(null);
        setBoneRenameError(null);
        if (trimmed === original) return; // no-op — nothing to preview/stage
        void requestJointRenameImpact(index, original, trimmed);
    }, [boneRenameId, boneRenameValue, boneNames, skeleton, requestJointRenameImpact]);

    const confirmJointRename = useCallback(() => {
        if (!jointImpact) return;
        const { index, newName } = jointImpact;
        setJointImpact(null);
        void onEdit({ kind: 'renameJoint', index, name: newName });
    }, [jointImpact, onEdit]);

    const cancelJointImpact = useCallback(() => setJointImpact(null), []);

    const handleBoneContextMenu = useCallback(
        (e: React.MouseEvent, node: BoneNode) => {
            e.preventDefault();
            const options: ContextMenuOption[] = [
                {
                    label: 'Rename',
                    icon: getIcon('file-edit'),
                    onClick: () => startBoneRename(node),
                },
            ];
            openContextMenu(e.clientX, e.clientY, options);
        },
        [openContextMenu, startBoneRename],
    );

    const handleAssignToForm = useCallback(
        async (formIndex: number, formName: string, submeshName: string, mode: 'show' | 'hide' | 'clear') => {
            if (!sourcePath) return;
            try {
                await assignSubmeshToForm(sourcePath, formIndex, submeshName, mode);
                const verb = mode === 'show' ? 'now shows in' : mode === 'hide' ? 'now hidden in' : 'cleared from';
                showToast('success', `Skin BIN written — "${submeshName}" ${verb} ${formName}.`);
                const list = await readAnimationList(sourcePath);
                useModelEditorStore.getState().setAnimationList(list);
            } catch (err) {
                showToast('error', String(err));
            }
        },
        [sourcePath, showToast],
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
            // Absent entirely (not an empty submenu) when the skin has no gear forms.
            if (allForms.length > 0) {
                const hash = fnv1a32Lower(name);
                const formSubmenu: ContextMenuOption[] = [];
                allForms.forEach((form, formIndex) => {
                    const shown = form.show_hashes.some((h) => (h >>> 0) === hash);
                    const hidden = !shown && form.hide_hashes.some((h) => (h >>> 0) === hash);
                    const cleared = !shown && !hidden;
                    formSubmenu.push(
                        {
                            label: `Show in ${form.name}`,
                            icon: shown ? getIcon('check') : undefined,
                            separator: formIndex > 0,
                            onClick: () => { void handleAssignToForm(formIndex, form.name, name, 'show'); },
                        },
                        {
                            label: `Hide in ${form.name}`,
                            icon: hidden ? getIcon('check') : undefined,
                            onClick: () => { void handleAssignToForm(formIndex, form.name, name, 'hide'); },
                        },
                        {
                            label: `Not in ${form.name}`,
                            icon: cleared ? getIcon('check') : undefined,
                            onClick: () => { void handleAssignToForm(formIndex, form.name, name, 'clear'); },
                        },
                    );
                });
                options.push({
                    label: 'Assign to Form',
                    icon: getIcon('target'),
                    submenu: formSubmenu,
                });
            }
            openContextMenu(e.clientX, e.clientY, options);
        },
        [names, sourcePath, clipboard, isolatedName, allForms, onEdit, uniqueName, openConfirmDialog, openContextMenu, setClipboard, toggleIsolate, startRename, handleAssignToForm],
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
                                        renamingId={boneRenameId}
                                        renameValue={boneRenameValue}
                                        renameError={boneRenameError}
                                        renameInputRef={boneRenameInputRef}
                                        onStartRename={startBoneRename}
                                        onRenameValueChange={(v) => {
                                            setBoneRenameValue(v);
                                            setBoneRenameError(null);
                                        }}
                                        onCommitRename={commitBoneRename}
                                        onCancelRename={cancelBoneRename}
                                        onBoneContextMenu={handleBoneContextMenu}
                                    />
                                ))
                            )}
                        </div>
                    </>
                )}
            </div>
            {jointImpact && (
                <div
                    className="m3d__discard-overlay"
                    onClick={(e) => {
                        if (e.target === e.currentTarget) cancelJointImpact();
                    }}
                >
                    <div className="m3d__discard-dialog m3d__impact-dialog">
                        <h3 className="m3d__discard-title">Rename joint</h3>
                        <p className="m3d__discard-message">
                            Rename &quot;{jointImpact.oldName}&quot; to &quot;{jointImpact.newName}&quot;? Its name is
                            hashed into every <code>.anm</code> track and any BIN field that references this bone.
                        </p>
                        {!jointImpact.impact ? (
                            <p className="m3d__hint">Checking impact…</p>
                        ) : (
                            <>
                                <p className="m3d__discard-message">
                                    This will update {jointImpact.impact.anmFiles.length} .anm file
                                    {jointImpact.impact.anmFiles.length === 1 ? '' : 's'} and{' '}
                                    {jointImpact.impact.binRefs.length} BIN reference
                                    {jointImpact.impact.binRefs.length === 1 ? '' : 's'}:
                                </p>
                                {jointImpact.impact.anmFiles.length === 0 && jointImpact.impact.binRefs.length === 0 ? (
                                    <p className="m3d__hint">Nothing else references this joint by name.</p>
                                ) : (
                                    <ul className="m3d__impact-list">
                                        {jointImpact.impact.anmFiles.map((f) => (
                                            <li key={`anm-${f}`} title={f}>{f}</li>
                                        ))}
                                        {jointImpact.impact.binRefs.map((r, i) => (
                                            <li key={`bin-${i}-${r.file}-${r.field}`} title={`${r.file} — ${r.field}`}>
                                                {r.file} — {r.field}
                                            </li>
                                        ))}
                                    </ul>
                                )}
                            </>
                        )}
                        <div className="m3d__discard-actions">
                            <button type="button" className="m3d__btn" onClick={cancelJointImpact}>
                                Cancel
                            </button>
                            <button
                                type="button"
                                className="m3d__btn m3d__btn--primary"
                                onClick={confirmJointRename}
                                disabled={!jointImpact.impact}
                            >
                                Rename
                            </button>
                        </div>
                    </div>
                </div>
            )}
        </div>
    );
};
