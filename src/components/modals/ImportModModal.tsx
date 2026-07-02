import React, { useState, useEffect, useCallback, useRef } from 'react';
import { listen } from '@tauri-apps/api/event';
import { open as openDialog } from '@tauri-apps/plugin-dialog';
import {
    useModalStore,
    useConfigStore,
    useNotificationStore,
    useProjectTabStore,
    useNavigationStore,
} from '../../lib/stores';
import * as api from '../../lib/api';
import type { FantomeAnalysis, ModpkgAnalysis, ImportOptions } from '../../lib/api/import';
import {
    Button,
    Field,
    FormGroup,
    FormLabel,
    Input,
    Select,
    Checkbox,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    ProgressBar,
    Spinner,
} from '../ui';

type ArchiveKind = 'fantome' | 'modpkg';
type Step = 'select' | 'analyzing' | 'config' | 'progress' | 'complete' | 'error';

/** Unified view over the two analysis shapes so the UI can stay format-agnostic. */
interface UnifiedAnalysis {
    champion: string | null;
    skinIds: number[];
    fileCount: number;
    filePaths: string[];
    name: string | null;
    author: string | null;
    description: string | null;
    version: string | null;
}

function detectKind(path: string): ArchiveKind | null {
    const lower = path.toLowerCase();
    if (lower.endsWith('.fantome')) return 'fantome';
    if (lower.endsWith('.modpkg')) return 'modpkg';
    return null;
}

function unifyFantome(a: FantomeAnalysis): UnifiedAnalysis {
    return {
        champion: a.champion,
        skinIds: a.skin_ids,
        fileCount: a.file_count,
        filePaths: a.file_paths,
        name: a.metadata?.name ?? null,
        author: a.metadata?.author ?? null,
        description: a.metadata?.description ?? null,
        version: a.metadata?.version ?? null,
    };
}

function unifyModpkg(a: ModpkgAnalysis): UnifiedAnalysis {
    return {
        champion: a.champion,
        skinIds: a.skin_ids,
        fileCount: a.file_count,
        filePaths: a.file_paths,
        name: a.display_name ?? a.name,
        author: a.authors[0] ?? null,
        description: a.description,
        version: a.version,
    };
}

/** Slugify a project name into a safe folder name. */
function toFolderName(name: string): string {
    return (
        name
            .trim()
            .replace(/[^a-zA-Z0-9._-]+/g, '-')
            .replace(/^-+|-+$/g, '')
            .toLowerCase() || 'imported-mod'
    );
}

function joinPath(dir: string, child: string): string {
    return `${dir.replace(/[\\/]+$/, '')}/${child}`;
}

