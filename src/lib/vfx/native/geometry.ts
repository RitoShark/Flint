import { AttributeData, GeometryData } from './data';
import type { MeshGeometry } from './types';
import type { MeshModel } from '../engine/model/model';
import { drawnIndices } from './utils/submeshes';
export function geometryOf(mesh: MeshGeometry, model: Pick<MeshModel, 'submeshes' | 'submeshesAlways'> & Partial<MeshModel>): GeometryData {
    const geometry = new GeometryData();
    const mirror = (data: Float32Array) => data.map((v, i) => i % 3 === 0 ? -v : v);
    geometry.setAttribute('position', new AttributeData(mirror(mesh.positions), 3));
    geometry.setAttribute('uv', new AttributeData(mesh.uvs ?? new Float32Array(mesh.positions.length / 3 * 2), 2));
    const indices = drawnIndices(mesh, model.submeshes, model.submeshesAlways).slice();
    for (let at = 0; at < indices.length; at += 3)
        [indices[at + 1], indices[at + 2]] = [indices[at + 2], indices[at + 1]];
    geometry.setIndex(indices);
    if (mesh.normals)
        geometry.setAttribute('normal', new AttributeData(mirror(mesh.normals), 3));
    else
        geometry.computeVertexNormals();
    return geometry;
}
