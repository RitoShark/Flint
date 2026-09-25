import { AttributeData, InstanceAttribute, InstanceGeometry, type GeometryData } from '../data';
import type { MeshPose } from './meshPose';

export const QUADS_PER_EMITTER = 4096;
export const MESHES_PER_EMITTER = 512;
const uvColumns = { uvTurn: 3, uvShift: 4, uvTurnMult: 3, uvShiftMult: 4 } as const;
const quadColumns = { ...uvColumns, center: 3, size: 3, color: 4, roll: 1, basisX: 3, basisY: 3, basisZ: 3, lookup: 3 } as const;
const meshColumns = { ...uvColumns, instanceMatrix: 16, tint: 4, erode: 1 } as const;
type Columns<T> = { readonly [K in keyof T]: InstanceAttribute };
export type QuadBuffers = Columns<typeof quadColumns> & { readonly geometry: InstanceGeometry };
export type MeshBuffers = Columns<typeof meshColumns> & { readonly geometry: GeometryData; readonly pose?: MeshPose };
function createColumns<T extends Record<string, number>>(geometry: GeometryData, capacity: number, schema: T): Columns<T> {
    return Object.fromEntries(Object.entries(schema).map(([name, width]) => {
        const buffer = new InstanceAttribute(new Float32Array(width * capacity), width);
        geometry.setAttribute(name, buffer);
        return [name, buffer];
    })) as Columns<T>;
}
export function quadBuffers(capacity: number): QuadBuffers {
    const geometry = new InstanceGeometry();
    geometry.setIndex([0, 1, 2, 0, 2, 3]);
    geometry.setAttribute('position', new AttributeData(new Float32Array(12), 3));
    geometry.setAttribute('corner', new AttributeData(Float32Array.of(-.5, -.5, .5, -.5, .5, .5, -.5, .5), 2));
    geometry.instanceCount = 0;
    return { geometry, ...createColumns(geometry, capacity, quadColumns) };
}
export function meshBuffers(geometry: GeometryData): MeshBuffers {
    return { geometry, ...createColumns(geometry, MESHES_PER_EMITTER, meshColumns) };
}
export function written(attribute: AttributeData, items: number): void {
    attribute.clearUpdateRanges();
    attribute.addUpdateRange(0, attribute.itemSize * items);
    attribute.needsUpdate = true;
}
