import * as api from '../api';
import { getIcon } from '../ui-helpers/fileIcons';
import { useNavigationStore } from '../stores/navigationStore';
import type { ContextMenuOption, ModalType } from '../types';

interface BuildOptionsArgs {
    node: { path: string; name: string; isDirectory: boolean };
    projectPath: string;
    /** Tree depth — used to show root-only options like "Set Thumbnail". */
    depth: number;
    refreshFileTree: () => Promise<void>;
    openModal: (modal: ModalType, options?: Record<string, unknown>) => void;
    openConfirmDialog: (dialog: {
        title: string;
        message: string;
        confirmLabel?: string;
        danger?: boolean;
        onConfirm: () => void;
    }) => void;
    showToast: (type: 'info' | 'success' | 'warning' | 'error', message: string) => void;
    /** When present, the menu shows "Rename"; grid views can omit it. */
    onRename?: (path: string) => void;
    /** Needed by "Restore from Original"; when omitted, the action toasts a hint. */
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
            options.push({
                label: 'Project',
                icon: getIcon('code'),
                separator: true,
                submenu: [
                    {
                        label: 'Rename Project…',
                        icon: getIcon('text'),
                        onClick: () => openModal('renameProject', { projectPath }),
                    },
                    {
                        label: 'Edit Project Info',
                        icon: getIcon('code'),
                        onClick: () => {
                            const configPath = `${projectPath.replace(/\\/g, '/')}/mod.config.json`;
                            useNavigationStore.getState().navigateToFileEditor({
                                filePath: configPath,
                                kind: 'modConfig',
                                projectPath,
                            });
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
                    {
                        label: 'Add Animated Loadscreen Banner',
                        icon: getIcon('picture'),
                        separator: true,
                        onClick: () => {
                            void (async () => {
                                try {
                                    const info = await api.getLoadscreenBannerInfo(projectPath);
                                    if (!info.loadscreen_exists) {
                                        showToast('error', 'This project has no loadscreen image to build a banner on.');
                                        return;
                                    }
                                    const open = () => openModal('loadscreenBanner', { projectPath });
                                    if (info.applied) {
                                        open();
                                        return;
                                    }
                                    await api.applyLoadscreenBanner(projectPath);
                                    await refreshFileTree();
                                    open();
                                } catch (e) {
                                    const fe = e as api.FlintError;
                                    showToast('error', fe.getUserMessage?.() || (e instanceof Error ? e.message : 'Failed to add loadscreen banner'));
                                }
                            })();
                        },
                    },
                ],
            });

            options.push({
                label: 'Export',
                icon: getIcon('package'),
                separator: true,
                submenu: [
                    {
                        label: 'Export as .fantome',
                        icon: getIcon('package'),
                        onClick: () => openModal('export', { format: 'fantome' }),
                    },
                    {
                        label: 'Export as .modpkg',
                        icon: getIcon('package'),
                        onClick: () => openModal('export', { format: 'modpkg' }),
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
            onClick: () => {
                useNavigationStore.getState().navigateToFileEditor({
                    filePath: fullPath,
                    kind: 'modConfig',
                    projectPath,
                });
            },
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
    } else {
        const BIN_TEXT_EXTS = ['.bin', '.ritobin', '.py', '.troybin'];
        const LUA_BIN_EXTS = ['.luabin', '.luabin64'];
        const isBinText = BIN_TEXT_EXTS.some(e => fileName.toLowerCase().endsWith(e));
        const isLuaBin = LUA_BIN_EXTS.some(e => fileName.toLowerCase().endsWith(e));
        const isRawText = ['.json', '.txt', '.lua', '.py'].some(e => fileName.toLowerCase().endsWith(e));

        if (isBinText) {
            options.push({
                label: 'Edit BIN',
                icon: getIcon('code'),
                onClick: () => {
                    useNavigationStore.getState().navigateToFileEditor({
                        filePath: fullPath,
                        kind: 'binText',
                        projectPath,
                    });
                },
            });
        } else if (isLuaBin) {
            options.push({
                label: 'Edit LuaBin64',
                icon: getIcon('code'),
                onClick: () => {
                    useNavigationStore.getState().navigateToFileEditor({
                        filePath: fullPath,
                        kind: 'luaBin64',
                        projectPath,
                    });
                },
            });
        } else if (isRawText) {
            options.push({
                label: 'Edit File',
                icon: getIcon('code'),
                onClick: () => {
                    useNavigationStore.getState().navigateToFileEditor({
                        filePath: fullPath,
                        kind: 'raw',
                        projectPath,
                    });
                },
            });
        }
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
        if (projectPath && fileName.toLowerCase().endsWith('-mask.tex')) {
            options.push({
                label: 'Edit Loadscreen Banner Mask',
                icon: getIcon('picture'),
                separator: true,
                onClick: () => openModal('loadscreenBanner', { projectPath, maskPath: fullPath }),
            });
        }

        options.push({
            label: 'Recolor',
            icon: getIcon('texture'),
            separator: true,
            onClick: () => openModal('recolor', { filePath: node.path, isFolder: false }),
        });

        const transformItems: ContextMenuOption[] = [];

        if (ext === 'tex') {
            transformItems.push({
                label: 'Convert to .dds',
                icon: getIcon('texture'),
                onClick: async () => {
                    try {
                        const result = await api.convertTexToDds(fullPath.replace(/\//g, '\\'));
                        showToast('success', `Wrote ${result.format} — ${result.width}×${result.height}`);
                        await refreshFileTree();
                    } catch (err) {
                        const flintError = err as api.FlintError;
                        showToast('error', flintError.getUserMessage?.() || 'Conversion failed');
                    }
                },
            });
        }
        if (ext === 'dds') {
            transformItems.push({
                label: 'Convert to .tex',
                icon: getIcon('texture'),
                onClick: async () => {
                    try {
                        const result = await api.convertDdsToTex(fullPath.replace(/\//g, '\\'));
                        showToast('success', `Wrote ${result.format} — ${result.width}×${result.height}`);
                        await refreshFileTree();
                    } catch (err) {
                        const flintError = err as api.FlintError;
                        showToast('error', flintError.getUserMessage?.() || 'Conversion failed');
                    }
                },
            });
        }

        transformItems.push({
            label: 'Export as .png',
            icon: getIcon('picture'),
            onClick: async () => {
                try {
                    const result = await api.convertTextureToPng(fullPath.replace(/\//g, '\\'));
                    showToast('success', `Wrote PNG — ${result.width}×${result.height}`);
                    await refreshFileTree();
                } catch (err) {
                    const flintError = err as api.FlintError;
                    showToast('error', flintError.getUserMessage?.() || 'PNG export failed');
                }
            },
        });

        options.push({
            label: 'File Transformation',
            icon: getIcon('code'),
            submenu: transformItems,
        });
    }

    // ── Compare / Backup ──────────────────────────────────────────────
    const normalizedRel = node.path.replace(/\\/g, '/');
    const isWadAsset =
        normalizedRel.startsWith('content/') &&
        normalizedRel.split('/').some(seg => seg.toLowerCase().endsWith('.wad.client'));

    if (isWadAsset) {
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
