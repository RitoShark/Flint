/**
 * Shared right-click menu builder used by both FileTree and FolderGridView.
 * Keeps the two surfaces in sync — anything you wire up here shows up in
 * both places.
 */

import * as api from './api';
import { getIcon } from './fileIcons';
import type { ContextMenuOption, ModalType } from './types';

interface BuildOptionsArgs {
    /** The node being right-clicked. */
    node: { path: string; name: string; isDirectory: boolean };
    /** Project root absolute path. */
    projectPath: string;
    /** Tree depth — used to show root-only options like "Set Thumbnail". */
    depth: number;
    /** Refresh the project file tree after a mutation. */
    refreshFileTree: () => Promise<void>;
    /** Open the named modal with the given options. */
    openModal: (modal: ModalType, options?: Record<string, unknown>) => void;
    /** Open the confirmation dialog (Delete, Organize, etc). */
    openConfirmDialog: (dialog: {
        title: string;
        message: string;
        confirmLabel?: string;
        danger?: boolean;
        onConfirm: () => void;
    }) => void;
    /** Toast notifications. */
    showToast: (type: 'info' | 'success' | 'warning' | 'error', message: string) => void;
    /** Optional rename trigger — when present, the menu shows "Rename".
     *  FileTree passes its inline-rename setter; grid views can omit it. */
    onRename?: (path: string) => void;
    /** League installation path — needed by "Restore from Original".
     *  When omitted, the action toasts a "set League path" hint instead. */
    leaguePath?: string | null;
}

function isContentFolder(path: string): boolean {
    const normalized = path.replace(/\\/g, '/');
    return normalized === 'content' || normalized.endsWith('/content');
}

