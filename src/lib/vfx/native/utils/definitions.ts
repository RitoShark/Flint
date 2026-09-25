import type { EmitterModel, SystemModel } from '../../engine/model/model';
import { childPath, childPrefix, MAX_CHILD_DEPTH } from '../../engine/simulation/children';
import { drawRanks, GROUND_ORDER } from './drawKind';
export interface DrawnEmitter { readonly key: string; readonly emitter: EmitterModel; readonly path: string; readonly root: number; readonly rank: number }
export function drawnEmitters(system: SystemModel, posed = false): DrawnEmitter[] {
    const result: DrawnEmitter[] = [];
    const append = (model: SystemModel, path: string, root: number, depth: number) => {
        const base = result.length;
        const ranks = drawRanks(model.emitters);
        result.push(...model.emitters.map(emitter => ({ emitter, path, root: depth ? root : emitter.index,
            key: path ? `${path}:${emitter.index}` : String(emitter.index),
            rank: base + (ranks.get(emitter.index) ?? 0) + (emitter.groundLayer ? GROUND_ORDER : 0),
        })));
        if (depth >= MAX_CHILD_DEPTH) return;
        for (const emitter of model.emitters) {
            const children = emitter.childSet;
            if (!children || emitter.disabled || (children.bones.length && !posed && !emitter.mesh?.skinned)) continue;
            children.children.forEach((child, slot) => {
                if (child) append(child, childPath(path ? childPrefix(path) : '', emitter.index, slot), depth ? root : emitter.index, depth + 1);
            });
        }
    };
    append(system, '', 0, 0);
    return result;
}
