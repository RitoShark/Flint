import type { BinRepairKind, CheckIssue } from '../api/audit';

export function issueRepair(issue: CheckIssue): { kind: BinRepairKind; label: string } | null {
    switch (issue.code) {
        case 'bin.old-vfx-shape': return { kind: 'shapes', label: 'Fix VFX shapes' };
        case 'bin.stale-sampler-field': return { kind: 'samplers', label: 'Repair material samplers' };
        case 'bin.embed-retagged': return { kind: 'retags', label: 'Migrate known classes' };
        case 'bin.schema-type-mismatch':
        case 'bin.string-ref-not-migrated':
        case 'bin.hash-ref-not-migrated': return { kind: 'types', label: 'Repair field types' };
        default: return null;
    }
}

export function issueGuidance(issue: CheckIssue): string {
    switch (issue.code) {
        case 'bin.old-vfx-shape': return 'Migrates legacy shapes and preserves their curves. Conflicting fields and unsupported layouts are kept for review.';
        case 'bin.stale-sampler-field': return 'Renames retired sampler fields and converts texture paths using current class metadata. Conflicting names or paths are left unchanged.';
        case 'bin.embed-retagged': return 'Applies known class migrations only when the new class accepts every existing field.';
        case 'bin.hash-ref-not-migrated': return 'Recovers original paths from known hash names before converting references. Unresolved hashes stay unchanged and appear in the repair results.';
        case 'bin.schema-type-mismatch':
        case 'bin.string-ref-not-migrated': return 'Converts supported field types without truncating numbers or discarding values. Unsupported conversions stay unchanged.';
        case 'bin.gameplay-entry': return 'This BIN includes base gameplay data. Remove the base champion BIN from the mod if it only duplicates game data; if it also contains custom content, move that content first. Automatic deletion could break local references.';
        case 'bin.missing-ref': return 'Restore these assets from the original mod or the matching game WAD, or correct the references to the intended replacements. A missing asset cannot be recreated from its path alone.';
        case 'animation.dangling-clip': return 'Restore the missing clip definition or choose the intended existing clip in the animation graph. Automatically deleting the reference can break animation transitions.';
        case 'animation.missing-clip-file': return 'Import the referenced ANM files from the original mod or matching game WAD, or choose replacement animations. Renaming a reference cannot recreate an animation.';
        case 'animation.clip-from-game': return 'These animations come from the installed game. Keep the references if intentional; include the matching ANM files only if the mod must override them.';
        default: return issue.detail ?? 'This issue requires checking the source asset or choosing a replacement. No lossless automatic repair is available.';
    }
}
