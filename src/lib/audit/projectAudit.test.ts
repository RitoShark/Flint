import { describe, expect, it, vi, beforeEach } from 'vitest';
import { issueText, issueTagsFromIssues, recheckFile } from './projectAudit';
import { useAppMetadataStore } from '../stores/appMetadataStore';
import { useProjectTabStore } from '../stores/projectTabStore';
import * as api from '../api';
import type { CheckIssue } from '../api';

vi.mock('../api', () => ({ recheckProjectFile: vi.fn() }));

const issue = (over: Partial<CheckIssue> = {}): CheckIssue => ({
    severity: 'critical',
    code: 'bin.string-ref-not-migrated',
    file: 'aurora.wad.client/data/skin0.bin',
    message: 'still typed as `string`.',
    ...over,
});

describe('issueText', () => {
    it('leads with the line and the expected form when the check found them', () => {
        expect(issueText(issue({ line: 42, expected: 'texturePath: file' })))
            .toBe('Line 42 · expected texturePath: file — still typed as `string`.');
    });

    it('is just the message when it could not pin one down', () => {
        expect(issueText(issue())).toBe('still typed as `string`.');
    });

    it('reports a line without an expected form, and the other way round', () => {
        expect(issueText(issue({ line: 7 }))).toBe('Line 7 — still typed as `string`.');
        expect(issueText(issue({ expected: 'a: file' }))).toBe('expected a: file — still typed as `string`.');
    });
});

describe('issueTagsFromIssues', () => {
    it('keys tags by absolute path and carries the located detail', () => {
        const tags = issueTagsFromIssues([issue({ line: 3, expected: 'texture: file' })], '/p/content/base');
        expect(tags).toHaveLength(1);
        expect(tags[0][0]).toBe('/p/content/base/aurora.wad.client/data/skin0.bin');
        expect(tags[0][1].message).toContain('Line 3');
    });

    it('merges two findings on one file, keeping the worst severity', () => {
        const tags = issueTagsFromIssues(
            [issue({ severity: 'warning', message: 'first' }), issue({ severity: 'critical', message: 'second' })],
            '/p/content/base',
        );
        expect(tags).toHaveLength(1);
        expect(tags[0][1].severity).toBe('critical');
        expect(tags[0][1].message).toBe('first\nsecond');
    });
});

/* The bin editor refreshes its own issue list off fileIssuesRev, so a recheck that finds a
   file clean has to bump the revision, not just quietly drop the tag. */
describe('recheckFile', () => {
    const project = '/p';
    const file = '/p/content/base/aurora.wad.client/data/skin0.bin';

    beforeEach(() => {
        vi.useFakeTimers();
        // recheckFile debounces through window; the node test env has no window of its own.
        vi.stubGlobal('window', {
            setTimeout: (fn: () => void, ms?: number) => globalThis.setTimeout(fn, ms),
            clearTimeout: (id: number) => globalThis.clearTimeout(id),
        });
        useProjectTabStore.setState({
            activeTabId: 't1',
            openTabs: [{ id: 't1', projectPath: project, project: null, selectedFile: null } as never],
        });
        useAppMetadataStore.getState().setFileIssue(file, null);
    });

    async function settle() {
        await vi.advanceTimersByTimeAsync(500);
    }

    it('bumps the revision when a file that had a finding comes back clean', async () => {
        const store = useAppMetadataStore.getState();
        store.setFileIssue(file, { severity: 'critical', message: 'still typed as `string`.' });
        const before = useAppMetadataStore.getState().fileIssuesRev;
        vi.mocked(api.recheckProjectFile).mockResolvedValue([]);

        recheckFile(project, file);
        await settle();

        expect(useAppMetadataStore.getState().getFileIssue(file)).toBeUndefined();
        expect(useAppMetadataStore.getState().fileIssuesRev).toBeGreaterThan(before);
    });

    it('bumps the revision when the findings change rather than disappear', async () => {
        const store = useAppMetadataStore.getState();
        store.setFileIssue(file, { severity: 'critical', message: 'old' });
        const before = useAppMetadataStore.getState().fileIssuesRev;
        vi.mocked(api.recheckProjectFile).mockResolvedValue([
            {
                severity: 'warning',
                code: 'bin.schema-type-mismatch',
                file: 'aurora.wad.client/data/skin0.bin',
                message: 'new',
            },
        ]);

        recheckFile(project, file);
        await settle();

        expect(useAppMetadataStore.getState().getFileIssue(file)?.message).toContain('new');
        expect(useAppMetadataStore.getState().fileIssuesRev).toBeGreaterThan(before);
    });
});
