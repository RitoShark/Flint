import { invokeCommand } from './core';
import type { Checkpoint, CheckpointDiff, CheckpointFileContent } from '../types';

export async function createCheckpoint(
    projectPath: string,
    message: string,
    tags: string[] = []
): Promise<Checkpoint> {
    return invokeCommand('create_checkpoint', { projectPath, message, tags });
}

export async function listCheckpoints(projectPath: string): Promise<Checkpoint[]> {
    return invokeCommand('list_checkpoints', { projectPath });
}

export async function restoreCheckpoint(projectPath: string, checkpointId: string): Promise<void> {
    return invokeCommand('restore_checkpoint', { projectPath, checkpointId });
}

export async function compareCheckpoints(
    projectPath: string,
    fromId: string,
    toId: string
): Promise<CheckpointDiff> {
    return invokeCommand('compare_checkpoints', { projectPath, fromId, toId });
}

export async function deleteCheckpoint(projectPath: string, checkpointId: string): Promise<void> {
    return invokeCommand('delete_checkpoint', { projectPath, checkpointId });
}

export async function readCheckpointFile(
    projectPath: string,
    hash: string,
    filePath: string
): Promise<CheckpointFileContent> {
    return invokeCommand('read_checkpoint_file', { projectPath, hash, filePath });
}

export async function getFileChanges(projectPath: string): Promise<Record<string, string>> {
    return invokeCommand('get_file_changes', { projectPath });
}

/**
 * Combined list + per-pair diffs — replaces N+1 sequential calls
 * (listCheckpoints + N×compareCheckpoints) in CheckpointTimeline.
 *
 * Returns the checkpoints in newest-first order plus a `diffs` map keyed by
 * the newer checkpoint's id (matches the loop's `diffs[list[i].id] = ...`
 * pattern: each entry diffs `list[i+1]` → `list[i]`).
 */
export interface CheckpointsWithDiffs {
    checkpoints: Checkpoint[];
    diffs: Record<string, CheckpointDiff>;
}

export async function listCheckpointsWithDiffs(projectPath: string): Promise<CheckpointsWithDiffs> {
    return invokeCommand('list_checkpoints_with_diffs', { projectPath });
}