export function buildFileContextMenuOptions(args: BuildOptionsArgs): ContextMenuOption[] {
    const { node, projectPath, depth, refreshFileTree, openModal, openConfirmDialog, showToast, onRename, leaguePath } = args;
    const options: ContextMenuOption[] = [];

    const fullPath = projectPath
        ? `${projectPath.replace(/\\/g, '/')}/${node.path}`
        : node.path;
    const fileName = node.name;
    const ext = fileName.includes('.') ? fileName.split('.').pop()?.toLowerCase() ?? '' : '';

    if (node.isDirectory) {
        if (depth === 0 && projectPath) {
            // All root-level project actions live under one "Project ▸"
            // umbrella so the top of the menu stays focused on the folder
            // itself (new folder, rename, copy path, delete) instead of
            // mixing in project-meta concerns.
            options.push({
                label: 'Project',
                icon: getIcon('code'),
                separator: true,
                submenu: [
                    {
                        label: 'Edit Project Info',
                        icon: getIcon('code'),
                        onClick: () => {
                            const configPath = `${projectPath.replace(/\\/g, '/')}/mod.config.json`;
                            openModal('modConfig', { filePath: configPath });
                        },
                    },
                    {
                        label: 'Set Thumbnail…',
                        icon: getIcon('document'),
                        onClick: () => openModal('thumbnail', { projectPath }),
                    },
                    {
                        label: 'Add Layer…',
                        icon: getIcon('plus'),
                        separator: true,
                        onClick: () => openModal('addLayer'),
                    },
                    {
                        label: 'Port to Chromas…',
                        icon: getIcon('texture'),
                        onClick: () => openModal('chromaPort'),
                    },
                ],
            });
        }

        if (isContentFolder(node.path)) {
            options.push({
                label: 'Add Layer…',
                icon: getIcon('plus'),
                onClick: () => openModal('addLayer'),
            });
            options.push({
                label: 'Batch Recolor',
                icon: getIcon('texture'),
                separator: true,
                onClick: () => openModal('recolor', { filePath: node.path, isFolder: true }),
            });
        } else {
            options.push({
                label: 'Batch Recolor',
                icon: getIcon('texture'),
                onClick: () => openModal('recolor', { filePath: node.path, isFolder: true }),
            });
        }

        options.push({
            label: 'New Folder',
            icon: getIcon('folder'),
            separator: true,
            onClick: async () => {
                const newDir = `${node.path}/New Folder`;
                try {
                    await api.createDirectory(projectPath, newDir);
                    await refreshFileTree();
                } catch (err) {
                    const flintError = err as api.FlintError;
                    showToast('error', flintError.getUserMessage?.() || 'Failed to create folder');
                }
            },
        });

        if (onRename) {
            options.push({
                label: 'Rename',
                icon: getIcon('text'),
                onClick: () => onRename(node.path),
            });
        }

        if (fileName.toLowerCase() === 'data') {
            // BIN-folder tooling lives under "BIN Tools ▸" so the data folder's
            // top-level menu doesn't drown the common "rename / copy / delete"
            // actions in specialist tooling.
            const binTools: ContextMenuOption[] = [];
            binTools.push({
                label: 'Split BINs by Class…',
                icon: getIcon('code'),
                onClick: async () => {
                    const defaultOutputName = await api.getVfxFilename(fullPath.replace(/\//g, '\\'));
                    openModal('binSplit', {
                        mode: 'folder',
                        folderPath: fullPath.replace(/\//g, '\\'),
                        defaultOutputName,
                    });
                },
            });
            binTools.push({
                label: 'Organize VFX (auto-consolidate)…',
                icon: getIcon('texture'),
                onClick: async () => {
                    const folderAbs = fullPath.replace(/\//g, '\\');
                    try {
                        const preview = await api.previewOrganizeVfx(folderAbs);
                        const ownerRel = preview.suggested_owner
                            ? preview.suggested_owner.split(/[\\/]/).slice(-3).join('/')
                            : '(none — cannot run)';
                        const deletedEstimate = preview.sources.length > 1
                            ? `up to ${preview.sources.length - 1} non-owner BIN${preview.sources.length - 1 === 1 ? '' : 's'} may be removed`
                            : 'no other BINs to merge';

                        openConfirmDialog({
                            title: 'Organize VFX',
                            message:
                                `Pull ${preview.vfx_objects_estimate} VFX object${preview.vfx_objects_estimate === 1 ? '' : 's'} into ` +
                                `data/${preview.vfx_filename} and merge ${preview.main_objects_estimate} non-VFX object${preview.main_objects_estimate === 1 ? '' : 's'} ` +
                                `into the main BIN (${ownerRel}). ${deletedEstimate}. Continue?`,
                            confirmLabel: 'Organize',
                            onConfirm: async () => {
                                if (!preview.suggested_owner) {
                                    showToast('error', 'No main skin BIN found in this folder — cannot organize');
                                    return;
                                }
                                try {
                                    const result = await api.organizeBinsVfx(
                                        folderAbs,
                                        preview.suggested_owner,
                                        preview.vfx_filename,
                                    );
                                    const msg =
                                        `${result.vfx_objects_moved} VFX → ${preview.vfx_filename}, ` +
                                        `${result.main_objects_merged} merged into main, ` +
                                        `${result.sources_deleted.length} BIN${result.sources_deleted.length === 1 ? '' : 's'} removed`;
                                    showToast('success', msg);
                                    await refreshFileTree();
                                } catch (e) {
                                    const m = (e as { message?: string })?.message ?? String(e);
                                    showToast('error', `Organize failed: ${m}`);
                                }
                            },
                        });
                    } catch (e) {
                        const m = (e as { message?: string })?.message ?? String(e);
                        showToast('error', `Preview failed: ${m}`);
                    }
                },
            });

            options.push({
                label: 'BIN Tools',
                icon: getIcon('code'),
                separator: true,
                submenu: binTools,
            });
        }

        options.push({
            label: 'Copy',
            icon: getIcon('code'),
            separator: true,
            submenu: [
                {
                    label: 'Absolute Path',
                    icon: getIcon('code'),
                    onClick: () => navigator.clipboard.writeText(fullPath.replace(/\//g, '\\')),
                },
                {
                    label: 'Relative Path',
                    icon: getIcon('code'),
                    onClick: () => navigator.clipboard.writeText(node.path),
                },
                {
                    label: 'Folder Name',
                    icon: getIcon('folder'),
                    onClick: () => navigator.clipboard.writeText(fileName),
                },
            ],
        });

        options.push({
            label: 'Reveal in Explorer',
            icon: getIcon('folderOpen2'),
            onClick: () => api.openInExplorer(fullPath.replace(/\//g, '\\')).catch(() => { }),
        });

        options.push({
            label: 'Delete',
            icon: getIcon('trash'),
            danger: true,
            separator: true,
            onClick: () => {
                openConfirmDialog({
                    title: 'Delete Folder',
                    message: `Are you sure you want to delete "${fileName}" and all its contents? This cannot be undone.`,
                    confirmLabel: 'Delete',
                    danger: true,
                    onConfirm: async () => {
                        try {
                            await api.deleteFile(projectPath, node.path);
                            await refreshFileTree();
                            showToast('success', 'Folder deleted');
                        } catch (err) {
                            const flintError = err as api.FlintError;
                            showToast('error', flintError.getUserMessage?.() || 'Failed to delete folder');
                        }
                    },
                });
            },
        });
        return options;
    }

    // ── File ──────────────────────────────────────────────────────────────

    if (fileName === 'mod.config.json') {
        options.push({
            label: 'Edit Project Info',
            icon: getIcon('code'),
            onClick: () => openModal('modConfig', { filePath: fullPath }),
        });
        options.push({
            label: 'Add Contributor',
            icon: getIcon('plus'),
            onClick: async () => {
                try {
                    const text = await api.readTextFile(fullPath);
                    const config = JSON.parse(text);
                    const name = prompt('Contributor name:');
                    if (!name?.trim()) return;
                    const role = prompt('Role (optional):');
                    const author = role?.trim()
                        ? { NameAndRole: { name: name.trim(), role: role.trim() } }
                        : { Name: name.trim() };
                    config.authors = [...(config.authors || []), author];
                    await api.writeTextFile(fullPath, JSON.stringify(config, null, 2));
                    showToast('success', `Added contributor: ${name.trim()}`);
                } catch {
                    showToast('error', 'Failed to add contributor');
                }
            },
            separator: true,
        });
    }

    if (onRename) {
        options.push({
            label: 'Rename',
            icon: getIcon('text'),
            onClick: () => onRename(node.path),
        });
    }

    options.push({
        label: 'Duplicate',
        icon: getIcon('file'),
        onClick: async () => {
            try {
                await api.duplicateFile(projectPath, node.path);
                await refreshFileTree();
                showToast('success', 'File duplicated');
            } catch (err) {
                const flintError = err as api.FlintError;
                showToast('error', flintError.getUserMessage?.() || 'Failed to duplicate');
            }
        },
    });

    if (ext === 'dds' || ext === 'tex') {
        options.push({
            label: 'Recolor',
            icon: getIcon('texture'),
            separator: true,
            onClick: () => openModal('recolor', { filePath: node.path, isFolder: false }),
        });
    }

    // ── Compare / Backup ──────────────────────────────────────────────
    // Only meaningful for files that came from a WAD — i.e. live under
    // `content/<name>.wad.client/...`. The Rust side will return a clean
    // "not in a WAD folder" error otherwise, but we hide the items entirely
    // to keep the menu short for things like mod.config.json or thumbnails.
    const normalizedRel = node.path.replace(/\\/g, '/');
    // Project layouts: `content/<wad>.wad.client/...` (legacy) or
    // `content/<layer>/<wad>.wad.client/...` (current — `base` is the default
    // layer). Accept any segment after `content/` ending in `.wad.client`.
    const isWadAsset =
        normalizedRel.startsWith('content/') &&
        normalizedRel.split('/').some(seg => seg.toLowerCase().endsWith('.wad.client'));

    if (isWadAsset) {
        // ── Compare ▸ submenu ──────────────────────────────────────────
        // Both compare actions live under one parent. Compare-with-backup
        // checks backup existence on click and toasts a helpful hint if
        // the backup hasn't been created yet.
        const compareSubmenu: ContextMenuOption[] = [
            {
                label: 'Original (from WAD)',
                icon: getIcon('code'),
                onClick: () => openModal('fileCompare', {
                    mode: 'original',
                    filePath: node.path,
                    fileName,
                }),
            },
            {
                label: 'Backup',
                icon: getIcon('file'),
                onClick: async () => {
                    try {
                        const exists = await api.hasFileBackup(projectPath, node.path);
                        if (!exists) {
                            showToast('warning', `No backup exists for ${fileName} — use Backup ▸ Create / Update first`);
                            return;
                        }
                        openModal('fileCompare', {
                            mode: 'backup',
                            filePath: node.path,
                            fileName,
                        });
                    } catch (err) {
                        const flintError = err as api.FlintError;
                        showToast('error', flintError.getUserMessage?.() || 'Failed to check backup');
                    }
                },
            },
        ];

        const restoreFromOriginal = async () => {
            if (!leaguePath) {
                showToast('error', 'League path is not set. Configure it in Settings (Ctrl+,) first.');
                return;
            }
            let meta: api.OriginalFileMeta;
            try {
                meta = await api.findOriginalFile(leaguePath, projectPath, node.path);
            } catch (err) {
                const flintError = err as api.FlintError;
                showToast('error', flintError.getUserMessage?.() || 'Failed to look up original');
                return;
            }
            if (!meta.found || !meta.wad_path || !meta.matched_hash) {
                const reason = !meta.wad_found
                    ? `Couldn't locate ${meta.queried_wad_name} in your League install.`
                    : `No matching chunk for "${fileName}" (or any close variant) in ${meta.queried_wad_name}.`;
                showToast('warning', `Original file not found — ${reason}`);
                return;
            }
            const matchNote = meta.exact
                ? ''
                : ` (matched "${meta.matched_internal_path}" — your file's path differs from the WAD path; this is normal for repathed projects)`;
            const message =
                `Overwrite "${fileName}" with the original from ${meta.queried_wad_name}?${matchNote}\n\n` +
                `A backup of the current file will be saved automatically before replacing.`;
            openConfirmDialog({
                title: 'Restore from Original',
                message,
                confirmLabel: 'Restore',
                onConfirm: async () => {
                    try {
                        try {
                            await api.createFileBackup(projectPath, node.path);
                        } catch (e) {
                            const m = (e as { message?: string })?.message ?? String(e);
                            showToast('error', `Aborting restore — couldn't create backup first: ${m}`);
                            return;
                        }
                        const bytes = await api.readWadChunkData(meta.wad_path!, meta.matched_hash!);
                        const absPath = `${projectPath.replace(/\\/g, '/')}/${node.path}`.replace(/\//g, '\\');
                        await api.saveFileBytes(absPath, bytes);
                        await refreshFileTree();
                        showToast('success', `Restored ${fileName} from original (previous version backed up)`);
                    } catch (err) {
                        const flintError = err as api.FlintError;
                        showToast('error', flintError.getUserMessage?.() || 'Failed to restore from original');
                    }
                },
            });
        };

        // ── Backup ▸ submenu ───────────────────────────────────────────
        // All backup lifecycle actions live here (Create, Restore, Delete).
        // Compare-with-backup intentionally lives under Compare ▸ instead so
        // both compare flavours are next to each other.
        const backupSubmenu: ContextMenuOption[] = [
            {
                label: 'Create / Update',
                icon: getIcon('file'),
                onClick: async () => {
                    try {
                        await api.createFileBackup(projectPath, node.path);
                        showToast('success', `Backed up ${fileName}`);
                    } catch (err) {
                        const flintError = err as api.FlintError;
                        showToast('error', flintError.getUserMessage?.() || 'Failed to create backup');
                    }
                },
            },
            {
                label: 'Restore from Backup',
                icon: getIcon('file'),
                onClick: async () => {
                    try {
                        const exists = await api.hasFileBackup(projectPath, node.path);
                        if (!exists) {
                            showToast('warning', `No backup exists for ${fileName} — Create / Update first`);
                            return;
                        }
                        openConfirmDialog({
                            title: 'Restore from Backup',
                            message: `Overwrite "${fileName}" with its backup? The current file's contents will be lost.`,
                            confirmLabel: 'Restore',
                            onConfirm: async () => {
                                try {
                                    const bytes = await api.readFileBackup(projectPath, node.path);
                                    const absPath = `${projectPath.replace(/\\/g, '/')}/${node.path}`.replace(/\//g, '\\');
                                    await api.saveFileBytes(absPath, bytes);
                                    await refreshFileTree();
                                    showToast('success', `Restored ${fileName} from backup`);
                                } catch (err) {
                                    const flintError = err as api.FlintError;
                                    showToast('error', flintError.getUserMessage?.() || 'Failed to restore from backup');
                                }
                            },
                        });
                    } catch (err) {
                        const flintError = err as api.FlintError;
                        showToast('error', flintError.getUserMessage?.() || 'Failed to check backup');
                    }
                },
            },
            {
                label: 'Delete Backup',
                icon: getIcon('trash'),
                danger: true,
                separator: true,
                onClick: async () => {
                    try {
                        const exists = await api.hasFileBackup(projectPath, node.path);
                        if (!exists) {
                            showToast('info', `No backup to delete for ${fileName}`);
                            return;
                        }
                        openConfirmDialog({
                            title: 'Delete Backup',
                            message: `Delete the backup for "${fileName}"? The current file isn't touched.`,
                            confirmLabel: 'Delete Backup',
                            danger: true,
                            onConfirm: async () => {
                                try {
                                    await api.deleteFileBackup(projectPath, node.path);
                                    showToast('success', 'Backup deleted');
                                } catch (err) {
                                    const flintError = err as api.FlintError;
                                    showToast('error', flintError.getUserMessage?.() || 'Failed to delete backup');
                                }
                            },
                        });
                    } catch (err) {
                        const flintError = err as api.FlintError;
                        showToast('error', flintError.getUserMessage?.() || 'Failed to check backup');
                    }
                },
            },
        ];

        options.push({
            label: 'Compare with…',
            icon: getIcon('code'),
            separator: true,
            submenu: compareSubmenu,
        });
        options.push({
            label: 'Restore from Original',
            icon: getIcon('file'),
            onClick: restoreFromOriginal,
        });
        options.push({
            label: 'Backup',
            icon: getIcon('file'),
            submenu: backupSubmenu,
        });
    }

    if (ext === 'bin' && !fileName.toLowerCase().includes('_concat')) {
        options.push({
            label: 'Split BIN by Class…',
            icon: getIcon('code'),
            separator: true,
            onClick: async () => {
                const defaultOutputName = await api.getVfxFilename(fullPath.replace(/\//g, '\\'));
                openModal('binSplit', {
                    binPath: fullPath.replace(/\//g, '\\'),
                    defaultOutputName,
                });
            },
        });
    }

    options.push({
        label: 'Copy',
        icon: getIcon('code'),
        separator: true,
        submenu: [
            {
                label: 'Absolute Path',
                icon: getIcon('code'),
                onClick: () => navigator.clipboard.writeText(fullPath.replace(/\//g, '\\')),
            },
            {
                label: 'Relative Path',
                icon: getIcon('code'),
                onClick: () => navigator.clipboard.writeText(node.path),
            },
            {
                label: 'File Name',
                icon: getIcon('file'),
                onClick: () => navigator.clipboard.writeText(fileName),
            },
        ],
    });

    // ── Open ▸ submenu — reveal in explorer + open with default app
    // collapsed into a single parent so the top-level menu stays compact.
    options.push({
        label: 'Open',
        icon: getIcon('folderOpen2'),
        submenu: [
            {
                label: 'Reveal in Explorer',
                icon: getIcon('folderOpen2'),
                onClick: () => api.openInExplorer(fullPath.replace(/\//g, '\\')).catch(() => { }),
            },
            {
                label: 'With Default App',
                icon: getIcon('file'),
                onClick: async () => {
                    try {
                        const normalizedPath = fullPath.replace(/\//g, '\\');
                        await api.openWithDefaultApp(normalizedPath);
                    } catch (err) {
                        const message = (err as Error).message || String(err);
                        showToast('error', `Failed to open file: ${message}`);
                    }
                },
            },
        ],
    });

    options.push({
        label: 'Delete',
        icon: getIcon('trash'),
        danger: true,
        separator: true,
        onClick: () => {
            openConfirmDialog({
                title: 'Delete File',
                message: `Are you sure you want to delete "${fileName}"? This cannot be undone.`,
                confirmLabel: 'Delete',
                danger: true,
                onConfirm: async () => {
                    try {
                        await api.deleteFile(projectPath, node.path);
                        await refreshFileTree();
                        showToast('success', 'File deleted');
                    } catch (err) {
                        const flintError = err as api.FlintError;
                        showToast('error', flintError.getUserMessage?.() || 'Failed to delete file');
                    }
                },
            });
        },
    });

    return options;
}
