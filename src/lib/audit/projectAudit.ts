import * as api from '../api';
import { useAppMetadataStore, type FileIssueTag } from '../stores/appMetadataStore';
import { useProjectTabStore } from '../stores/projectTabStore';

const timers = new Map<string, number>();
const running = new Set<string>();
const fileTimers = new Map<string, number>();

/** Periodic re-check while a project stays open — files change under Flint too
 * (external editors, Hematite runs, git), and tags must not go stale. */
const PERIODIC_MS = 5 * 60_000;

function isActiveProject(projectPath: string): boolean {
    const s = useProjectTabStore.getState();
    const tab = s.openTabs.find((t) => t.id === s.activeTabId);
    return tab?.projectPath === projectPath;
}

/** `Line 12 · expected texturePath: file — <message>` when the check pinned it down. */
export function issueText(issue: api.CheckIssue): string {
    const where = [
        issue.line ? `Line ${issue.line}` : null,
        issue.expected ? `expected ${issue.expected}` : null,
    ].filter(Boolean).join(' · ');
    return where ? `${where} — ${issue.message}` : issue.message;
}

export function issueTagsFromIssues(issues: api.CheckIssue[], basePath: string): Array<[string, FileIssueTag]> {
    const byPath = new Map<string, FileIssueTag>();
    for (const issue of issues) {
        const key = `${basePath}/${issue.file}`;
        const existing = byPath.get(key);
        if (!existing) {
            byPath.set(key, { severity: issue.severity, message: issueText(issue) });
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

/** The `<wad>/<path>` an issue is reported under, for a file inside a project. */
function issueRelPath(projectPath: string, filePath: string): string | null {
    const base = `${projectPath.replace(/\\/g, '/')}/content/base/`.toLowerCase();
    const abs = filePath.replace(/\\/g, '/');
    return abs.toLowerCase().startsWith(base) ? abs.slice(base.length) : null;
}

/**
 * Re-check ONE file after it changed, so a fix clears its tag straight away instead of
 * at the next sweep. Falls back to nothing when the file is outside the project's
 * content — the project-wide audit still covers everything on its own schedule.
 */
export function recheckFile(projectPath: string, filePath: string, delayMs = 400): void {
    const rel = issueRelPath(projectPath, filePath);
    if (!rel) return;

    const key = `${projectPath}::${rel}`;
    const existing = fileTimers.get(key);
    if (existing !== undefined) window.clearTimeout(existing);
    fileTimers.set(
        key,
        window.setTimeout(async () => {
            fileTimers.delete(key);
            try {
                const issues = await api.recheckProjectFile(projectPath, rel);
                const base = `${projectPath}/content/base`;
                const tags = issueTagsFromIssues(issues, base);
                const store = useAppMetadataStore.getState();
                // One file in, one file out: clear it first, then set whatever came back.
                store.setFileIssue(`${base}/${rel}`, null);
                for (const [path, tag] of tags) store.setFileIssue(path, tag);
            } catch (e) {
                console.debug('[audit] file recheck failed:', rel, e);
            }
        }, delayMs),
    );
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
