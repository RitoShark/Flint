import { describe, expect, it } from 'vitest';
import { issueText, issueTagsFromIssues } from './projectAudit';
import type { CheckIssue } from '../api';

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
