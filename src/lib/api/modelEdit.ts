import { invokeCommand } from './core';

/** One submesh (material range) of the session's current derived mesh. */
export interface SubmeshInfo {
    name: string;
    vertexCount: number;
    indexCount: number;
    vertexStart: number;
    indexStart: number;
}

/** The small JSON returned after every op — no geometry travels here. */
export interface ModelSummary {
    submeshes: SubmeshInfo[];
    vertexCount: number;
    indexCount: number;
    influenceCount: number;
    dirty: boolean;
    canUndo: boolean;
    canRedo: boolean;
}

export interface ModelSessionInfo {
    sessionId: string;
    sourcePath: string;
    /** Absent when the `.skn` has no sibling `.skl`. */
    skeletonPath: string | null;
    summary: ModelSummary;
}

export interface ModelSaveResult {
    sknPath: string;
    sklPath: string | null;
    summary: ModelSummary;
}

/** Mirrors the Rust `ModelEdit` enum (serde tag = "kind", camelCase fields). */
export type ModelEdit =
    | { kind: 'renameSubmesh'; index: number; name: string }
    | { kind: 'duplicateSubmesh'; index: number; name: string }
    | { kind: 'deleteSubmesh'; index: number }
    | { kind: 'reorderSubmesh'; from: number; to: number }
    | { kind: 'pasteSubmesh'; sourceSkn: string; sourceIndex: number; name: string };

/**
 * Opens the standalone 3D Editor window for a `.skn`. Mirrors the map-preview
 * multi-window pattern (CLAUDE.md "Multi-window pattern"). An already-open
 * editor is focused and retargeted at the new file.
 */
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

/** Current geometry in the shared binary wire format — decode with `decodeMeshPayload`. */
export async function deriveModelMesh(sessionId: string): Promise<ArrayBuffer> {
    return invokeCommand<ArrayBuffer>('derive_model_mesh', { sessionId });
}

export async function saveModelSession(sessionId: string, dest?: string): Promise<ModelSaveResult> {
    return invokeCommand('save_model_session', { sessionId, dest: dest ?? null });
}

export async function closeModelSession(sessionId: string): Promise<void> {
    return invokeCommand('close_model_session', { sessionId });
}
