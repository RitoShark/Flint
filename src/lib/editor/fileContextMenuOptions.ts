import * as api from '../api';
import { openThumbnailWindow } from '../api/thumbnail';
import { getIcon } from '../ui-helpers/fileIcons';
import { useNavigationStore } from '../stores/navigationStore';
import { useProjectTabStore } from '../stores/projectTabStore';
import { copyablePath } from '../wadPath';
import { isJadeAlias } from '../data/datadragon';
import type { ContextMenuOption, ModalType } from '../types';
import { t } from '../i18n';

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
            const tabs = useProjectTabStore.getState();
            const activeProject = tabs.openTabs.find(t => t.id === tabs.activeTabId)?.project ?? null;
            const activeProjectKind = activeProject?.kind ?? null;
            const isSkinProject = !!activeProject && (activeProjectKind ?? 'skin') === 'skin';
            options.push({
                label: t('contextMenu.project'),
                icon: getIcon('wrench'),
                separator: true,
                submenu: [
                    {
                        label: t('contextMenu.renameProject'),
                        icon: getIcon('text'),
                        onClick: () => openModal('renameProject', { projectPath }),
                    },
                    {
                        label: t('contextMenu.editProjectInfo'),
                        icon: getIcon('settings'),
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
                        label: t('contextMenu.setThumbnail'),
                        icon: getIcon('picture'),
                        onClick: () => openModal('thumbnail', { projectPath }),
                    },
                    {
                        label: t('contextMenu.addLayer'),
                        icon: getIcon('plus'),
                        separator: true,
                        onClick: () => openModal('addLayer'),
                    },
                    {
                        label: t('contextMenu.portToChromas'),
                        icon: getIcon('contrast'),
                        onClick: () => openModal('chromaPort'),
                    },
                    ...(isSkinProject && !isJadeAlias(activeProject!.champion) ? [{
                        label: t('contextMenu.portToJade'),
                        icon: getIcon('link'),
                        onClick: () => openModal('portToJade'),
                    }] : []),
                    ...(isSkinProject && activeProject!.skin_id === 0 ? [{
                        label: t('contextMenu.noSkinLite'),
                        icon: getIcon('copy'),
                        onClick: () => openModal('noSkinLite'),
                    }] : []),
                    {
                        label: t('contextMenu.addLoadscreenBanner'),
                        icon: getIcon('image'),
                        separator: true,
                        onClick: () => {
                            void (async () => {
                                try {
                                    const info = await api.getLoadscreenBannerInfo(projectPath);
                                    if (!info.loadscreen_exists) {
                                        showToast('error', 'This project has no loadscreen image to build a banner on.');
                                        return;
                                    }
                                    if (info.applied) {
                                        // Already on the skin — just edit the mask;
                                        // cancelling must not strip an existing banner.
                                        openModal('loadscreenBanner', { projectPath });
                                        return;
                                    }
                                    // Applying writes the BIN + mask up front so the
                                    // editor has something to paint on. Tell the modal,
                                    // so Cancel there rolls this back instead of
                                    // leaving the banner applied.
                                    const maskExistedBefore = info.mask_exists;
                                    await api.applyLoadscreenBanner(projectPath);
                                    await refreshFileTree();
                                    openModal('loadscreenBanner', {
                                        projectPath,
                                        appliedForThisSession: true,
                                        maskExistedBefore,
                                    });
                                } catch (e) {
                                    const fe = e as api.FlintError;
                                    showToast('error', fe.getUserMessage?.() || (e instanceof Error ? e.message : 'Failed to add loadscreen banner'));
                                }
                            })();
                        },
                    },
                    // Only loading-screen projects have the injected uibase to rebuild.
                    ...(activeProjectKind === 'loading-screen' ? [{
                        label: t('contextMenu.rebuildLoadscreen'),
                        icon: getIcon('refresh'),
                        onClick: () => {
                            if (!leaguePath) {
                                showToast('error', 'League path is required to rebuild the loadscreen.');
                                return;
                            }
                            void (async () => {
                                try {
                                    await api.rebuildLoadingScreenBin(projectPath, leaguePath);
                                    await refreshFileTree();
                                    showToast('success', 'Animated loadscreen rebuilt successfully.');
                                } catch (e) {
                                    const fe = e as api.FlintError;
                                    showToast('error', fe.getUserMessage?.() || (e instanceof Error ? e.message : 'Failed to rebuild loadscreen'));
                                }
                            })();
                        },
                    }] : []),
                ],
            });

            options.push({
                label: t('contextMenu.export'),
                icon: getIcon('export'),
                separator: true,
                submenu: [
                    {
                        label: t('contextMenu.exportModpkg'),
                        icon: getIcon('package'),
                        shortcut: t('export.recommended'),
                        onClick: () => openModal('export', { format: 'modpkg' }),
                    },
                    {
                        label: t('contextMenu.exportFantome'),
                        icon: getIcon('package'),
                        onClick: () => openModal('export', { format: 'fantome' }),
                    },
                ],
            });
        }

        if (isContentFolder(node.path)) {
            options.push({
                label: t('contextMenu.addLayer'),
                icon: getIcon('plus'),
                onClick: () => openModal('addLayer'),
            });
            options.push({
                label: t('contextMenu.batchRecolor'),
                icon: getIcon('contrast'),
                separator: true,
                onClick: () => openModal('recolor', { filePath: node.path, isFolder: true }),
            });
        } else {
            options.push({
                label: t('contextMenu.batchRecolor'),
                icon: getIcon('contrast'),
                onClick: () => openModal('recolor', { filePath: node.path, isFolder: true }),
            });
        }

        options.push({
            label: t('contextMenu.newFolder'),
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
                label: t('contextMenu.rename'),
                icon: getIcon('text'),
                onClick: () => onRename(node.path),
            });
        }

        if (fileName.toLowerCase() === 'data') {
            const binTools: ContextMenuOption[] = [];
            binTools.push({
                label: t('contextMenu.splitBins'),
                icon: getIcon('layerText'),
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
                label: t('contextMenu.organizeVfx'),
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
                            title: t('contextMenu.organizeVfx').replace(/…|\.\.\./g, ''),
                            message:
                                `Pull ${preview.vfx_objects_estimate} VFX object${preview.vfx_objects_estimate === 1 ? '' : 's'} into ` +
                                `data/${preview.vfx_filename} and merge ${preview.main_objects_estimate} non-VFX object${preview.main_objects_estimate === 1 ? '' : 's'} ` +
                                `into the main BIN (${ownerRel}). ${deletedEstimate}. Continue?`,
                            confirmLabel: t('common.apply'),
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
                label: t('contextMenu.binTools'),
                icon: getIcon('wrench'),
                separator: true,
                submenu: binTools,
            });
        }

        // The audit walks a whole unpacked WAD tree, so it only makes sense on the
        // `.wad.client` folder itself — a subfolder would report everything outside
        // it as missing.
        if (node.name.toLowerCase().endsWith('.wad.client')) {
            const openAudit = (tab: 'missing' | 'bloat') =>
                openModal('wadAudit', {
                    folderPath: fullPath.replace(/\//g, '\\'),
                    folderName: node.name,
                    tab,
                });
            options.push({
                label: t('contextMenu.checkFiles'),
                icon: getIcon('search'),
                separator: true,
                submenu: [
                    {
                        label: t('contextMenu.missingFiles'),
                        icon: getIcon('warning'),
                        onClick: () => openAudit('missing'),
                    },
                    {
                        label: t('contextMenu.bloatFiles'),
                        icon: getIcon('trash'),
                        onClick: () => openAudit('bloat'),
                    },
                ],
            });
        }

        options.push({
            label: t('contextMenu.copy'),
            icon: getIcon('copy'),
            separator: true,
            submenu: [
                {
                    label: t('contextMenu.absolutePath'),
                    icon: getIcon('link'),
                    onClick: () => navigator.clipboard.writeText(fullPath.replace(/\//g, '\\')),
                },
                {
                    label: t('contextMenu.relativePath'),
                    icon: getIcon('link'),
                    onClick: () => navigator.clipboard.writeText(copyablePath(node.path)),
                },
                {
                    label: t('contextMenu.folderName'),
                    icon: getIcon('folder'),
                    onClick: () => navigator.clipboard.writeText(fileName),
                },
            ],
        });

        options.push({
            label: t('contextMenu.revealInExplorer'),
            icon: getIcon('folderOpen2'),
            onClick: () => api.openInExplorer(fullPath.replace(/\//g, '\\')).catch(() => { }),
        });

        options.push({
            label: t('contextMenu.delete'),
            icon: getIcon('trash'),
            danger: true,
            separator: true,
            onClick: () => {
                openConfirmDialog({
                    title: t('contextMenu.deleteFolderTitle'),
                    message: t('contextMenu.deleteFolderMsg', { name: fileName }),
                    confirmLabel: t('common.delete'),
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
            label: t('contextMenu.editProjectInfo'),
            icon: getIcon('settings'),
            onClick: () => {
                useNavigationStore.getState().navigateToFileEditor({
                    filePath: fullPath,
                    kind: 'modConfig',
                    projectPath,
                });
            },
        });
        options.push({
            label: t('contextMenu.addContributor'),
            icon: getIcon('user'),
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
        const BIN_TEXT_EXTS = ['.bin', '.ritobin', '.py'];
        const LUA_BIN_EXTS = ['.luabin', '.luabin64'];
        const lowerName = fileName.toLowerCase();
        const isBinText = BIN_TEXT_EXTS.some(e => lowerName.endsWith(e));
        const isTroybin = lowerName.endsWith('.troybin');
        const isLuaBin = LUA_BIN_EXTS.some(e => lowerName.endsWith(e));
        const isRawText = ['.json', '.txt', '.lua', '.py'].some(e => lowerName.endsWith(e));

        if (isBinText) {
            options.push({
                label: t('contextMenu.editBin'),
                icon: getIcon('bin'),
                onClick: () => {
                    useNavigationStore.getState().navigateToFileEditor({
                        filePath: fullPath,
                        kind: 'binText',
                        projectPath,
                    });
                },
            });
        } else if (isTroybin) {
            // .troybin is a binary League config (read-only viewer), NOT ritobin text.
            options.push({
                label: t('contextMenu.viewTroybin'),
                icon: getIcon('config'),
                onClick: () => {
                    useNavigationStore.getState().navigateToFileEditor({
                        filePath: fullPath,
                        kind: 'troybin',
                        projectPath,
                    });
                },
            });
        } else if (isLuaBin) {
            options.push({
                label: t('contextMenu.editLuaBin'),
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
                label: t('contextMenu.editFile'),
                icon: getIcon('text'),
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
            label: t('contextMenu.rename'),
            icon: getIcon('text'),
            onClick: () => onRename(node.path),
        });
    }

    options.push({
        label: t('contextMenu.duplicate'),
        icon: getIcon('copy'),
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

    // PNG joins the texture block for the converters only — Recolor and the mask
    // editor below still operate on real textures.
    if (ext === 'dds' || ext === 'tex' || ext === 'png') {
        if (projectPath && fileName.toLowerCase().endsWith('-mask.tex')) {
            options.push({
                label: 'Edit Loadscreen Banner Mask',
                icon: getIcon('image'),
                separator: true,
                onClick: () => openModal('loadscreenBanner', { projectPath, maskPath: fullPath }),
            });
        }

        if (ext !== 'png') {
            options.push({
                label: t('contextMenu.recolor'),
                icon: getIcon('contrast'),
                separator: true,
                onClick: () => openModal('recolor', { filePath: node.path, isFolder: false }),
            });
        }

        const transformItems: ContextMenuOption[] = [];

        if (ext === 'tex') {
            transformItems.push({
                label: t('contextMenu.convertToDds'),
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
                label: t('contextMenu.convertToTex'),
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

        // The reverse direction: a PNG edited outside Flint goes straight back
        // into a game-ready texture without a round-trip through another tool.
        if (ext === 'png') {
            const convertPng = (
                label: string,
                run: (p: string) => Promise<api.TextureConversionResult>,
            ): ContextMenuOption => ({
                label,
                icon: getIcon('texture'),
                onClick: async () => {
                    try {
                        const result = await run(fullPath.replace(/\//g, '\\'));
                        showToast('success', `Wrote ${result.format} — ${result.width}×${result.height}`);
                        await refreshFileTree();
                    } catch (err) {
                        const flintError = err as api.FlintError;
                        showToast('error', flintError.getUserMessage?.() || 'Conversion failed');
                    }
                },
            });
            // No format argument: BC3 when the image has alpha, BC1 when it does not.
            transformItems.push(convertPng(t('contextMenu.convertToTex'), (p) => api.convertPngToTex(p)));
            transformItems.push(convertPng(t('contextMenu.convertToDds'), (p) => api.convertPngToDds(p)));
        }

        if (ext !== 'png') transformItems.push({
            label: t('contextMenu.exportPng'),
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
            label: t('contextMenu.fileTransform'),
            icon: getIcon('wrench'),
            submenu: transformItems,
        });
    }

    if (ext === 'skn') {
        options.push({
            label: t('contextMenu.createThumbnail'),
            icon: getIcon('picture'),
            separator: true,
            onClick: () => openThumbnailWindow(projectPath, fullPath.replace(/\//g, '\\')),
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
                label: t('contextMenu.compareOriginal'),
                icon: getIcon('wad'),
                onClick: () => openModal('fileCompare', {
                    mode: 'original',
                    filePath: node.path,
                    fileName,
                }),
            },
            {
                label: t('contextMenu.compareBackup'),
                icon: getIcon('history'),
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
                title: t('contextMenu.restoreOriginal'),
                message,
                confirmLabel: t('common.restore') || 'Restore',
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
                label: t('contextMenu.backupCreate'),
                icon: getIcon('save'),
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
                label: t('contextMenu.backupRestore'),
                icon: getIcon('import'),
                onClick: async () => {
                    try {
                        const exists = await api.hasFileBackup(projectPath, node.path);
                        if (!exists) {
                            showToast('warning', `No backup exists for ${fileName} — Create / Update first`);
                            return;
                        }
                        openConfirmDialog({
                            title: t('contextMenu.backupRestore'),
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
                label: t('contextMenu.backupDelete'),
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
                            title: t('contextMenu.backupDelete'),
                            message: `Delete the backup for "${fileName}"? The current file isn't touched.`,
                            confirmLabel: t('contextMenu.backupDelete'),
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
            label: t('contextMenu.compareWith'),
            icon: getIcon('git'),
            separator: true,
            submenu: compareSubmenu,
        });
        options.push({
            label: t('contextMenu.restoreOriginal'),
            icon: getIcon('import'),
            onClick: restoreFromOriginal,
        });
        options.push({
            label: t('contextMenu.backup'),
            icon: getIcon('history'),
            submenu: backupSubmenu,
        });
    }

    if (ext === 'bin' && !fileName.toLowerCase().includes('_concat')) {
        options.push({
            label: t('contextMenu.splitBin'),
            icon: getIcon('layerText'),
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
        label: t('contextMenu.copy'),
        icon: getIcon('copy'),
        separator: true,
        submenu: [
            {
                label: t('contextMenu.absolutePath'),
                icon: getIcon('link'),
                onClick: () => navigator.clipboard.writeText(fullPath.replace(/\//g, '\\')),
            },
            {
                label: t('contextMenu.relativePath'),
                icon: getIcon('link'),
                onClick: () => navigator.clipboard.writeText(copyablePath(node.path)),
            },
            {
                label: t('contextMenu.fileName'),
                icon: getIcon('file'),
                onClick: () => navigator.clipboard.writeText(fileName),
            },
        ],
    });

    options.push({
        label: t('contextMenu.open'),
        icon: getIcon('export'),
        submenu: [
            {
                label: t('contextMenu.revealInExplorer'),
                icon: getIcon('folderOpen2'),
                onClick: () => api.openInExplorer(fullPath.replace(/\//g, '\\')).catch(() => { }),
            },
            {
                label: t('contextMenu.openDefaultApp'),
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
        label: t('contextMenu.delete'),
        icon: getIcon('trash'),
        danger: true,
        separator: true,
        onClick: () => {
            openConfirmDialog({
                title: t('contextMenu.deleteFileTitle'),
                message: t('contextMenu.deleteFileMsg', { name: fileName }),
                confirmLabel: t('common.delete'),
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
