import React, { useState, useEffect, useMemo, useCallback } from 'react';
import { listen } from '@tauri-apps/api/event';
import {
    useModalStore,
    useNotificationStore,
    useConfigStore,
    useProjectTabStore,
} from '../../lib/stores';
import * as api from '../../lib/api';
import type { FixEntry, ProjectFixReport, FixProgress } from '../../lib/api';
import {
    Button,
    Checkbox,
    Icon,
    Modal,
    ModalBody,
    ModalFooter,
    ModalHeader,
    Spinner,
} from '../ui';
import { useTranslation } from '../../lib/i18n';

type Step = 'projects' | 'fixes' | 'running' | 'results';

interface ProjectChoice {
    path: string;
    name: string;
}

const SEVERITY_ORDER: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };

/** A fix that fired somewhere, aggregated across the scanned projects. */
interface DetectedFix {
    entry: FixEntry;
    totalHits: number;
    projectCount: number;
}

export const SkinFixerModal: React.FC = () => {
    const activeModal = useModalStore((s) => s.activeModal);
    const closeModal = useModalStore((s) => s.closeModal);
    const showToast = useNotificationStore((s) => s.showToast);
    const savedProjects = useConfigStore((s) => s.savedProjects);
    const recentProjects = useConfigStore((s) => s.recentProjects);
    const openTabs = useProjectTabStore((s) => s.openTabs);

    const isVisible = activeModal === 'skinFixer';

    const [step, setStep] = useState<Step>('projects');
    const [selectedPaths, setSelectedPaths] = useState<Set<string>>(new Set());

    const [catalog, setCatalog] = useState<FixEntry[]>([]);
    const [scanning, setScanning] = useState(false);
    const [detected, setDetected] = useState<DetectedFix[]>([]);
    const [chosenFixIds, setChosenFixIds] = useState<Set<string>>(new Set());

    const [createCheckpoint, setCreateCheckpoint] = useState(true);
    const [useLive, setUseLive] = useState(true);

    const [progress, setProgress] = useState<FixProgress | null>(null);
    const [results, setResults] = useState<ProjectFixReport[]>([]);

    // Distinct, de-duplicated project list: open tabs first, then saved, then recents.
    const allProjects = useMemo<ProjectChoice[]>(() => {
        const seen = new Set<string>();
        const out: ProjectChoice[] = [];
        const add = (path: string | undefined, name: string) => {
            if (!path) return;
            const key = path.replace(/[\\/]+$/, '').toLowerCase();
            if (seen.has(key)) return;
            seen.add(key);
            out.push({ path, name });
        };
        for (const t of openTabs) if (t.projectPath) add(t.projectPath, t.project?.display_name || t.project?.name || t.projectPath);
        for (const p of savedProjects) add(p.path, p.name);
        for (const p of recentProjects) add(p.path, p.name);
        return out;
    }, [openTabs, savedProjects, recentProjects]);

    const reset = useCallback(() => {
        setStep('projects');
        setSelectedPaths(new Set());
        setScanning(false);
        setDetected([]);
        setChosenFixIds(new Set());
        setProgress(null);
        setResults([]);
    }, []);

    useEffect(() => {
        if (!isVisible) {
            reset();
            return;
        }
        // Preselect the currently-open project(s).
        const open = openTabs.map((t) => t.projectPath).filter(Boolean) as string[];
        if (open.length) setSelectedPaths(new Set(open));
        // Warm the fix catalog for names/descriptions/severity.
        api.hematiteListFixes().then(setCatalog).catch(() => {/* surfaced on scan */});
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [isVisible]);

    // Live progress during a run.
    useEffect(() => {
        if (step !== 'running') return;
        let unlisten: (() => void) | null = null;
        listen<FixProgress>('hematite-fix-progress', (e) => setProgress(e.payload))
            .then((fn) => { unlisten = fn; });
        return () => { if (unlisten) unlisten(); };
    }, [step]);

    const catalogById = useMemo(() => {
        const m = new Map<string, FixEntry>();
        for (const f of catalog) m.set(f.id, f);
        return m;
    }, [catalog]);

    const toggleProject = (path: string) => {
        setSelectedPaths((prev) => {
            const next = new Set(prev);
            if (next.has(path)) next.delete(path); else next.add(path);
            return next;
        });
    };

    const runScan = async () => {
        const paths = [...selectedPaths];
        if (!paths.length) return;
        setScanning(true);
        setStep('fixes');
        try {
            // Scan against the full catalog so every applicable fix can fire.
            const allIds = catalog.length ? catalog.map((f) => f.id) : [];
            const reports = await api.hematiteScanProjects(paths, allIds);

            // Aggregate detections across projects.
            const agg = new Map<string, DetectedFix>();
            for (const r of reports) {
                const perProject = new Set<string>();
                for (const o of r.outcomes) {
                    const entry = catalogById.get(o.fix_id) || {
                        id: o.fix_id, name: o.fix_name, description: '', severity: 'medium',
                        enabled: true, wad_level: false,
                    };
                    const cur = agg.get(o.fix_id) || { entry, totalHits: 0, projectCount: 0 };
                    cur.totalHits += o.changes || 0;
                    if (!perProject.has(o.fix_id)) { cur.projectCount += 1; perProject.add(o.fix_id); }
                    agg.set(o.fix_id, cur);
                }
            }
            const list = [...agg.values()].sort(
                (a, b) => (SEVERITY_ORDER[a.entry.severity] ?? 9) - (SEVERITY_ORDER[b.entry.severity] ?? 9),
            );
            setDetected(list);
            setChosenFixIds(new Set(list.map((d) => d.entry.id))); // pre-check all detected

            const failed = reports.filter((r) => r.error);
            if (failed.length) {
                showToast('warning', `${failed.length} project(s) could not be scanned — ${failed[0].error}`);
            }
        } catch (err) {
            showToast('error', `Scan failed: ${(err as Error).message}`);
            setStep('projects');
        } finally {
            setScanning(false);
        }
    };

    const toggleFix = (id: string) => {
        setChosenFixIds((prev) => {
            const next = new Set(prev);
            if (next.has(id)) next.delete(id); else next.add(id);
            return next;
        });
    };

    const runFixes = async () => {
        const paths = [...selectedPaths];
        const fixIds = [...chosenFixIds];
        if (!paths.length || !fixIds.length) return;

        if (createCheckpoint) {
            for (const p of paths) {
                try {
                    await api.createCheckpoint(p, 'Before skin fix', ['auto', 'skin-fixer']);
                } catch { /* non-fatal — proceed */ }
            }
        }

        setStep('running');
        setProgress({ project: '', stage: 'Starting…' });
        try {
            const reports = await api.hematiteRunFixes(paths, fixIds, useLive);
            setResults(reports);
            setStep('results');
            const applied = reports.reduce((n, r) => n + r.fixes_applied, 0);
            const failedProjects = reports.filter((r) => r.error).length;
            if (failedProjects) {
                showToast('warning', `Fixed ${applied} issue(s); ${failedProjects} project(s) failed`);
            } else {
                showToast('success', `Applied ${applied} fix(es) across ${reports.length} project(s)`);
            }
        } catch (err) {
            showToast('error', `Fixing failed: ${(err as Error).message}`);
            setStep('fixes');
        }
    };

    const severityClass = (s: string) => `skinfix-sev skinfix-sev--${s}`;

    const { t } = useTranslation();

    const footer = () => {
        switch (step) {
            case 'projects':
                return (
                    <>
                        <Button variant="secondary" onClick={closeModal}>{t('common.cancel')}</Button>
                        <Button
                            variant="primary"
                            icon="search"
                            disabled={selectedPaths.size === 0 || catalog.length === 0}
                            onClick={runScan}
                        >
                            {t('skinFixer.scanBtn')} {selectedPaths.size > 0 ? `(${selectedPaths.size})` : ''}
                        </Button>
                    </>
                );
            case 'fixes':
                return (
                    <>
                        <Button variant="secondary" onClick={() => setStep('projects')}>{t('common.back')}</Button>
                        <Button
                            variant="primary"
                            icon="success"
                            disabled={scanning || chosenFixIds.size === 0}
                            onClick={runFixes}
                        >
                            {t('skinFixer.fixBtn')} {chosenFixIds.size > 0 ? `(${chosenFixIds.size})` : ''}
                        </Button>
                    </>
                );
            case 'running':
                return <Button variant="secondary" disabled>{t('skinFixer.fixing')}</Button>;
            case 'results':
                return <Button variant="primary" onClick={closeModal}>{t('common.done')}</Button>;
        }
    };

    return (
        <Modal open={isVisible} onClose={closeModal} size="large" modifier="skin-fixer-modal">
            <ModalHeader title={t('skinFixer.title')} onClose={closeModal} />

            <ModalBody>
                <div className="skinfix-steps">
                    <span className={`skinfix-step ${step === 'projects' ? 'is-active' : ''}`}>{t('skinFixer.step1')}</span>
                    <span className="skinfix-step-sep" />
                    <span className={`skinfix-step ${step === 'fixes' ? 'is-active' : ''}`}>{t('skinFixer.step2')}</span>
                    <span className="skinfix-step-sep" />
                    <span className={`skinfix-step ${step === 'running' || step === 'results' ? 'is-active' : ''}`}>{t('skinFixer.step3')}</span>
                </div>

                {step === 'projects' && (
                    <div className="skinfix-projects">
                        {allProjects.length === 0 ? (
                            <div className="skinfix-empty">
                                <Icon name="folder" />
                                <p>{t('skinFixer.noProjects')}</p>
                            </div>
                        ) : (
                            allProjects.map((p) => {
                                const on = selectedPaths.has(p.path);
                                return (
                                    <button
                                        key={p.path}
                                        type="button"
                                        className={`skinfix-project ${on ? 'is-on' : ''}`}
                                        onClick={() => toggleProject(p.path)}
                                    >
                                        <span className="skinfix-project__check">
                                            {on && <Icon name="success" />}
                                        </span>
                                        <span className="skinfix-project__body">
                                            <strong>{p.name}</strong>
                                            <span className="skinfix-project__path" title={p.path}>{p.path}</span>
                                        </span>
                                    </button>
                                );
                            })
                        )}
                    </div>
                )}

                {step === 'fixes' && (
                    <div className="skinfix-fixes">
                        {scanning ? (
                            <div className="skinfix-scanning">
                                <Spinner />
                                <p>{t('skinFixer.scanning', { count: selectedPaths.size })}</p>
                            </div>
                        ) : detected.length === 0 ? (
                            <div className="skinfix-empty">
                                <Icon name="success" />
                                <p>{t('skinFixer.noIssues')}</p>
                            </div>
                        ) : (
                            <>
                                <p className="skinfix-fixes__hint">
                                    {detected.length === 1
                                        ? t('skinFixer.detectedHint', { count: detected.length, projects: selectedPaths.size })
                                        : t('skinFixer.detectedHintPlural', { count: detected.length, projects: selectedPaths.size })}
                                </p>
                                {detected.map((d) => {
                                    const on = chosenFixIds.has(d.entry.id);
                                    return (
                                        <div
                                            key={d.entry.id}
                                            className={`skinfix-fix ${on ? 'is-on' : ''}`}
                                            onClick={(e) => {
                                                if ((e.target as HTMLElement).closest('input')) return;
                                                toggleFix(d.entry.id);
                                            }}
                                        >
                                            <Checkbox
                                                toggle
                                                checked={on}
                                                onChange={() => toggleFix(d.entry.id)}
                                            />
                                            <div className="skinfix-fix__body">
                                                <div className="skinfix-fix__head">
                                                    <strong>{d.entry.name}</strong>
                                                    <span className={severityClass(d.entry.severity)}>{d.entry.severity}</span>
                                                    <span className="skinfix-fix__count">
                                                        {d.totalHits > 0 ? `${d.totalHits} hit${d.totalHits === 1 ? '' : 's'}` : 'detected'}
                                                        {d.projectCount > 1 ? ` · ${d.projectCount} projects` : ''}
                                                    </span>
                                                </div>
                                                {d.entry.description && (
                                                    <p className="skinfix-fix__desc">{d.entry.description}</p>
                                                )}
                                            </div>
                                        </div>
                                    );
                                })}

                                <div className="skinfix-options">
                                    <label className="skinfix-opt">
                                        <Checkbox
                                            checked={createCheckpoint}
                                            onChange={(e) => setCreateCheckpoint(e.target.checked)}
                                            label={t('skinFixer.createCheckpoint')}
                                        />
                                    </label>
                                    <label className="skinfix-opt">
                                        <Checkbox
                                            checked={useLive}
                                            onChange={(e) => setUseLive(e.target.checked)}
                                            label={t('skinFixer.recoverLive')}
                                        />
                                    </label>
                                </div>
                                <div className="skinfix-warn">
                                    <Icon name="warning" />
                                    <span>{t('skinFixer.warn')}</span>
                                </div>
                            </>
                        )}
                    </div>
                )}

                {step === 'running' && (
                    <div className="skinfix-running">
                        <Spinner />
                        <p className="skinfix-running__stage">
                            {progress?.stage || (progress?.fix ? `Applied: ${progress.fix}` : progress?.note) || t('common.loading')}
                        </p>
                        {progress?.project && <p className="skinfix-running__proj">{progress.project}</p>}
                    </div>
                )}

                {step === 'results' && (
                    <div className="skinfix-results">
                        {results.map((r) => (
                            <div key={r.project} className={`skinfix-result ${r.error ? 'is-error' : ''}`}>
                                <div className="skinfix-result__head">
                                    <strong>{r.project.replace(/[\\/]+$/, '').split(/[\\/]/).pop()}</strong>
                                    {r.error ? (
                                        <span className="skinfix-sev skinfix-sev--critical">{t('common.error')}</span>
                                    ) : (
                                        <span className="skinfix-result__stat">
                                            {r.fixes_applied} applied
                                            {r.files_removed > 0 ? ` · ${r.files_removed} removed` : ''}
                                            {r.fixes_failed > 0 ? ` · ${r.fixes_failed} failed` : ''}
                                        </span>
                                    )}
                                </div>
                                {r.error && <p className="skinfix-result__err">{r.error}</p>}
                                {!r.error && r.outcomes.length > 0 && (
                                    <ul className="skinfix-result__list">
                                        {r.outcomes.map((o, i) => (
                                            <li key={`${o.fix_id}-${i}`}>
                                                <span>{o.fix_name}</span>
                                                <span className="skinfix-result__ochanges">{o.changes}</span>
                                            </li>
                                        ))}
                                    </ul>
                                )}
                                {!r.error && r.outcomes.length === 0 && (
                                    <p className="skinfix-result__none">{t('skinFixer.noChanges')}</p>
                                )}
                            </div>
                        ))}
                    </div>
                )}
            </ModalBody>

            <ModalFooter>{footer()}</ModalFooter>
        </Modal>
    );
};
