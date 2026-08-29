import * as api from '../api';
import { useAppMetadataStore, type FileIssueTag } from '../stores/appMetadataStore';
import { useProjectTabStore } from '../stores/projectTabStore';

const timers = new Map<string, number>();
const running = new Set<string>();

/** Periodic re-check while a project stays open — files change under Flint too
 * (external editors, Hematite runs, git), and tags must not go stale. */
const PERIODIC_MS = 5 * 60_000;

function isActiveProject(projectPath: string): boolean {
    const s = useProjectTabStore.getState();
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab?.projectPath === projectPath;
}

export function issueTagsFromIssues(issues: api.CheckIssue[], basePath: string): Array<[string, FileIssueTag]> {
    const byPath = new Map<string, FileIssueTag>();
    for (const issue of issues) {
        const key = `${basePath}/${issue.file}`;
        const existing = byPath.get(key);
        if (!existing) {
            byPath.set(key, { severity: issue.severity, message: issue.message });
        } else {
            byPath.set(key, {
                severity: existing.severity === 'critical' || issue.severity === 'critical' ? 'critical' : 'warning',
                message: `${existing.message}\n${issue.message}`,
            });
        }
    }
    return [...byPath.entries()];
}

async function run(projectPath: string): Promise<void> {
    if (running.has(projectPath)) {
        scheduleProjectAudit(projectPath, 5000);
        return;
    }
    running.add(projectPath);
    try {
        const report = await api.auditProjectMissingRefs(projectPath);
        useAppMetadataStore
            .getState()
            .replaceFileIssues(`${projectPath}/content/base/`, issueTagsFromIssues(report.issues, `${projectPath}/content/base`));
    } catch (e) {
        console.debug('[audit] project audit failed:', e);
    } finally {
        running.delete(projectPath);
        if (isActiveProject(projectPath)) scheduleProjectAudit(projectPath, PERIODIC_MS);
    }
}

/** Debounced background audit — feeds the file tree's error tags. */
export function scheduleProjectAudit(projectPath: string, delayMs = 800): void {
    if (!projectPath) return;
    const existing = timers.get(projectPath);
    if (existing !== undefined) window.clearTimeout(existing);
    timers.set(
        projectPath,
        window.setTimeout(() => {
            timers.delete(projectPath);
            // The tab may have been switched or closed since this was scheduled;
            // switching back reschedules via FileTree's project effect.
            if (!isActiveProject(projectPath)) return;
            void run(projectPath);
        }, delayMs),
    );
}
