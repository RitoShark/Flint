import type { MeshGeometry, MeshRange } from '../types';
import { nameHash } from '../../binHash';
function selection(ranges: readonly MeshRange[], hashes: readonly string[]): boolean[] {
    const selected = new Set(hashes);
    return ranges.map(({ name }) => selected.has(nameHash(name)));
}
export function rangesDrawn(ranges: readonly MeshRange[], hidden: readonly string[], draw: readonly string[], always: readonly string[]): boolean[] {
    const requested = selection(ranges, draw);
    const forced = selection(ranges, always);
    const exclusions = new Set(hidden.map(name => name.toLowerCase()));
    const unrestricted = !requested.some(Boolean);
    return ranges.map((range, index) => forced[index] || ((unrestricted || requested[index]) && !exclusions.has(range.name.toLowerCase())));
}
export function drawnIndices(mesh: MeshGeometry, draw: readonly string[], always: readonly string[]): Uint32Array {
    if (!selection(mesh.ranges, draw).some(Boolean)) return mesh.indices;
    const visible = rangesDrawn(mesh.ranges, [], draw, always);
    const parts = mesh.ranges.flatMap((range, index) => visible[index] && range.startIndex >= 0 && range.startIndex + range.indexCount <= mesh.indices.length
        ? [mesh.indices.subarray(range.startIndex, range.startIndex + range.indexCount)] : []);
    const result = new Uint32Array(parts.reduce((size, part) => size + part.length, 0));
    let offset = 0;
    for (const part of parts) { result.set(part, offset); offset += part.length; }
    return result;
}
