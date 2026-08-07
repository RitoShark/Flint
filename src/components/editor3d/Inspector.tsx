import React from 'react';
import { useModelEditorStore } from '../../lib/stores/modelEditorStore';

/** Quaternion [x,y,z,w] → Euler degrees, YXZ order to match Babylon's display. */
function quatToEulerDegrees(q: [number, number, number, number]): [number, number, number] {
    const [x, y, z, w] = q;
    const sinp = 2 * (w * x - y * z);
    const pitch = Math.abs(sinp) >= 1 ? Math.sign(sinp) * (Math.PI / 2) : Math.asin(sinp);
    const yaw = Math.atan2(2 * (w * y + x * z), 1 - 2 * (x * x + y * y));
    const roll = Math.atan2(2 * (w * z + x * y), 1 - 2 * (x * x + z * z));
    const deg = (r: number) => Number((r * (180 / Math.PI)).toFixed(2));
    return [deg(pitch), deg(yaw), deg(roll)];
}

function fmtVec3(v: [number, number, number]): string {
    return v.map((n) => n.toFixed(3)).join(', ');
}

interface FieldProps {
    label: string;
    value: string;
}

const Field: React.FC<FieldProps> = ({ label, value }) => (
    <div className="m3d__field">
        <span className="m3d__field-label">{label}</span>
        <span className="m3d__field-value">{value}</span>
    </div>
);

export const Inspector: React.FC = () => {
    const selection = useModelEditorStore((s) => s.selection);
    const summary = useModelEditorStore((s) => s.summary);
    const skeleton = useModelEditorStore((s) => s.skeleton);

    if (!selection) {
        return (
            <div className="m3d__inspector">
                <div className="m3d__hint">Select a submesh or joint.</div>
            </div>
        );
    }

    if (selection.kind === 'submesh') {
        const info = summary?.submeshes.find((s) => s.name === selection.name);
        if (!info) {
            return (
                <div className="m3d__inspector">
                    <div className="m3d__hint">Submesh not found.</div>
                </div>
            );
        }
        const triangles = Math.floor(info.indexCount / 3);
        return (
            <div className="m3d__inspector">
                <Field label="Name" value={info.name} />
                {/* A .skn stores only the material name — the material itself lives in the skin BIN. */}
                <Field label="Material" value={info.name} />
                <Field label="Vertices" value={info.vertexCount.toLocaleString()} />
                <Field label="Triangles" value={triangles.toLocaleString()} />
                <Field label="Vertex range" value={`${info.vertexStart}–${info.vertexStart + info.vertexCount - 1}`} />
                <Field label="Index range" value={`${info.indexStart}–${info.indexStart + info.indexCount - 1}`} />
            </div>
        );
    }

    // selection.kind === 'joint'
    if (!skeleton) {
        return (
            <div className="m3d__inspector">
                <div className="m3d__hint">No skeleton loaded.</div>
            </div>
        );
    }
    const bone = skeleton.bones.find((b) => b.id === selection.id);
    if (!bone) {
        return (
            <div className="m3d__inspector">
                <div className="m3d__hint">Joint not found.</div>
            </div>
        );
    }
    const parent = bone.parent_id === -1 ? null : skeleton.bones.find((b) => b.id === bone.parent_id) ?? null;
    const influenceIndex = skeleton.influences.indexOf(bone.id);
    const [pitch, yaw, roll] = quatToEulerDegrees(bone.local_rotation);

    return (
        <div className="m3d__inspector">
            <Field label="Name" value={bone.name} />
            <Field label="ID" value={String(bone.id)} />
            <Field label="Parent" value={bone.parent_id === -1 ? '— (root)' : parent?.name ?? `#${bone.parent_id}`} />
            <Field label="Local translation" value={fmtVec3(bone.local_translation)} />
            <Field label="Local scale" value={fmtVec3(bone.local_scale)} />
            <Field label="Local rotation" value={`${pitch}, ${yaw}, ${roll}`} />
            <Field label="Bind world position" value={fmtVec3(bone.world_position)} />
            <Field label="Influence index" value={influenceIndex >= 0 ? String(influenceIndex) : 'not bound'} />
        </div>
    );
};
