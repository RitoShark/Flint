import React, { useState, useCallback, useEffect } from 'react';
import { useModalStore, useNotificationStore, useProjectTabStore, useConfigStore } from '../../lib/stores';
import * as api from '../../lib/api';
import { open } from '@tauri-apps/plugin-dialog';
import { appDataDir } from '@tauri-apps/api/path';
import { Button, Checkbox, FormGroup, FormLabel, Icon, Input, Modal, ModalBody, ModalFooter, ModalHeader, Spinner } from '../ui';
import type {
    ProjectAnalysis,
    ProjectFixResult,
    BatchFixResult,
    DetectedIssue,
    RecentProject,
    FixConfig,
} from '../../lib/types';

type FixerTab = 'single' | 'batch';
type FixerPhase = 'idle' | 'loading-config' | 'scanning' | 'results' | 'fixing' | 'done';

/** Get the default Flint projects directory: {AppData}/RitoShark/Flint/Projects */
async function getProjectsBasePath(): Promise<string | undefined> {
    try {
        const dir = await appDataDir();
        const parts = dir.replace(/\\/g, '/').split('/');
        parts.pop();
        return `${parts.join('/')}/RitoShark/Flint/Projects`;
    } catch {
        return undefined;
    }
}

export const FixerModal: React.FC = () => {
    const closeModal = useModalStore((s) => s.closeModal);
    const activeModal = useModalStore((s) => s.activeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const activeTabId = useProjectTabStore((s) => s.activeTabId);
    const openTabs = useProjectTabStore((s) => s.openTabs);
    const recentProjects = useConfigStore((s) => s.recentProjects);
    const savedProjects = useConfigStore((s) => s.savedProjects);

    const isVisible = activeModal === 'fixer';

    const [tab, setTab] = useState<FixerTab>('single');

    const [config, setConfig] = useState<FixConfig | null>(null);

    const [projectPath, setProjectPath] = useState('');
    const [analysis, setAnalysis] = useState<ProjectAnalysis | null>(null);
    const [fixResult, setFixResult] = useState<ProjectFixResult | null>(null);
    const [selectedFixes, setSelectedFixes] = useState<Set<string>>(new Set());

    const [batchPaths, setBatchPaths] = useState<string[]>([]);
    const [batchResult, setBatchResult] = useState<BatchFixResult | null>(null);

    const [phase, setPhase] = useState<FixerPhase>('idle');
    const [statusMessage, setStatusMessage] = useState('');

    useEffect(() => {
        if (isVisible) {
            const activeTab = openTabs.find(t => t.id === activeTabId);
            if (activeTab?.projectPath) {
                setProjectPath(activeTab.projectPath);
            }
        }
    }, [isVisible, activeTabId, openTabs]);

    useEffect(() => {
        if (!isVisible) {
            setPhase('idle');
            setAnalysis(null);
            setFixResult(null);
            setBatchResult(null);
            setSelectedFixes(new Set());
            setStatusMessage('');
        }
    }, [isVisible]);

    // =========================================================================
    // Single Project
    // =========================================================================

    const handleBrowseProject = useCallback(async () => {
        const defaultPath = await getProjectsBasePath();
        const selected = await open({ title: 'Select Flint Project Folder', directory: true, defaultPath });
        if (selected) setProjectPath(selected as string);
    }, []);

    const handleScanProject = useCallback(async () => {
        if (!projectPath) return;
        setPhase('scanning');
        setStatusMessage('Scanning project for issues…');
        setAnalysis(null);
        setFixResult(null);

        try {
            if (!config) {
                setPhase('loading-config');
                setStatusMessage('Fetching fix config…');
                const cfg = await api.getFixerConfig();
                setConfig(cfg);
            }

            setPhase('scanning');
            setStatusMessage('Analyzing BIN files…');
            const result = await api.analyzeProject(projectPath);
            setAnalysis(result);

            const allFixIds = new Set<string>();
            for (const scan of result.results) {
                for (const issue of scan.detected_issues) {
                    allFixIds.add(issue.fix_id);
                }
            }
            setSelectedFixes(allFixIds);

            setPhase('results');
            setStatusMessage(
                result.issues_found > 0
                    ? `Found ${result.issues_found} issue${result.issues_found === 1 ? '' : 's'} across ${result.results.length} file${result.results.length === 1 ? '' : 's'}`
                    : 'No issues found — your project is clean.'
            );
        } catch (err) {
            const msg = err instanceof api.FlintError ? err.getUserMessage() : String(err);
            showToast('error', msg);
            setPhase('idle');
            setStatusMessage('');
        }
    }, [projectPath, config, showToast]);

    const handleFixProject = useCallback(async () => {
        if (!projectPath || selectedFixes.size === 0) return;
        setPhase('fixing');
        setStatusMessage('Applying fixes…');

        try {
            const result = await api.fixProject(projectPath, Array.from(selectedFixes));
            setFixResult(result);
            setPhase('done');
            setStatusMessage(
                `Applied ${result.total_applied} fix${result.total_applied === 1 ? '' : 'es'}` +
                (result.total_failed > 0 ? `, ${result.total_failed} failed` : '')
            );
            showToast(
                result.total_failed > 0 ? 'warning' : 'success',
                `Fixed project: ${result.total_applied} applied, ${result.total_failed} failed`
            );
        } catch (err) {
            const msg = err instanceof api.FlintError ? err.getUserMessage() : String(err);
            showToast('error', msg);
            setPhase('results');
            setStatusMessage('Fix failed');
        }
    }, [projectPath, selectedFixes, showToast]);

    const toggleFix = useCallback((fixId: string) => {
        setSelectedFixes(prev => {
            const next = new Set(prev);
            if (next.has(fixId)) next.delete(fixId);
            else next.add(fixId);
            return next;
        });
    }, []);

    // =========================================================================
    // Batch Fix
    // =========================================================================

    const handleAddBatchProjects = useCallback(async () => {
        const defaultPath = await getProjectsBasePath();
        const selected = await open({
            title: 'Select Project Folders to Fix',
            directory: true,
            multiple: true,
            defaultPath,
        });
        if (selected) {
            const paths = Array.isArray(selected) ? selected : [selected];
            setBatchPaths(prev => [...new Set([...prev, ...paths])]);
        }
    }, []);

    const handleBatchFix = useCallback(async () => {
        if (batchPaths.length === 0) return;
        setPhase('fixing');
        setStatusMessage(`Fixing ${batchPaths.length} project${batchPaths.length === 1 ? '' : 's'}…`);
        setBatchResult(null);

        try {
            const result = await api.batchFixProjects(batchPaths);
            setBatchResult(result);
            setPhase('done');
            setStatusMessage(
                `Batch complete: ${result.total_applied} fixes across ${result.total_projects} projects`
            );
            showToast('success', `Batch fixed ${result.total_projects} projects (${result.total_applied} fixes)`);
        } catch (err) {
            const msg = err instanceof api.FlintError ? err.getUserMessage() : String(err);
            showToast('error', msg);
            setPhase('idle');
        }
    }, [batchPaths, showToast]);

    // =========================================================================
    // Render
    // =========================================================================

    const isWorking = phase === 'scanning' || phase === 'fixing' || phase === 'loading-config';

    return (
        <Modal open={isVisible} onClose={isWorking ? undefined : closeModal} size="wide" modifier="modal--fixer">
            <ModalHeader
                title={
                    <span className="fx-title">
                        <span className="fx-title__icon"><Icon name="wrench" /></span>
                        <span>
                            <span className="fx-title__name">Project Fixer</span>
                            <span className="fx-title__sub">Hematite-powered BIN repairs</span>
                        </span>
                    </span>
                }
                onClose={isWorking ? undefined : closeModal}
            />

            <div className="fx-tabs" role="tablist">
                <button
                    role="tab"
                    aria-selected={tab === 'single'}
                    className={`fx-tab ${tab === 'single' ? 'fx-tab--active' : ''}`}
                    onClick={() => { setTab('single'); setPhase('idle'); setBatchResult(null); }}
                    disabled={isWorking}
                >
                    <Icon name="file" />
                    <span>Single Project</span>
                </button>
                <button
                    role="tab"
                    aria-selected={tab === 'batch'}
                    className={`fx-tab ${tab === 'batch' ? 'fx-tab--active' : ''}`}
                    onClick={() => { setTab('batch'); setPhase('idle'); setAnalysis(null); setFixResult(null); }}
                    disabled={isWorking}
                >
                    <Icon name="folder" />
                    <span>Batch</span>
                </button>
            </div>

            <ModalBody style={{ minHeight: 320 }}>
                {tab === 'single' ? (
                    <SingleFixTab
                        projectPath={projectPath}
                        setProjectPath={setProjectPath}
                        phase={phase}
                        statusMessage={statusMessage}
                        analysis={analysis}
                        fixResult={fixResult}
                        selectedFixes={selectedFixes}
                        toggleFix={toggleFix}
                        onBrowse={handleBrowseProject}
                        onScan={handleScanProject}
                        onFix={handleFixProject}
                        isWorking={isWorking}
                        recentProjects={recentProjects}
                    />
                ) : (
                    <BatchFixTab
                        batchPaths={batchPaths}
                        setBatchPaths={setBatchPaths}
                        phase={phase}
                        statusMessage={statusMessage}
                        batchResult={batchResult}
                        onAdd={handleAddBatchProjects}
                        onFix={handleBatchFix}
                        isWorking={isWorking}
                        savedProjects={savedProjects ?? []}
                    />
                )}
            </ModalBody>

            <ModalFooter>
                <Button variant="ghost" onClick={closeModal} disabled={isWorking}>
                    Close
                </Button>
            </ModalFooter>
        </Modal>
    );
};

// =============================================================================
// Status banner
// =============================================================================

const StatusBanner: React.FC<{ phase: FixerPhase; message: string; isWorking: boolean }> = ({ phase, message, isWorking }) => {
    if (!message) return null;
    const tone =
        phase === 'done' ? 'ok' :
        phase === 'results' && message.includes('No issues') ? 'ok' :
        isWorking ? 'work' : 'info';

    return (
        <div className={`fx-status fx-status--${tone}`}>
            <span className="fx-status__icon">
                {isWorking ? <Spinner size="sm" /> : <Icon name={tone === 'ok' ? 'success' : 'info'} />}
            </span>
            <span className="fx-status__text">{message}</span>
        </div>
    );
};

// =============================================================================
// Single Fix Tab
// =============================================================================

interface SingleFixTabProps {
    projectPath: string;
    setProjectPath: (p: string) => void;
    phase: FixerPhase;
    statusMessage: string;
    analysis: ProjectAnalysis | null;
    fixResult: ProjectFixResult | null;
    selectedFixes: Set<string>;
    toggleFix: (id: string) => void;
    onBrowse: () => void;
    onScan: () => void;
    onFix: () => void;
    isWorking: boolean;
    recentProjects: RecentProject[];
}

const SingleFixTab: React.FC<SingleFixTabProps> = ({
    projectPath, setProjectPath, phase, statusMessage,
    analysis, fixResult, selectedFixes, toggleFix,
    onBrowse, onScan, onFix, isWorking, recentProjects,
}) => (
    <div className="fx-pane">
        {recentProjects.length > 0 && (
            <FormGroup>
                <FormLabel>Recent Projects</FormLabel>
                <div className="fx-recent">
                    {recentProjects.map((p: RecentProject) => {
                        const folderPath = p.path.replace(/[\\/]project\.json$/, '');
                        const isSelected = projectPath === folderPath;
                        return (
                            <button
                                key={p.path}
                                type="button"
                                onClick={() => { if (!isWorking) setProjectPath(folderPath); }}
                                className={`fx-chip ${isSelected ? 'fx-chip--active' : ''}`}
                                disabled={isWorking}
                            >
                                <Icon name="folder" />
                                <span>{p.champion} — {p.name}</span>
                            </button>
                        );
                    })}
                </div>
            </FormGroup>
        )}

        <FormGroup>
            <FormLabel>Project Path</FormLabel>
            <div className="fx-path-row">
                <Input
                    value={projectPath}
                    onChange={(e) => setProjectPath(e.target.value)}
                    placeholder="Select a Flint project folder…"
                    disabled={isWorking}
                />
                <Button onClick={onBrowse} disabled={isWorking} icon="folder">
                    Browse
                </Button>
                <Button variant="primary" onClick={onScan} disabled={!projectPath || isWorking} icon="search">
                    {phase === 'scanning' || phase === 'loading-config' ? 'Scanning…' : 'Scan'}
                </Button>
            </div>
        </FormGroup>

        <StatusBanner phase={phase} message={statusMessage} isWorking={isWorking} />

        {analysis && phase === 'results' && analysis.issues_found > 0 && (
            <div className="fx-results">
                <div className="fx-results__head">
                    <h3>Detected Issues</h3>
                    <span className="fx-results__count">{analysis.issues_found}</span>
                </div>
                <div className="fx-issues">
                    {analysis.results.map((scan) =>
                        scan.detected_issues.map((issue: DetectedIssue) => {
                            const checked = selectedFixes.has(issue.fix_id);
                            return (
                                <label
                                    key={`${scan.file_path}:${issue.fix_id}`}
                                    className={`fx-issue ${checked ? 'fx-issue--checked' : ''}`}
                                >
                                    <Checkbox
                                        checked={checked}
                                        onChange={() => toggleFix(issue.fix_id)}
                                    />
                                    <span className="fx-issue__body">
                                        <span className="fx-issue__row">
                                            <SeverityBadge severity={issue.severity} />
                                            <strong className="fx-issue__name">{issue.fix_name}</strong>
                                        </span>
                                        <span className="fx-issue__desc">{issue.description}</span>
                                        <span className="fx-issue__path">{scan.file_path.split(/[\\/]/).slice(-2).join('/')}</span>
                                    </span>
                                </label>
                            );
                        }),
                    )}
                </div>

                <Button
                    variant="success"
                    icon="success"
                    onClick={onFix}
                    disabled={selectedFixes.size === 0 || isWorking}
                    style={{ marginTop: 14 }}
                >
                    {isWorking ? 'Fixing…' : `Apply ${selectedFixes.size} Fix${selectedFixes.size === 1 ? '' : 'es'}`}
                </Button>
            </div>
        )}

        {fixResult && phase === 'done' && (
            <div className="fx-results">
                <div className="fx-results__head">
                    <h3>Fix Results</h3>
                </div>
                <div className="fx-issues">
                    {fixResult.results.map((r) => (
                        <div key={r.file_path} className="fx-result-file">
                            <div className="fx-result-file__name">
                                {r.file_path.split(/[\\/]/).slice(-2).join('/')}
                            </div>
                            {r.fixes_applied.map((f) => (
                                <div key={f.fix_id} className="fx-result-line fx-result-line--ok">
                                    <Icon name="success" />
                                    <span>{f.description}</span>
                                    <span className="fx-result-line__meta">{f.changes_count} change{f.changes_count === 1 ? '' : 's'}</span>
                                </div>
                            ))}
                            {r.fixes_failed.map((f) => (
                                <div key={f.fix_id} className="fx-result-line fx-result-line--err">
                                    <Icon name="error" />
                                    <span>{f.fix_id}: {f.error}</span>
                                </div>
                            ))}
                        </div>
                    ))}
                </div>
            </div>
        )}
    </div>
);

// =============================================================================
// Batch Fix Tab
// =============================================================================

interface BatchFixTabProps {
    batchPaths: string[];
    setBatchPaths: React.Dispatch<React.SetStateAction<string[]>>;
    phase: FixerPhase;
    statusMessage: string;
    batchResult: BatchFixResult | null;
    onAdd: () => void;
    onFix: () => void;
    isWorking: boolean;
    savedProjects: { id: string; name: string; champion: string; path: string; lastOpened: string }[];
}

/** Strip a trailing project file from a path so we land on the project folder. */
function projectFolder(p: string): string {
    return p.replace(/[\\/](mod\.config|flint|project)\.json$/, '');
}

const BatchFixTab: React.FC<BatchFixTabProps> = ({
    batchPaths, setBatchPaths, phase, statusMessage, batchResult,
    onAdd, onFix, isWorking, savedProjects,
}) => {
    const [filter, setFilter] = useState('');

    const projects = savedProjects.map((p) => ({ ...p, folderPath: projectFolder(p.path) }));
    const filtered = filter
        ? projects.filter((p) =>
            `${p.champion} ${p.name}`.toLowerCase().includes(filter.toLowerCase()))
        : projects;

    const allChecked = filtered.length > 0 && filtered.every((p) => batchPaths.includes(p.folderPath));
    const someChecked = filtered.some((p) => batchPaths.includes(p.folderPath));

    const toggleProject = (folderPath: string) => {
        setBatchPaths((prev) =>
            prev.includes(folderPath)
                ? prev.filter((x) => x !== folderPath)
                : [...prev, folderPath],
        );
    };

    const toggleAll = () => {
        if (allChecked) {
            const filteredSet = new Set(filtered.map((p) => p.folderPath));
            setBatchPaths((prev) => prev.filter((x) => !filteredSet.has(x)));
        } else {
            const all = filtered.map((p) => p.folderPath);
            setBatchPaths((prev) => Array.from(new Set([...prev, ...all])));
        }
    };

    const clearAll = () => setBatchPaths([]);

    return (
        <div className="fx-pane">
            <FormGroup>
                <div className="fx-batch-head">
                    <div>
                        <FormLabel>Your Projects</FormLabel>
                        <p className="fx-help">
                            {projects.length > 0
                                ? `Select projects to scan and fix in a single batch.`
                                : `No saved projects yet. Open one in Flint and it'll appear here.`}
                        </p>
                    </div>
                    <div className="fx-batch-head__actions">
                        <Input
                            placeholder="Search…"
                            value={filter}
                            onChange={(e) => setFilter(e.target.value)}
                            sizeVariant="sm"
                            disabled={isWorking || projects.length === 0}
                        />
                        <Button onClick={onAdd} disabled={isWorking} size="sm" icon="folder">
                            Add Folder
                        </Button>
                    </div>
                </div>
            </FormGroup>

            {projects.length > 0 && (
                <div className="fx-batch-list">
                    <div className="fx-batch-row fx-batch-row--head">
                        <Checkbox
                            checked={allChecked}
                            onChange={toggleAll}
                            label={
                                <span className="fx-batch-row__head-label">
                                    {batchPaths.length > 0
                                        ? <><strong>{batchPaths.length}</strong> selected</>
                                        : <>Select all{filter ? ' (filtered)' : ''}</>}
                                </span>
                            }
                        />
                        {someChecked && (
                            <Button variant="ghost" size="sm" onClick={clearAll} disabled={isWorking}>
                                Clear
                            </Button>
                        )}
                    </div>
                    {filtered.map((p) => {
                        const checked = batchPaths.includes(p.folderPath);
                        return (
                            <label
                                key={p.id || p.folderPath}
                                className={`fx-batch-row ${checked ? 'fx-batch-row--checked' : ''}`}
                            >
                                <Checkbox
                                    checked={checked}
                                    onChange={() => toggleProject(p.folderPath)}
                                    disabled={isWorking}
                                />
                                <Icon name="folder" />
                                <span className="fx-batch-row__body">
                                    <span className="fx-batch-row__name">
                                        <strong>{p.champion}</strong> · {p.name}
                                    </span>
                                    <span className="fx-batch-row__path">{p.folderPath}</span>
                                </span>
                            </label>
                        );
                    })}
                    {filter && filtered.length === 0 && (
                        <div className="fx-batch-empty">No projects match “{filter}”.</div>
                    )}
                </div>
            )}

            {(() => {
                const known = new Set(projects.map((p) => p.folderPath));
                const extras = batchPaths.filter((bp) => !known.has(bp));
                if (extras.length === 0) return null;
                return (
                    <div className="fx-batch-list">
                        <div className="fx-batch-row fx-batch-row--head">
                            <span className="fx-batch-row__head-label">Added folders ({extras.length})</span>
                        </div>
                        {extras.map((p) => (
                            <div key={p} className="fx-batch-row fx-batch-row--checked">
                                <Icon name="folder" />
                                <span className="fx-batch-row__path">{p}</span>
                                <Button
                                    variant="danger"
                                    size="sm"
                                    icon="trash"
                                    onClick={() => setBatchPaths((prev) => prev.filter((x) => x !== p))}
                                    disabled={isWorking}
                                >
                                    Remove
                                </Button>
                            </div>
                        ))}
                    </div>
                );
            })()}

            <StatusBanner phase={phase} message={statusMessage} isWorking={isWorking} />

            {batchPaths.length > 0 && phase !== 'done' && (
                <Button
                    variant="success"
                    icon="success"
                    onClick={onFix}
                    disabled={isWorking}
                    style={{ marginTop: 12 }}
                >
                    {isWorking ? 'Fixing…' : `Fix ${batchPaths.length} Project${batchPaths.length === 1 ? '' : 's'}`}
                </Button>
            )}

            {batchResult && phase === 'done' && (
                <div className="fx-results">
                    <div className="fx-results__head">
                        <h3>Batch Results</h3>
                    </div>
                    <div className="fx-issues">
                        {batchResult.projects.map((proj) => (
                            <div key={proj.project_path} className="fx-batch-result">
                                <div className="fx-batch-result__name">{proj.project_path.split(/[\\/]/).pop()}</div>
                                <div className="fx-batch-result__meta">
                                    {proj.total_applied > 0 && <span className="fx-pill fx-pill--ok">{proj.total_applied} fixed</span>}
                                    {proj.total_failed > 0 && <span className="fx-pill fx-pill--err">{proj.total_failed} failed</span>}
                                    {proj.total_applied === 0 && proj.total_failed === 0 && <span className="fx-pill">No issues</span>}
                                </div>
                            </div>
                        ))}
                    </div>
                    <div className="fx-batch-total">
                        <strong>Total:</strong>
                        <span className="fx-pill fx-pill--ok">{batchResult.total_applied} fixes applied</span>
                        {batchResult.total_failed > 0 && <span className="fx-pill fx-pill--err">{batchResult.total_failed} failed</span>}
                    </div>
                </div>
            )}
        </div>
    );
};

// =============================================================================
// Severity Badge
// =============================================================================

const SeverityBadge: React.FC<{ severity: string }> = ({ severity }) => (
    <span className={`fx-sev fx-sev--${severity}`}>{severity}</span>
);
