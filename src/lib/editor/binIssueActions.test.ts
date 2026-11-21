import { describe, it, expect } from 'vitest';
import type { CheckIssue } from '../api/audit';
import { issueGuidance, issueRepair } from './binIssueActions';

const baseIssue = (code: string): CheckIssue => ({
    severity: 'warning',
    code,
    file: 'data/vfx.bin',
    message: 'test',
});

describe('binIssueActions', () => {
    it('provides repair actions for relocated fields and class mismatches', () => {
        expect(issueRepair(baseIssue('bin.schema-field-relocated'))).toEqual({
            kind: 'types',
            label: 'Repair field layout',
        });
        expect(issueRepair(baseIssue('bin.schema-class-mismatch'))).toEqual({
            kind: 'types',
            label: 'Migrate object class',
        });
    });

    it('provides user-facing guidance for schema layout and class issues', () => {
        expect(issueGuidance(baseIssue('bin.schema-field-relocated'))).toContain('wrapper struct');
        expect(issueGuidance(baseIssue('bin.schema-class-mismatch'))).toContain('concrete replacement');
        expect(issueGuidance(baseIssue('bin.schema-type-mismatch'))).toContain('wrapper structs');
    });
});
