import { invokeCommand } from './core';

/* Paint — resident in-memory VFX bin editing. A BIN is opened once into a Rust
   session (the parsed ritoshark tree); the frontend holds only this structured
   view and edits via commands that mutate the tree in place. */

export interface ColorKeyframe {
    rgba: [number, number, number, number];
    time: number;
}

export interface ColorData {
    keyframes: ColorKeyframe[];
    isConstant: boolean;
}

export interface EmitterColors {
    color: ColorData | null;
    birthColor: ColorData | null;
    fresnelColor: ColorData | null;
    lingerColor: ColorData | null;
}

export interface VfxEmitter {
    key: string;
    name: string;
    systemKey: string;
    blendMode: number;
    colors: EmitterColors;
}

export interface VfxSystem {
    key: string;
    name: string;
    particleName: string | null;
    emitterKeys: string[];
}

export interface MaterialParam {
    name: string;
    values: [number, number, number, number];
    /** Key the material-param command addresses this node by. */
    selectionKey: string;
}

export interface VfxMaterial {
    key: string;
    name: string;
    colorParams: MaterialParam[];
}

export interface VfxStats {
    systemCount: number;
    emitterCount: number;
    materialCount: number;
    colorParamCount: number;
}

export interface VfxModel {
    systems: VfxSystem[];
    systemOrder: string[];
    emitters: VfxEmitter[];
    materials: VfxMaterial[];
    materialOrder: string[];
    stats: VfxStats;
}

export interface PaintOpenResult {
    sessionId: number;
    model: VfxModel;
}

export type RecolorModeId =
    | 'random'
    | 'random-keyframe'
    | 'linear'
    | 'shift'
    | 'shift-hue'
    | 'materials';

/** A color slot the recolor applies to. */
export type ColorTargetId = 'all' | 'color' | 'birthColor' | 'fresnelColor' | 'lingerColor';

export interface PaletteStopInput {
    vec4: [number, number, number, number];
    time: number;
}

export interface RecolorOptionsInput {
    mode: RecolorModeId;
    ignoreBlackWhite?: boolean;
    preserveAlpha?: boolean;
    hslShift?: [number, number, number];
    hueTarget?: number | null;
    seed?: number;
}

export interface RecolorResult {
    changed: number;
    /** Refreshed colors for the touched emitters only — patch these into the
     *  resident model instead of replacing it wholesale. */
    colors: Record<string, EmitterColors>;
}

export interface PaintSaveResult {
    /** The file written, or null when there was nothing to save. */
    saved: string | null;
    /** True when a project checkpoint was created before writing. */
    checkpointed: boolean;
}

/** Cheap probe: does this BIN hold VFX systems or static materials? Backs the
 *  editor toolbar's Paint toggle visibility. */
export async function binHasVfxSystems(binPath: string): Promise<boolean> {
    return invokeCommand<boolean>('bin_has_vfx_systems', { binPath });
}

/** Open a BIN into a resident paint session. */
export async function paintOpen(path: string): Promise<PaintOpenResult> {
    return invokeCommand<PaintOpenResult>('paint_open', { path });
}

/** Close a session and free its tree. */
export async function paintClose(sessionId: number): Promise<boolean> {
    return invokeCommand<boolean>('paint_close', { sessionId });
}

/** Re-fetch the whole VFX model. */
export async function paintModel(sessionId: number): Promise<VfxModel> {
    return invokeCommand<VfxModel>('paint_model', { sessionId });
}

/** Recolor selected emitters' selected color slots. Returns the count changed
 *  plus refreshed colors for just the touched emitters. */
export async function paintRecolor(
    sessionId: number,
    emitterKeys: string[],
    colorTargets: ColorTargetId[],
    palette: PaletteStopInput[],
    options: RecolorOptionsInput,
): Promise<RecolorResult> {
    return invokeCommand<RecolorResult>('paint_recolor', {
        sessionId,
        emitterKeys,
        colorTargets,
        palette,
        options,
    });
}

/** Set a single static-material color param (`mat::<key>::<name>`). */
export async function paintSetMaterialParam(
    sessionId: number,
    selectionKey: string,
    values: [number, number, number, number],
    preserveAlpha = false,
): Promise<boolean> {
    return invokeCommand<boolean>('paint_set_material_param', {
        sessionId,
        selectionKey,
        values,
        preserveAlpha,
    });
}

/** Set a single emitter's blend mode. */
export async function paintSetBlendMode(
    sessionId: number,
    emitterKey: string,
    mode: number,
): Promise<boolean> {
    return invokeCommand<boolean>('paint_set_blend_mode', { sessionId, emitterKey, mode });
}

/** Undo the last edit. Returns the refreshed model, or null if nothing to undo. */
export async function paintUndo(sessionId: number): Promise<VfxModel | null> {
    return invokeCommand<VfxModel | null>('paint_undo', { sessionId });
}

/** Redo the last undone edit; returns the refreshed model or null. */
export async function paintRedo(sessionId: number): Promise<VfxModel | null> {
    return invokeCommand<VfxModel | null>('paint_redo', { sessionId });
}

/** Does the session hold unsaved edits? */
export async function paintIsDirty(sessionId: number): Promise<boolean> {
    return invokeCommand<boolean>('paint_is_dirty', { sessionId });
}

/** Save: checkpoints the owning project (when there is one), writes the BIN,
 *  and invalidates its `.ritobin` sidecar. */
export async function paintSave(sessionId: number): Promise<PaintSaveResult> {
    return invokeCommand<PaintSaveResult>('paint_save', { sessionId });
}