export const ImportModModal: React.FC = () => {
    const activeModal = useModalStore((s) => s.activeModal);
    const modalOptions = useModalStore((s) => s.modalOptions);
    const closeModal = useModalStore((s) => s.closeModal);
    const showToast = useNotificationStore((s) => s.showToast);

    const configCreator = useConfigStore((s) => s.creatorName);
    const defaultProjectPath = useConfigStore((s) => s.defaultProjectPath);
    const leaguePath = useConfigStore((s) => s.leaguePath);

    const isVisible = activeModal === 'importMod';
    const options = modalOptions as { filePath?: string } | null;

    const [step, setStep] = useState<Step>('select');
    const [filePath, setFilePath] = useState<string | null>(null);
    const [kind, setKind] = useState<ArchiveKind | null>(null);
    const [analysis, setAnalysis] = useState<UnifiedAnalysis | null>(null);

    // Config fields
    const [projectName, setProjectName] = useState('');
    const [creatorName, setCreatorName] = useState('');
    const [champion, setChampion] = useState('');
    const [targetSkinId, setTargetSkinId] = useState<number>(0);
    const [outputDir, setOutputDir] = useState('');
    const [refather, setRefather] = useState(true);
    const [matchFromLeague, setMatchFromLeague] = useState(true);
    const [cleanupUnused, setCleanupUnused] = useState(false);

    // Progress / result
    const [progressMsg, setProgressMsg] = useState('');
    const [errorMsg, setErrorMsg] = useState('');
    const [createdProjectDir, setCreatedProjectDir] = useState<string | null>(null);

    const importingRef = useRef(false);

    const resetState = useCallback(() => {
        setStep('select');
        setFilePath(null);
        setKind(null);
        setAnalysis(null);
        setProjectName('');
        setCreatorName('');
        setChampion('');
        setTargetSkinId(0);
        setOutputDir('');
        setRefather(true);
        setMatchFromLeague(true);
        setCleanupUnused(false);
        setProgressMsg('');
        setErrorMsg('');
        setCreatedProjectDir(null);
        importingRef.current = false;
    }, []);

    const runAnalysis = useCallback(
        async (path: string) => {
            const detected = detectKind(path);
            if (!detected) {
                setErrorMsg('Unsupported file type. Pick a .fantome or .modpkg file.');
                setStep('error');
                return;
            }
            setFilePath(path);
            setKind(detected);
            setStep('analyzing');
            try {
                const unified =
                    detected === 'fantome'
                        ? unifyFantome(await api.analyzeFantome(path))
                        : unifyModpkg(await api.analyzeModpkg(path));
                setAnalysis(unified);
                setProjectName(unified.name ?? 'Imported Mod');
                setCreatorName(unified.author ?? configCreator ?? '');
                setChampion(unified.champion ?? '');
                setTargetSkinId(unified.skinIds[0] ?? 0);
                setOutputDir(defaultProjectPath ?? '');
                setStep('config');
            } catch (err) {
                console.error('Failed to analyze archive:', err);
                setErrorMsg(
                    (err as api.FlintError)?.getUserMessage?.() ?? 'Failed to analyze the archive.',
                );
                setStep('error');
            }
        },
        [configCreator, defaultProjectPath],
    );

    // When opened, reset and (if pre-loaded via file association) auto-analyze.
    useEffect(() => {
        if (!isVisible) return;
        resetState();
        if (options?.filePath) {
            void runAnalysis(options.filePath);
        }
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVisible, options?.filePath]);

    // Listen to backend import progress for whichever format is active.
    useEffect(() => {
        if (!isVisible || step !== 'progress' || !kind) return;
        const eventName = kind === 'fantome' ? 'fantome-import-progress' : 'modpkg-import-progress';
        const unlisten = listen<{ status: string; message: string }>(eventName, (event) => {
            const m = event.payload?.message;
            if (typeof m === 'string' && m.length > 0) setProgressMsg(m);
        });
        return () => {
            unlisten.then((fn) => fn()).catch(() => {});
        };
    }, [isVisible, step, kind]);

    const handlePickFile = useCallback(async () => {
        const selected = await openDialog({
            title: 'Select a mod package to import',
            directory: false,
            filters: [{ name: 'Mod Package', extensions: ['fantome', 'modpkg'] }],
        });
        if (typeof selected === 'string') void runAnalysis(selected);
    }, [runAnalysis]);

    const handleBrowseOutput = useCallback(async () => {
        const selected = await openDialog({
            title: 'Select output directory',
            directory: true,
            defaultPath: outputDir || undefined,
        });
        if (typeof selected === 'string') setOutputDir(selected);
    }, [outputDir]);

    const handleImport = useCallback(async () => {
        if (!filePath || !kind || importingRef.current) return;
        if (!projectName.trim()) {
            showToast('error', 'Project name is required');
            return;
        }
        if (!outputDir.trim()) {
            showToast('error', 'Choose an output directory');
            return;
        }
        const projectDir = joinPath(outputDir, toFolderName(projectName));
        const importOptions: ImportOptions = {
            refather,
            creator_name: creatorName.trim() || null,
            project_name: projectName.trim() || null,
            champion: champion.trim() || null,
            target_skin_id: targetSkinId,
            cleanup_unused: cleanupUnused,
            match_from_league: matchFromLeague,
            league_path: matchFromLeague ? leaguePath : null,
        };

        importingRef.current = true;
        setProgressMsg('Starting import…');
        setStep('progress');
        try {
            if (kind === 'fantome') {
                await api.importFantomeWad(filePath, projectDir, importOptions);
            } else {
                await api.importModpkg(filePath, projectDir, importOptions);
            }
            setCreatedProjectDir(projectDir);
            setStep('complete');
        } catch (err) {
            console.error('Import failed:', err);
            setErrorMsg(
                (err as api.FlintError)?.getUserMessage?.() ?? 'Import failed. See logs for details.',
            );
            setStep('error');
        } finally {
            importingRef.current = false;
        }
    }, [
        filePath,
        kind,
        projectName,
        outputDir,
        refather,
        creatorName,
        targetSkinId,
        cleanupUnused,
        matchFromLeague,
        leaguePath,
        showToast,
    ]);

    const handleOpenProject = useCallback(async () => {
        if (!createdProjectDir) return;
        try {
            const { project, fileTree } = await api.openProjectWithTree(createdProjectDir);
            useProjectTabStore.getState().addTab(project, createdProjectDir);
            const tabId = useProjectTabStore.getState().activeTabId;
            if (tabId) useProjectTabStore.getState().setFileTree(tabId, fileTree);
            useConfigStore.getState().addSavedProject({
                id: `proj-${Date.now()}`,
                name: project.display_name || project.name,
                kind: project.kind ?? 'skin',
                champion: project.champion,
                mapId: project.map_id ?? null,
                path: createdProjectDir,
                lastOpened: new Date().toISOString(),
            });
            useNavigationStore.getState().setView('preview');
            closeModal();
        } catch (err) {
            console.error('Failed to open imported project:', err);
            showToast('error', 'Imported, but failed to open the project');
        }
    }, [createdProjectDir, closeModal, showToast]);

    const previewPaths = analysis?.filePaths.slice(0, 50) ?? [];

    return (
        <Modal open={isVisible} onClose={closeModal} size="large">
            <ModalHeader title="Import Mod Package" onClose={closeModal} />

            <ModalBody className="import-mod">
                {step === 'select' && (
                    <div className="import-mod__dropzone" onClick={handlePickFile}>
                        <div className="import-mod__dropzone-icon">📦</div>
                        <div className="import-mod__dropzone-title">Choose a mod package</div>
                        <div className="import-mod__dropzone-hint">
                            Select a <code>.fantome</code> or <code>.modpkg</code> file to import into a Flint project
                        </div>
                        <Button variant="primary">Browse…</Button>
                    </div>
                )}

                {step === 'analyzing' && (
                    <div className="import-mod__centered">
                        <Spinner size="lg" />
                        <div className="import-mod__centered-text">Analyzing archive…</div>
                    </div>
                )}

                {step === 'config' && analysis && (
                    <div className="import-mod__config">
                        <div className="import-mod__summary">
                            <div className="import-mod__summary-grid">
                                <span>Format</span>
                                <strong>{kind === 'fantome' ? 'Fantome' : 'ModPkg'}</strong>
                                <span>Champion</span>
                                <strong>{analysis.champion ?? 'Unknown'}</strong>
                                <span>Skins detected</span>
                                <strong>{analysis.skinIds.length > 0 ? analysis.skinIds.join(', ') : 'None'}</strong>
                                <span>Files</span>
                                <strong>{analysis.fileCount}</strong>
                                {analysis.version && (
                                    <>
                                        <span>Version</span>
                                        <strong>{analysis.version}</strong>
                                    </>
                                )}
                            </div>
                        </div>

                        <Field
                            label="Project Name"
                            value={projectName}
                            onChange={(e) => setProjectName(e.target.value)}
                            placeholder="My Awesome Mod"
                        />
                        <Field
                            label="Creator Name"
                            value={creatorName}
                            onChange={(e) => setCreatorName(e.target.value)}
                            placeholder="Your name"
                        />
                        <FormGroup>
                            <FormLabel>Champion</FormLabel>
                            <Input
                                value={champion}
                                onChange={(e) => setChampion(e.target.value)}
                                placeholder="e.g. ambessa"
                            />
                        </FormGroup>

                        <FormGroup>
                            <FormLabel>Target Skin ID</FormLabel>
                            {analysis.skinIds.length > 1 ? (
                                <Select
                                    value={String(targetSkinId)}
                                    onChange={(e) => setTargetSkinId(Number(e.target.value))}
                                >
                                    {analysis.skinIds.map((id) => (
                                        <option key={id} value={id}>
                                            Skin {id}
                                        </option>
                                    ))}
                                </Select>
                            ) : (
                                <Input
                                    type="number"
                                    value={String(targetSkinId)}
                                    onChange={(e) => setTargetSkinId(Number(e.target.value) || 0)}
                                />
                            )}
                        </FormGroup>

                        <FormGroup>
                            <FormLabel>Output Directory</FormLabel>
                            <div style={{ display: 'flex', gap: 6 }}>
                                <Input
                                    value={outputDir}
                                    onChange={(e) => setOutputDir(e.target.value)}
                                    placeholder="Where the project folder will be created"
                                    style={{ flex: 1 }}
                                />
                                <Button variant="secondary" onClick={handleBrowseOutput}>
                                    Browse…
                                </Button>
                            </div>
                        </FormGroup>

                        <div className="import-mod__options">
                            <Checkbox
                                checked={refather}
                                onChange={(e) => setRefather(e.target.checked)}
                                label="Refather (organize & repath assets) — recommended"
                            />
                            <Checkbox
                                checked={matchFromLeague}
                                onChange={(e) => setMatchFromLeague(e.target.checked)}
                                label="Recover missing files from the League installation"
                            />
                            <Checkbox
                                checked={cleanupUnused}
                                onChange={(e) => setCleanupUnused(e.target.checked)}
                                label="Clean up unused files"
                            />
                        </div>

                        {matchFromLeague && !leaguePath && (
                            <div className="import-mod__warning">
                                No League path configured — missing-file recovery will be skipped. Set it in Settings.
                            </div>
                        )}

                        {previewPaths.length > 0 && (
                            <details className="import-mod__paths">
                                <summary>Preview files ({analysis.fileCount})</summary>
                                <ul>
                                    {previewPaths.map((p) => (
                                        <li key={p}>{p}</li>
                                    ))}
                                    {analysis.fileCount > previewPaths.length && (
                                        <li className="import-mod__paths-more">
                                            …and {analysis.fileCount - previewPaths.length} more
                                        </li>
                                    )}
                                </ul>
                            </details>
                        )}
                    </div>
                )}

                {step === 'progress' && (
                    <div className="import-mod__centered">
                        <ProgressBar value={100} className="import-mod__progress-indeterminate" />
                        <div className="import-mod__centered-text">{progressMsg || 'Importing…'}</div>
                    </div>
                )}

                {step === 'complete' && (
                    <div className="import-mod__centered">
                        <div className="import-mod__success-icon">✓</div>
                        <div className="import-mod__centered-text">Import complete!</div>
                        <div className="import-mod__centered-sub">
                            {analysis?.fileCount ?? 0} files imported into <code>{projectName}</code>
                        </div>
                    </div>
                )}

                {step === 'error' && (
                    <div className="import-mod__centered">
                        <div className="import-mod__error-icon">!</div>
                        <div className="import-mod__centered-text">Something went wrong</div>
                        <div className="import-mod__centered-sub import-mod__error-text">{errorMsg}</div>
                    </div>
                )}
            </ModalBody>

            <ModalFooter>
                {step === 'config' && (
                    <>
                        <Button variant="secondary" onClick={closeModal}>
                            Cancel
                        </Button>
                        <Button variant="primary" onClick={handleImport}>
                            Import
                        </Button>
                    </>
                )}
                {step === 'complete' && (
                    <>
                        <Button variant="secondary" onClick={closeModal}>
                            Close
                        </Button>
                        <Button variant="primary" onClick={handleOpenProject}>
                            Open Project
                        </Button>
                    </>
                )}
                {step === 'error' && (
                    <>
                        <Button variant="secondary" onClick={closeModal}>
                            Close
                        </Button>
                        <Button
                            variant="primary"
                            onClick={() => (filePath ? void runAnalysis(filePath) : setStep('select'))}
                        >
                            Retry
                        </Button>
                    </>
                )}
                {(step === 'select' || step === 'analyzing' || step === 'progress') && (
                    <Button variant="secondary" onClick={closeModal} disabled={step === 'progress'}>
                        Cancel
                    </Button>
                )}
            </ModalFooter>
        </Modal>
    );
};
