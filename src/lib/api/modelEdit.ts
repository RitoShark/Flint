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
    /** `.anm` files rewritten because a renamed joint's name is hashed into their tracks. */
    anmFilesUpdated: string[];
    /** BIN files rewritten (e.g. `mBoneName`, `JointSnapEventData`) to follow a joint rename. */
    binFilesUpdated: string[];
}

/** Mirrors the Rust `ModelEdit` enum (serde tag = "kind", camelCase fields). */
export type ModelEdit =
    | { kind: 'renameSubmesh'; index: number; name: string }
    | { kind: 'duplicateSubmesh'; index: number; name: string }
    | { kind: 'deleteSubmesh'; index: number }
    | { kind: 'reorderSubmesh'; from: number; to: number }
    | { kind: 'pasteSubmesh'; sourceSkn: string; sourceIndex: number; name: string }
    | { kind: 'renameJoint'; index: number; name: string };

/** One BIN field referencing a joint by (hashed) name — e.g. `mBoneName`,
 *  `JointSnapEventData` — surfaced so the rename-impact dialog can list it. */
export interface BinBoneRef {
    file: string;
    field: string;
}

/** What a joint rename would rewrite: every `.anm` whose tracks are keyed by
 *  this joint's hashed name, and every BIN field that references it. */
export interface JointRenameImpact {
    anmFiles: string[];
    binRefs: BinBoneRef[];
}

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

/** Previews what a `renameJoint` op would rewrite, before it's staged —
 *  `index` is a position into the session's `skeleton.joints`. */
export async function previewJointRename(sessionId: string, index: number): Promise<JointRenameImpact> {
    return invokeCommand('preview_joint_rename', { sessionId, index });
}

/**
 * Assigns a submesh's visibility within one gear form of the skin BIN
 * (`show` adds it to `show_hashes`, `hide` to `hide_hashes`, `clear` removes
 * it from both). This writes the skin BIN immediately — it is independent of
 * the `.skn` edit session and is NOT undoable via the editor's undo stack.
 */
export async function assignSubmeshToForm(
    sknPath: string,
    formIndex: number,
    submesh: string,
    mode: 'show' | 'hide' | 'clear',
): Promise<void> {
    return invokeCommand('assign_submesh_to_form', { sknPath, formIndex, submesh, mode });
}
