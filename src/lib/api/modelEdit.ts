import { invokeCommand } from './core';

export interface SubmeshInfo {
    name: string;
    vertexCount: number;
    indexCount: number;
    vertexStart: number;
    indexStart: number;
}

export interface ModelSummary {
    submeshes: SubmeshInfo[];
    vertexCount: number;
    indexCount: number;
    influenceCount: number;
    influences: number[];
    dirty: boolean;
    canUndo: boolean;
    canRedo: boolean;
}

export interface ModelSessionInfo {
    sessionId: string;
    sourcePath: string;
    skeletonPath: string | null;
    summary: ModelSummary;
}

export interface ModelSaveResult {
    sknPath: string;
    sklPath: string | null;
    summary: ModelSummary;
    anmFilesUpdated: string[];
    binFilesUpdated: string[];
}

// Mirrors the Rust `ModelEdit` enum (serde tag = "kind", camelCase fields).
export type ModelEdit =
    | { kind: 'renameSubmesh'; index: number; name: string }
    | { kind: 'duplicateSubmesh'; index: number; name: string }
    | { kind: 'deleteSubmesh'; index: number }
    | { kind: 'reorderSubmesh'; from: number; to: number }
    | { kind: 'pasteSubmesh'; sourceSkn: string; sourceIndex: number; name: string }
    | { kind: 'renameJoint'; index: number; name: string }
    | { kind: 'paintWeights'; entries: WeightEntry[] };

export interface WeightEntry {
    vertex: number;
    joints: number[];
    weights: number[];
}

export interface BinBoneRef {
    file: string;
    field: string;
}

export interface JointRenameImpact {
    anmFiles: string[];
    binRefs: BinBoneRef[];
}

export async function openModelEditorWindow(project: string, skn: string): Promise<void> {
    return invokeCommand('open_model_editor_window', { projectPath: project, sknPath: skn });
}

export async function openModelSession(sknPath: string): Promise<ModelSessionInfo> {
    return invokeCommand('open_model_session', { sknPath });
}

export async function stageModelEdit(sessionId: string, edit: ModelEdit): Promise<ModelSummary> {
    return invokeCommand('stage_model_edit', { sessionId, edit });
}

export async function undoModelEdit(sessionId: string): Promise<ModelSummary> {
    return invokeCommand('undo_model_edit', { sessionId });
}

export async function redoModelEdit(sessionId: string): Promise<ModelSummary> {
    return invokeCommand('redo_model_edit', { sessionId });
}

export async function deriveModelMesh(sessionId: string): Promise<ArrayBuffer> {
    return invokeCommand<ArrayBuffer>('derive_model_mesh', { sessionId });
}

export async function saveModelSession(sessionId: string, dest?: string): Promise<ModelSaveResult> {
    return invokeCommand('save_model_session', { sessionId, dest: dest ?? null });
}

export async function closeModelSession(sessionId: string): Promise<void> {
    return invokeCommand('close_model_session', { sessionId });
}

export async function previewJointRename(sessionId: string, index: number): Promise<JointRenameImpact> {
    return invokeCommand('preview_joint_rename', { sessionId, index });
}

// Writes the skin BIN immediately, independent of the .skn edit session — NOT undoable via the editor's undo stack.
export async function assignSubmeshToForm(
    sknPath: string,
    formIndex: number,
    submesh: string,
    mode: 'show' | 'hide' | 'clear',
): Promise<void> {
    return invokeCommand('assign_submesh_to_form', { sknPath, formIndex, submesh, mode });
}
