/**
 * Flint - ModelPreview Component
 * 3D preview for SKN mesh files with material visibility controls
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera, Sky } from '@react-three/drei';
import * as THREE from 'three';
import * as api from '../../lib/api';
import type { AnimationPose } from '../../lib/api';
import { useAppMetadataStore } from '../../lib/stores';
import { getIcon } from '../../lib/fileIcons';

// ============================================================================
// Types
// ============================================================================

interface MaterialRange {
    name: string;
    start_index: number;
    index_count: number;
    start_vertex: number;
    vertex_count: number;
}

// Shape now lives in `lib/api.ts` — vertex/index buffers are typed arrays
// straight off the IPC `ArrayBuffer`, no per-vertex JSON.
type SknMeshData = api.SknMeshData;

// Material data with texture and UV transform parameters
interface MaterialData {
    texture: string;           // base64 PNG
    uv_scale?: [number, number];
    uv_offset?: [number, number];
    flipbook_size?: [number, number];
    flipbook_frame?: number;
}

interface BoneData {
    name: string;
    id: number;
    parent_id: number;
    local_translation: [number, number, number];
    local_rotation: [number, number, number, number];
    local_scale: [number, number, number];
    world_position: [number, number, number];
    inverse_bind_matrix: [[number, number, number, number], [number, number, number, number], [number, number, number, number], [number, number, number, number]];
}

interface SklData {
    name: string;
    asset_name: string;
    bones: BoneData[];
    influences: number[];  // Maps vertex bone indices to actual bone IDs
}

type ScbMeshData = api.ScbMeshData;

// Union type for mesh data
type MeshData = SknMeshData | ScbMeshData;

interface ModelPreviewProps {
    filePath: string;
    meshType?: 'skinned' | 'static';  // skinned = SKN, static = SCB/SCO
}

// ============================================================================
// Mesh Component (renders the 3D geometry)
// ============================================================================

interface MeshViewerProps {
    meshData: MeshData;
    visibleMaterials: Set<string>;
    wireframe: boolean;
    skeletonData?: SklData | null;  // For CPU skinning
    animationPose?: AnimationPose | null;  // Current animation pose for skinning
}

// Helper to check if mesh data is SKN type
const isSknMeshDataType = (data: MeshData): data is SknMeshData => data.kind === 'skn';


const MeshViewer: React.FC<MeshViewerProps> = ({ meshData, visibleMaterials, wireframe, skeletonData, animationPose }) => {
    const { camera } = useThree();
    const groupRef = useRef<THREE.Group>(null);
    const meshRefs = useRef<Map<string, THREE.Mesh>>(new Map());

    // Riot's ELF hash variant - used for bone/joint name hashing
    const elfHash = (name: string): number => {
        let hash = 0;
        const lowerName = name.toLowerCase();
        for (let i = 0; i < lowerName.length; i++) {
            hash = ((hash << 4) + lowerName.charCodeAt(i)) >>> 0;
            const high = hash & 0xF0000000;
            if (high !== 0) {
                hash ^= high >>> 24;
            }
            hash &= ~high;
        }
        return hash >>> 0;
    };



    // Compute bone transform matrices from animation pose
    // IMPORTANT: bone_indices in mesh refer to array index, NOT bone.id!
    const boneMatrices = useMemo(() => {
        if (!skeletonData) return null;

        const matrices: THREE.Matrix4[] = [];
        const worldTransforms = new Map<number, THREE.Matrix4>();

        // Build a map from bone ID to array index
        // Mesh bone_indices reference array positions, not bone IDs
        const idToIndex = new Map<number, number>();
        skeletonData.bones.forEach((bone, index) => {
            idToIndex.set(bone.id, index);
        });

        // Sort bones by ID to ensure parents are processed before children
        const sortedBones = [...skeletonData.bones].sort((a, b) => a.id - b.id);

        sortedBones.forEach(bone => {
            const localMatrix = new THREE.Matrix4();

            if (animationPose && Object.keys(animationPose.joints).length > 0) {
                // Get animation transform for this bone by hash
                const boneHash = elfHash(bone.name);
                const animTransform = animationPose.joints[boneHash];

                if (animTransform) {
                    const rotation = new THREE.Quaternion(
                        animTransform.rotation[0],
                        animTransform.rotation[1],
                        animTransform.rotation[2],
                        animTransform.rotation[3]
                    );
                    const translation = new THREE.Vector3(
                        animTransform.translation[0],
                        animTransform.translation[1],
                        animTransform.translation[2]
                    );
                    const scale = new THREE.Vector3(
                        animTransform.scale[0],
                        animTransform.scale[1],
                        animTransform.scale[2]
                    );
                    localMatrix.compose(translation, rotation, scale);
                } else {
                    // Use bind pose
                    const rotation = new THREE.Quaternion(
                        bone.local_rotation[0],
                        bone.local_rotation[1],
                        bone.local_rotation[2],
                        bone.local_rotation[3]
                    );
                    const translation = new THREE.Vector3(
                        bone.local_translation[0],
                        bone.local_translation[1],
                        bone.local_translation[2]
                    );
                    const scale = new THREE.Vector3(
                        bone.local_scale[0],
                        bone.local_scale[1],
                        bone.local_scale[2]
                    );
                    localMatrix.compose(translation, rotation, scale);
                }
            } else {
                // Use bind pose
                const rotation = new THREE.Quaternion(
                    bone.local_rotation[0],
                    bone.local_rotation[1],
                    bone.local_rotation[2],
                    bone.local_rotation[3]
                );
                const translation = new THREE.Vector3(
                    bone.local_translation[0],
                    bone.local_translation[1],
                    bone.local_translation[2]
                );
                const scale = new THREE.Vector3(
                    bone.local_scale[0],
                    bone.local_scale[1],
                    bone.local_scale[2]
                );
                localMatrix.compose(translation, rotation, scale);
            }

            // Compute world transform
            let worldMatrix: THREE.Matrix4;
            if (bone.parent_id >= 0 && worldTransforms.has(bone.parent_id)) {
                const parentWorld = worldTransforms.get(bone.parent_id)!;
                worldMatrix = new THREE.Matrix4().multiplyMatrices(parentWorld, localMatrix);
            } else {
                worldMatrix = localMatrix.clone();
            }
            worldTransforms.set(bone.id, worldMatrix);

            // Compute final skinning matrix: world * inverse_bind
            // Create inverse bind matrix from the stored column-major array
            const invBind = bone.inverse_bind_matrix;
            const invBindMatrix = new THREE.Matrix4().set(
                invBind[0][0], invBind[1][0], invBind[2][0], invBind[3][0],
                invBind[0][1], invBind[1][1], invBind[2][1], invBind[3][1],
                invBind[0][2], invBind[1][2], invBind[2][2], invBind[3][2],
                invBind[0][3], invBind[1][3], invBind[2][3], invBind[3][3]
            );

            const skinMatrix = new THREE.Matrix4().multiplyMatrices(worldMatrix, invBindMatrix);

            // Store by array index, NOT bone.id - mesh bone_indices are array positions
            const arrayIndex = idToIndex.get(bone.id)!;
            matrices[arrayIndex] = skinMatrix;
        });

        return matrices;
    }, [skeletonData, animationPose]);

    // Apply skinning to vertex positions. Operates directly on the
    // `Float32Array` / `Uint16Array` buffers that came off IPC — no per-vertex
    // tuple allocations, no `[number, number, number]` indirection. Reuses a
    // single `THREE.Vector3` per loop iteration to keep GC pressure flat.
    const applySkinnedPositions = (
        positions: Float32Array,
        indices: Uint16Array,
        startIdx: number,
        count: number,
    ): Float32Array => {
        const out = new Float32Array(count * 3);
        const sknData = meshData as SknMeshData;
        const weights = sknData.bone_weights;
        const boneIdxArr = sknData.bone_indices;
        const influences = skeletonData?.influences;

        const boneIdToArrayIndex = new Map<number, number>();
        if (skeletonData) {
            skeletonData.bones.forEach((bone, index) => {
                boneIdToArrayIndex.set(bone.id, index);
            });
        }

        const original = new THREE.Vector3();
        const skinned = new THREE.Vector3();
        const transformed = new THREE.Vector3();

        for (let i = 0; i < count; i++) {
            const vertexIdx = indices[startIdx + i];
            const px = positions[vertexIdx * 3];
            const py = positions[vertexIdx * 3 + 1];
            const pz = positions[vertexIdx * 3 + 2];

            if (boneMatrices && weights && boneIdxArr && influences) {
                skinned.set(0, 0, 0);
                let totalWeight = 0;
                const wBase = vertexIdx * 4;

                for (let j = 0; j < 4; j++) {
                    const weight = weights[wBase + j];
                    if (weight <= 0.0001) continue;
                    const influenceIdx = boneIdxArr[wBase + j];
                    const boneId = influences[influenceIdx];
                    const boneArrayIndex = boneIdToArrayIndex.get(boneId) ?? influenceIdx;
                    const matrix = boneMatrices[boneArrayIndex];
                    if (!matrix) continue;
                    original.set(px, py, pz);
                    transformed.copy(original).applyMatrix4(matrix);
                    skinned.addScaledVector(transformed, weight);
                    totalWeight += weight;
                }

                if (totalWeight > 0.0001) {
                    if (Math.abs(totalWeight - 1.0) > 0.01) skinned.divideScalar(totalWeight);
                    out[i * 3] = skinned.x;
                    out[i * 3 + 1] = skinned.y;
                    out[i * 3 + 2] = skinned.z;
                    continue;
                }
            }

            out[i * 3] = px;
            out[i * 3 + 1] = py;
            out[i * 3 + 2] = pz;
        }

        return out;
    };

    // Create base geometries with skinning data (non-indexed for proper UV mapping)
    const materialGeometries = useMemo(() => {
        const geometries: Map<string, { geo: THREE.BufferGeometry; startIdx: number; count: number }> = new Map();

        if (isSknMeshDataType(meshData)) {
            const positions = meshData.positions;
            const normals = meshData.normals;
            const uvs = meshData.uvs;
            const indices = meshData.indices;

            meshData.materials.forEach((mat) => {
                const geo = new THREE.BufferGeometry();
                const startIdx = mat.start_index;
                const count = mat.index_count;

                // Build per-material non-indexed buffers. Each output triangle
                // pulls its vertex straight from the SKN's typed array — no
                // tuple objects, no nested `.flat()`, just memcpy + indexed
                // reads off the source buffer.
                const outPos = new Float32Array(count * 3);
                const outNrm = new Float32Array(count * 3);
                const outUv = new Float32Array(count * 2);

                for (let i = 0; i < count; i++) {
                    const idx = indices[startIdx + i];
                    const p = idx * 3;
                    const u = idx * 2;
                    const o3 = i * 3;
                    const o2 = i * 2;
                    outPos[o3] = positions[p];
                    outPos[o3 + 1] = positions[p + 1];
                    outPos[o3 + 2] = positions[p + 2];
                    outNrm[o3] = normals[p];
                    outNrm[o3 + 1] = normals[p + 1];
                    outNrm[o3 + 2] = normals[p + 2];
                    outUv[o2] = uvs[u];
                    outUv[o2 + 1] = uvs[u + 1];
                }

                geo.setAttribute('position', new THREE.BufferAttribute(outPos, 3));
                geo.setAttribute('normal', new THREE.BufferAttribute(outNrm, 3));
                geo.setAttribute('uv', new THREE.BufferAttribute(outUv, 2));

                geometries.set(mat.name, { geo, startIdx, count });
            });
        } else {
            const scbData = meshData as ScbMeshData;
            const geo = new THREE.BufferGeometry();

            // Three.js consumes the typed arrays straight off IPC — no copy.
            geo.setAttribute('position', new THREE.BufferAttribute(scbData.positions, 3));
            geo.setAttribute('normal', new THREE.BufferAttribute(scbData.normals, 3));
            geo.setAttribute('uv', new THREE.BufferAttribute(scbData.uvs, 2));
            geo.setIndex(new THREE.BufferAttribute(scbData.indices, 1));

            const matKey = scbData.materials[0] || 'default';
            geometries.set(matKey, { geo, startIdx: 0, count: scbData.indices.length });
        }

        return geometries;
    }, [meshData]);

    // Dispose geometries on unmount to free GPU memory
    useEffect(() => {
        return () => {
            materialGeometries.forEach(({ geo }) => geo.dispose());
        };
    }, [materialGeometries]);

    // Update positions when animation pose changes
    useEffect(() => {
        if (!isSknMeshDataType(meshData) || !boneMatrices) return;

        materialGeometries.forEach(({ geo, startIdx, count }, _matName) => {
            const skinnedPositions = applySkinnedPositions(
                meshData.positions,
                meshData.indices,
                startIdx,
                count
            );

            const positionAttribute = geo.getAttribute('position') as THREE.BufferAttribute;
            positionAttribute.array.set(skinnedPositions);
            positionAttribute.needsUpdate = true;
            geo.computeBoundingSphere();
        });
    }, [animationPose, boneMatrices, meshData, materialGeometries]);

    // Create material groups for visibility control
    const materialGroups = useMemo(() => {
        if (isSknMeshDataType(meshData)) {
            return meshData.materials.map((mat, index) => ({
                name: mat.name,
                visible: visibleMaterials.has(mat.name),
                color: new THREE.Color().setHSL((index * 0.618033988749895) % 1, 0.7, 0.5),
            }));
        } else {
            const scbData = meshData as ScbMeshData;
            const matName = scbData.materials[0] || 'default';
            return [{
                name: matName,
                visible: visibleMaterials.has(matName),
                color: new THREE.Color().setHSL(0.5, 0.7, 0.5),
            }];
        }
    }, [meshData, visibleMaterials]);

    // Load textures from the backend-provided material_data (with UV transforms)
    // Works for both SKN and SCB mesh data
    const textureCache = useMemo(() => {
        const cache = new Map<string, THREE.Texture>();

        // Get material_data from either SKN or SCB mesh data
        const matData: Record<string, MaterialData> | undefined =
            isSknMeshDataType(meshData)
                ? meshData.material_data
                : (meshData as ScbMeshData).material_data;

        if (matData && Object.keys(matData).length > 0) {
            for (const [materialName, data] of Object.entries(matData)) {
                try {
                    const dataUrl = `data:image/png;base64,${data.texture}`;

                    // Create texture and configure it BEFORE loading
                    const texture = new THREE.Texture();
                    texture.flipY = false;
                    texture.colorSpace = THREE.SRGBColorSpace;
                    texture.wrapS = THREE.RepeatWrapping;
                    texture.wrapT = THREE.RepeatWrapping;

                    // Apply UV transformations from material properties
                    if (data.uv_scale) {
                        texture.repeat.set(data.uv_scale[0], data.uv_scale[1]);
                    }

                    if (data.uv_offset) {
                        texture.offset.set(data.uv_offset[0], data.uv_offset[1]);
                    }

                    // Handle flipbook materials
                    if (data.flipbook_size) {
                        const [cols, rows] = data.flipbook_size;
                        const frame = data.flipbook_frame || 0;
                        const col = Math.floor(frame % cols);
                        const row = Math.floor(frame / cols);
                        texture.repeat.set(1 / cols, 1 / rows);
                        texture.offset.set(col / cols, 1 - (row + 1) / rows);
                    }

                    // Load image asynchronously and update texture when ready
                    const image = new Image();
                    image.onload = () => {
                        texture.image = image;
                        texture.needsUpdate = true;
                    };
                    image.src = dataUrl;

                    cache.set(materialName, texture);
                } catch {
                    // Texture decode failed - material will show as magenta
                }
            }
        } else if (isSknMeshDataType(meshData) && meshData.textures) {
            // Fallback to deprecated textures field for backward compatibility
            for (const [materialName, base64Data] of Object.entries(meshData.textures)) {
                try {
                    const dataUrl = `data:image/png;base64,${base64Data}`;

                    const texture = new THREE.Texture();
                    texture.flipY = false;
                    texture.colorSpace = THREE.SRGBColorSpace;
                    texture.wrapS = THREE.RepeatWrapping;
                    texture.wrapT = THREE.RepeatWrapping;

                    const image = new Image();
                    image.onload = () => {
                        texture.image = image;
                        texture.needsUpdate = true;
                    };
                    image.src = dataUrl;

                    cache.set(materialName, texture);
                } catch {
                    // Texture decode failed
                }
            }
        }

        return cache;
    }, [meshData]);

    // Dispose textures on unmount/change to free GPU memory
    useEffect(() => {
        return () => {
            textureCache.forEach(texture => texture.dispose());
        };
    }, [textureCache]);

    // Memoized texture lookup with fuzzy matching (mirrors backend strategies)
    const materialTextureMap = useMemo(() => {
        const map = new Map<string, THREE.Texture>();
        const materialNames = isSknMeshDataType(meshData)
            ? meshData.materials.map(m => m.name)
            : [meshData.materials[0] || 'default'];

        for (const name of materialNames) {
            // Direct lookup
            let texture = textureCache.get(name);
            // Try stripping "mesh_" prefix
            if (!texture && name.startsWith("mesh_")) {
                texture = textureCache.get(name.substring(5));
            }
            // Try adding "mesh_" prefix
            if (!texture) {
                texture = textureCache.get(`mesh_${name}`);
            }
            // Case-insensitive fallback
            if (!texture) {
                const lower = name.toLowerCase();
                for (const [key, tex] of textureCache) {
                    if (key.toLowerCase() === lower) {
                        texture = tex;
                        break;
                    }
                }
            }
            if (texture) map.set(name, texture);
        }
        return map;
    }, [meshData, textureCache]);

    // Center camera on mesh (use natural bounding-box center so parts below Y=0 stay below the grid)
    useEffect(() => {
        const [[minX, minY, minZ], [maxX, maxY, maxZ]] = meshData.bounding_box;
        const center = new THREE.Vector3(
            (minX + maxX) / 2,
            (minY + maxY) / 2,
            (minZ + maxZ) / 2
        );
        const size = Math.max(maxX - minX, maxY - minY, maxZ - minZ);

        if (camera instanceof THREE.PerspectiveCamera) {
            camera.position.set(center.x, center.y, center.z + size * 2);
            camera.lookAt(center);
        }
    }, [meshData.bounding_box, camera]);

    return (
        <group ref={groupRef}>
            {materialGroups.map((mat, index) => {
                if (!mat.visible) return null;

                const geoData = materialGeometries.get(mat.name);
                if (!geoData) return null;

                const matchedTexture = materialTextureMap.get(mat.name) || null;

                return (
                    <mesh
                        key={mat.name || index}
                        geometry={geoData.geo}
                        ref={(mesh) => { if (mesh) meshRefs.current.set(mat.name, mesh); }}
                    >
                        <meshStandardMaterial
                            map={matchedTexture || null}
                            // Use magenta for missing textures to make them obvious
                            color={matchedTexture ? 0xffffff : 0xff00ff}
                            wireframe={wireframe}
                            side={THREE.DoubleSide}
                            flatShading={false}
                        />
                    </mesh>
                );
            })}
        </group>
    );
};


// ============================================================================
// Textured Floor Component (loads actual MindCorpViewer floor.dds)
// ============================================================================

const TexturedFloor: React.FC = () => {
    const [floorTexture, setFloorTexture] = useState<THREE.Texture | null>(null);
    const [loading, setLoading] = useState(true);

    useEffect(() => {
        let isMounted = true;
        let texture: THREE.Texture | null = null;
        let objectUrl: string | null = null;

        const loadFloorTexture = async () => {
            try {
                // Load bundled floor as PNG bytes (pre-converted from DDS)
                const pngBytes = await api.getBundledFloorPng();

                if (!isMounted) return;

                // Create Blob from PNG bytes
                const blob = new Blob([new Uint8Array(pngBytes)], { type: 'image/png' });
                objectUrl = URL.createObjectURL(blob);

                // Create texture from Blob URL
                const image = new Image();
                image.onload = () => {
                    if (!isMounted) return;
                    texture = new THREE.Texture(image);
                    texture.wrapS = THREE.ClampToEdgeWrapping;
                    texture.wrapT = THREE.ClampToEdgeWrapping;
                    texture.colorSpace = THREE.SRGBColorSpace;
                    texture.needsUpdate = true;
                    setFloorTexture(texture);
                    setLoading(false);
                };
                image.onerror = () => {
                    console.error('Failed to load decoded floor texture');
                    setLoading(false);
                };
                image.src = objectUrl;
            } catch (err) {
                console.error('Error loading floor texture:', err);
                setLoading(false);
            }
        };

        loadFloorTexture();

        return () => {
            isMounted = false;
            if (texture) {
                texture.dispose();
            }
            if (objectUrl) {
                URL.revokeObjectURL(objectUrl);
            }
        };
    }, []);

    if (loading || !floorTexture) {
        return null;
    }

    return (
        <mesh position={[0, 0, 0]} rotation={[-Math.PI / 2, 0, 0]} receiveShadow>
            <planeGeometry args={[1500, 1500]} />
            <meshStandardMaterial
                map={floorTexture}
                roughness={0.9}
                metalness={0.1}
            />
        </mesh>
    );
};

// ============================================================================
// Skeleton Viewer Component (renders bone lines)
// ============================================================================

interface SkeletonViewerProps {
    skeletonData: SklData;
    animationPose?: AnimationPose | null;
}

const SkeletonViewer: React.FC<SkeletonViewerProps> = ({ skeletonData, animationPose }) => {
    // Riot's ELF hash variant - used for bone/joint name hashing in League files
    const elfHash = (name: string): number => {
        let hash = 0;
        const lowerName = name.toLowerCase();
        for (let i = 0; i < lowerName.length; i++) {
            hash = ((hash << 4) + lowerName.charCodeAt(i)) >>> 0;
            const high = hash & 0xF0000000;
            if (high !== 0) {
                hash ^= high >>> 24;
            }
            hash &= ~high;
        }
        return hash >>> 0; // unsigned 32-bit
    };

    // Build a map from bone id to its name hash for quick lookup
    const boneIdToHash = useMemo(() => {
        const map = new Map<number, number>();
        skeletonData.bones.forEach(bone => {
            const hash = elfHash(bone.name);
            map.set(bone.id, hash);
        });

        return map;
    }, [skeletonData]);

    // Compute bone positions - use animation pose if available, otherwise bind pose
    const bonePositions = useMemo(() => {
        const positions: Record<number, THREE.Vector3> = {};

        if (animationPose && Object.keys(animationPose.joints).length > 0) {
            // Build hierarchy of animated transforms
            const worldTransforms = new Map<number, THREE.Matrix4>();

            // Sort bones by parent dependency (parents before children)
            const sortedBones = [...skeletonData.bones].sort((a, b) => a.id - b.id);

            sortedBones.forEach(bone => {
                const localMatrix = new THREE.Matrix4();

                // Get the hash for this bone and look up animation transform
                const boneHash = boneIdToHash.get(bone.id);
                const animTransform = boneHash !== undefined ? animationPose.joints[boneHash] : undefined;

                if (animTransform) {
                    // Use animation transform
                    const rotation = new THREE.Quaternion(
                        animTransform.rotation[0],
                        animTransform.rotation[1],
                        animTransform.rotation[2],
                        animTransform.rotation[3]
                    );
                    const translation = new THREE.Vector3(
                        animTransform.translation[0],
                        animTransform.translation[1],
                        animTransform.translation[2]
                    );
                    const scale = new THREE.Vector3(
                        animTransform.scale[0],
                        animTransform.scale[1],
                        animTransform.scale[2]
                    );
                    localMatrix.compose(translation, rotation, scale);
                } else {
                    // Use bind pose local transform
                    const rotation = new THREE.Quaternion(
                        bone.local_rotation[0],
                        bone.local_rotation[1],
                        bone.local_rotation[2],
                        bone.local_rotation[3]
                    );
                    const translation = new THREE.Vector3(
                        bone.local_translation[0],
                        bone.local_translation[1],
                        bone.local_translation[2]
                    );
                    const scale = new THREE.Vector3(
                        bone.local_scale[0],
                        bone.local_scale[1],
                        bone.local_scale[2]
                    );
                    localMatrix.compose(translation, rotation, scale);
                }

                // Multiply by parent world transform
                if (bone.parent_id >= 0 && worldTransforms.has(bone.parent_id)) {
                    const parentWorld = worldTransforms.get(bone.parent_id)!;
                    const worldMatrix = new THREE.Matrix4().multiplyMatrices(parentWorld, localMatrix);
                    worldTransforms.set(bone.id, worldMatrix);
                } else {
                    worldTransforms.set(bone.id, localMatrix);
                }

                // Extract position from world transform
                const worldMatrix = worldTransforms.get(bone.id)!;
                const pos = new THREE.Vector3();
                pos.setFromMatrixPosition(worldMatrix);
                positions[bone.id] = pos;
            });
        } else {
            // Use bind pose world positions
            skeletonData.bones.forEach(bone => {
                positions[bone.id] = new THREE.Vector3(
                    bone.world_position[0],
                    bone.world_position[1],
                    bone.world_position[2]
                );
            });
        }

        return positions;
    }, [skeletonData, animationPose, boneIdToHash]);

    // Create line segments for bone connections
    const linePoints = useMemo(() => {
        const points: THREE.Vector3[] = [];

        skeletonData.bones.forEach(bone => {
            if (bone.parent_id >= 0) {
                const childPos = bonePositions[bone.id];
                const parentPos = bonePositions[bone.parent_id];
                if (childPos && parentPos) {
                    points.push(parentPos, childPos);
                }
            }
        });

        return points;
    }, [skeletonData, bonePositions]);

    // Create joint spheres
    const jointPositions = useMemo(() => {
        return Object.values(bonePositions);
    }, [bonePositions]);

    return (
        <group key={animationPose?.time ?? 'bind'}>
            {/* Bone lines */}
            {linePoints.length > 0 && (
                <lineSegments>
                    <bufferGeometry>
                        <bufferAttribute
                            attach="attributes-position"
                            count={linePoints.length}
                            array={new Float32Array(linePoints.flatMap(p => [p.x, p.y, p.z]))}
                            itemSize={3}
                        />
                    </bufferGeometry>
                    <lineBasicMaterial color="#00ff00" linewidth={2} />
                </lineSegments>
            )}

            {/* Joint spheres */}
            {jointPositions.map((pos, i) => (
                <mesh key={i} position={[pos.x, pos.y, pos.z]}>
                    <sphereGeometry args={[0.02, 8, 8]} />
                    <meshBasicMaterial color="#ff0000" />
                </mesh>
            ))}
        </group>
    );
};

// ============================================================================
// Main Component
// ============================================================================

// Settings persistence key
const SETTINGS_KEY = 'flint-model-preview-settings';

// Load settings from localStorage
const loadSettings = () => {
    try {
        const saved = localStorage.getItem(SETTINGS_KEY);
        if (saved) {
            return JSON.parse(saved);
        }
    } catch {
        // Ignore parse errors
    }
    return {
        wireframe: false,
        showSkybox: true,
        floorMode: 'grid',
        ambientIntensity: 0.8,
        directionalIntensity: 1.5,
        showSkeleton: true,
    };
};

export const ModelPreview: React.FC<ModelPreviewProps> = ({ filePath, meshType = 'skinned' }) => {
    const [meshData, setMeshData] = useState<MeshData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);

    // Load persisted settings
    const savedSettings = useMemo(() => loadSettings(), []);
    const [wireframe, setWireframe] = useState(savedSettings.wireframe);
    const [visibleMaterials, setVisibleMaterials] = useState<Set<string>>(new Set());

    // Environment controls (persisted)
    const [showSkybox, setShowSkybox] = useState(savedSettings.showSkybox);
    const [floorMode, setFloorMode] = useState<'grid' | 'textured' | 'none'>(savedSettings.floorMode);
    const [ambientIntensity, setAmbientIntensity] = useState(savedSettings.ambientIntensity);
    const [directionalIntensity, setDirectionalIntensity] = useState(savedSettings.directionalIntensity);

    // Popup states for controls
    const [activePopup, setActivePopup] = useState<'display' | 'environment' | 'materials' | 'animations' | null>(null);

    // Subscribe to file version changes for hot reload — see ImagePreview.
    const fileVersion = useAppMetadataStore((state) => {
        void state.fileVersionsRev;
        return state.getFileVersion(filePath);
    });

    // Animation state (only for skinned meshes)
    const [animations, setAnimations] = useState<{ name: string; animation_path: string }[]>([]);
    const [selectedAnimation, setSelectedAnimation] = useState<string>('');
    const [isPlaying, setIsPlaying] = useState(false);

    // Animation playback state
    const [animationData, setAnimationData] = useState<{ duration: number; fps: number; joint_count: number; joint_hashes: number[] } | null>(null);
    const [currentTime, setCurrentTime] = useState(0);
    const [currentPose, setCurrentPose] = useState<AnimationPose | null>(null);
    const animationRef = useRef<number | null>(null);
    const lastFrameTimeRef = useRef<number>(0);

    // Skeleton state (only for skinned meshes, persisted)
    const [skeletonData, setSkeletonData] = useState<SklData | null>(null);
    const [showSkeleton, setShowSkeleton] = useState(savedSettings.showSkeleton);

    // Texture preview state
    const [hoveredMaterial, setHoveredMaterial] = useState<string | null>(null);
    const [previewPosition, setPreviewPosition] = useState<{ x: number; y: number }>({ x: 0, y: 0 });

    // Helper to check if mesh data is SKN type
    const isSknMeshData = (data: MeshData): data is SknMeshData => {
        return Array.isArray((data as SknMeshData).materials) &&
            typeof (data as SknMeshData).materials[0] === 'object';
    };

    // Clean up animation on unmount to prevent leaked RAF
    useEffect(() => {
        return () => {
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
                animationRef.current = null;
            }
        };
    }, []);

    // Track our canvas for cleanup
    const canvasRef = useRef<HTMLCanvasElement | null>(null);

    // Clean up WebGL context and event listeners on unmount
    useEffect(() => {
        return () => {
            const canvas = canvasRef.current;
            if (canvas && (canvas as any)._flintCleanup) {
                try {
                    (canvas as any)._flintCleanup();
                    delete (canvas as any)._flintCleanup;
                } catch (_e) {
                    // Ignore errors during cleanup
                }
            }
            canvasRef.current = null;
        };
    }, []);

    // Load mesh data
    useEffect(() => {
        let cancelled = false;

        const loadMesh = async () => {
            setLoading(true);
            setError(null);
            setAnimations([]);
            setSkeletonData(null);

            try {
                let data: MeshData;

                if (meshType === 'static') {
                    // Load SCB/SCO static mesh
                    data = await api.readScbMesh(filePath);
                } else {
                    // Load SKN skinned mesh AND skeleton/animations in parallel
                    // This significantly reduces loading time by parallelizing independent requests
                    const sklPath = filePath.replace(/\.skn$/i, '.skl');

                    const [meshResult, animResult, sklResult] = await Promise.allSettled([
                        api.readSknMesh(filePath),
                        api.readAnimationList(filePath),
                        api.readSklSkeleton(sklPath)
                    ]);

                    // Handle mesh result (required)
                    if (meshResult.status === 'fulfilled') {
                        data = meshResult.value;
                    } else {
                        throw meshResult.reason;
                    }

                    if (cancelled) return;

                    // Handle animation result (optional)
                    if (animResult.status === 'fulfilled') {
                        const animList = animResult.value;
                        if (animList.clips && animList.clips.length > 0) {
                            setAnimations(animList.clips);
                        }
                    }

                    // Handle skeleton result (optional)
                    if (sklResult.status === 'fulfilled') {
                        setSkeletonData(sklResult.value);
                    }
                }

                if (cancelled) return;

                // Set mesh data and visible materials (for both static and skinned meshes)
                setMeshData(data);

                // Initialize all materials as visible
                if (isSknMeshData(data)) {
                    setVisibleMaterials(new Set(data.materials.map((m: MaterialRange) => m.name)));
                } else {
                    setVisibleMaterials(new Set(data.materials));
                }
            } catch (err) {
                if (cancelled) return;
                setError((err as Error).message || 'Failed to load mesh');
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        loadMesh();
        return () => { cancelled = true; };
    }, [filePath, meshType, fileVersion]); // Re-run when file version changes (hot reload)

    // Load animation when selection changes
    useEffect(() => {
        if (!selectedAnimation) {
            setAnimationData(null);
            setCurrentTime(0);
            setCurrentPose(null);
            return;
        }

        const loadAnimation = async () => {
            try {
                const animData = await api.readAnimation(selectedAnimation, filePath);
                setAnimationData(animData);
                setCurrentTime(0);
            } catch {
                setAnimationData(null);
            }
        };

        loadAnimation();
    }, [selectedAnimation, filePath]);

    // Animation playback loop
    useEffect(() => {
        if (!isPlaying || !animationData) {
            lastFrameTimeRef.current = 0;
            return;
        }

        const animate = (timestamp: number) => {
            if (!lastFrameTimeRef.current) lastFrameTimeRef.current = timestamp;

            const deltaTime = (timestamp - lastFrameTimeRef.current) / 1000;
            lastFrameTimeRef.current = timestamp;

            setCurrentTime(prev => {
                const newTime = prev + deltaTime;
                return newTime >= animationData.duration ? 0 : newTime;
            });

            animationRef.current = requestAnimationFrame(animate);
        };

        animationRef.current = requestAnimationFrame(animate);

        return () => {
            if (animationRef.current) {
                cancelAnimationFrame(animationRef.current);
                animationRef.current = null;
            }
        };
    }, [isPlaying, animationData]);

    // Evaluate animation at current time (throttled to avoid IPC spam)
    const lastEvalTimeRef = useRef<number>(0);
    const pendingEvalRef = useRef<number | null>(null);

    useEffect(() => {
        if (!selectedAnimation || !animationData) return;

        // Throttle: only evaluate every ~33ms (30fps) to avoid IPC overload
        const now = performance.now();
        const elapsed = now - lastEvalTimeRef.current;

        if (elapsed < 33) {
            // Schedule evaluation after remaining throttle time
            if (pendingEvalRef.current) cancelAnimationFrame(pendingEvalRef.current);
            pendingEvalRef.current = requestAnimationFrame(() => {
                pendingEvalRef.current = null;
                lastEvalTimeRef.current = performance.now();
                api.evaluateAnimation(selectedAnimation, filePath, currentTime)
                    .then(pose => setCurrentPose(pose))
                    .catch(() => {});
            });
            return;
        }

        lastEvalTimeRef.current = now;
        let cancelled = false;

        api.evaluateAnimation(selectedAnimation, filePath, currentTime)
            .then(pose => { if (!cancelled) setCurrentPose(pose); })
            .catch(() => {});

        return () => {
            cancelled = true;
            if (pendingEvalRef.current) {
                cancelAnimationFrame(pendingEvalRef.current);
                pendingEvalRef.current = null;
            }
        };
    }, [selectedAnimation, currentTime, filePath, animationData]);

    // Close popup when clicking outside (MUST be before early returns to satisfy Rules of Hooks)
    useEffect(() => {
        if (!activePopup) return;

        const handleClickOutside = (e: MouseEvent) => {
            const target = e.target as HTMLElement;
            if (!target.closest('.model-preview__popup') && !target.closest('.model-preview__control-btn')) {
                setActivePopup(null);
            }
        };

        document.addEventListener('mousedown', handleClickOutside);
        return () => document.removeEventListener('mousedown', handleClickOutside);
    }, [activePopup]);

    // Persist settings to localStorage when they change
    useEffect(() => {
        const settings = {
            wireframe,
            showSkybox,
            floorMode,
            ambientIntensity,
            directionalIntensity,
            showSkeleton,
        };
        localStorage.setItem(SETTINGS_KEY, JSON.stringify(settings));
    }, [wireframe, showSkybox, floorMode, ambientIntensity, directionalIntensity, showSkeleton]);

    // Toggle material visibility
    const toggleMaterial = (name: string) => {
        setVisibleMaterials(prev => {
            const next = new Set(prev);
            if (next.has(name)) {
                next.delete(name);
            } else {
                next.add(name);
            }
            return next;
        });
    };

    // Toggle all materials
    const toggleAllMaterials = (visible: boolean) => {
        if (visible && meshData) {
            if (isSknMeshData(meshData)) {
                setVisibleMaterials(new Set(meshData.materials.map(m => m.name)));
            } else {
                setVisibleMaterials(new Set(meshData.materials));
            }
        } else {
            setVisibleMaterials(new Set());
        }
    };

    if (loading) {
        return (
            <div className="model-preview model-preview--loading">
                <div className="spinner" />
                <span>Loading 3D model...</span>
            </div>
        );
    }

    if (error) {
        return (
            <div className="model-preview model-preview--error">
                <span className="error-icon">⚠️</span>
                <span>{error}</span>
            </div>
        );
    }

    if (!meshData) {
        return (
            <div className="model-preview model-preview--empty">
                <span>No mesh data available</span>
            </div>
        );
    }

    return (
        <div className="model-preview">
            {/* Environment Button - Top Left Corner */}
            <div className="model-preview__controls-bar model-preview__controls-bar--left">
                <button
                    className={`model-preview__control-btn ${activePopup === 'environment' ? 'model-preview__control-btn--active' : ''}`}
                    onClick={() => setActivePopup(activePopup === 'environment' ? null : 'environment')}
                    title="Environment Settings"
                >
                    <span dangerouslySetInnerHTML={{ __html: getIcon('settings') }} />
                </button>
            </div>

            {/* Other Control Buttons - Top Right */}
            <div className="model-preview__controls-bar">
                <button
                    className={`model-preview__control-btn ${activePopup === 'display' ? 'model-preview__control-btn--active' : ''}`}
                    onClick={() => setActivePopup(activePopup === 'display' ? null : 'display')}
                    title="Display & Skeleton"
                >
                    <span dangerouslySetInnerHTML={{ __html: getIcon('image') }} />
                </button>
                <button
                    className={`model-preview__control-btn ${activePopup === 'materials' ? 'model-preview__control-btn--active' : ''}`}
                    onClick={() => setActivePopup(activePopup === 'materials' ? null : 'materials')}
                    title="Materials"
                >
                    <span dangerouslySetInnerHTML={{ __html: getIcon('picture') }} />
                </button>
                {animations.length > 0 && (
                    <button
                        className={`model-preview__control-btn ${activePopup === 'animations' ? 'model-preview__control-btn--active' : ''}`}
                        onClick={() => setActivePopup(activePopup === 'animations' ? null : 'animations')}
                        title="Animations"
                    >
                        <span dangerouslySetInnerHTML={{ __html: getIcon('video') }} />
                    </button>
                )}
            </div>

            {/* 3D Canvas */}
            <div className="model-preview__canvas">
                <Canvas
                    key={filePath} // Force unmount/remount on file change
                    onCreated={({ gl, scene, invalidate }) => {
                        const canvas = gl.domElement;
                        canvasRef.current = canvas;

                        const handleContextLost = (e: Event) => {
                            e.preventDefault();
                        };
                        const handleContextRestored = () => {
                            gl.clear();
                            invalidate();
                        };
                        canvas.addEventListener('webglcontextlost', handleContextLost);
                        canvas.addEventListener('webglcontextrestored', handleContextRestored);

                        // Store cleanup on the canvas. On unmount we explicitly
                        // dispose the renderer and all scene resources so the GPU
                        // context is released synchronously — prevents "Context Lost"
                        // when the next preview component mounts.
                        (canvas as any)._flintCleanup = () => {
                            canvas.removeEventListener('webglcontextlost', handleContextLost);
                            canvas.removeEventListener('webglcontextrestored', handleContextRestored);

                            // Traverse scene and dispose all GPU resources
                            scene.traverse((obj) => {
                                if (obj instanceof THREE.Mesh) {
                                    obj.geometry?.dispose();
                                    const mats = Array.isArray(obj.material) ? obj.material : [obj.material];
                                    mats.forEach((mat) => {
                                        if (mat) {
                                            Object.values(mat).forEach((val) => {
                                                if (val instanceof THREE.Texture) val.dispose();
                                            });
                                            mat.dispose();
                                        }
                                    });
                                }
                            });

                            gl.renderLists.dispose();
                            gl.dispose();
                        };
                    }}
                >
                    <PerspectiveCamera makeDefault fov={50} position={[0, 0, 5]} />

                    {/* Skybox - rendered as background */}
                    {showSkybox && (
                        <Sky
                            distance={450000}
                            sunPosition={[100, 20, 100]}
                            inclination={0.6}
                            azimuth={0.25}
                            mieCoefficient={0.005}
                            mieDirectionalG={0.8}
                            rayleigh={0.5}
                        />
                    )}

                    {/* Enhanced lighting setup - adjustable via controls */}
                    <ambientLight intensity={ambientIntensity} />
                    <directionalLight
                        position={[10, 10, 10]}
                        intensity={directionalIntensity}
                        castShadow
                        shadow-mapSize-width={1024}
                        shadow-mapSize-height={1024}
                    />
                    <directionalLight position={[-10, -10, -10]} intensity={directionalIntensity * 0.4} />
                    <directionalLight position={[0, 10, 0]} intensity={directionalIntensity * 0.3} />
                    <hemisphereLight args={['#87ceeb', '#654321', 0.3]} />

                    {/* Floor - Grid or Textured (at Y=0, model is offset to align feet) */}
                    {floorMode === 'grid' && (
                        <gridHelper args={[1000, 50, '#4a4a4a', '#3a3a3a']} position={[0, 0, 0]} />
                    )}
                    {floorMode === 'textured' && <TexturedFloor />}
                    <MeshViewer
                        meshData={meshData}
                        visibleMaterials={visibleMaterials}
                        wireframe={wireframe}
                        skeletonData={skeletonData}
                        animationPose={currentPose}
                    />
                    {showSkeleton && skeletonData && (
                        <SkeletonViewer skeletonData={skeletonData} animationPose={currentPose} />
                    )}
                    <OrbitControls />
                </Canvas>
            </div>

            {/* Popup Panels */}
            {activePopup === 'display' && (
                <div className="model-preview__popup model-preview__popup--top-right">
                    <div className="model-preview__popup-header">
                        <h4>Display & Skeleton</h4>
                        <button onClick={() => setActivePopup(null)}>×</button>
                    </div>
                    <div className="model-preview__popup-body">
                        <label className="model-preview__toggle">
                            <input
                                type="checkbox"
                                checked={wireframe}
                                onChange={(e) => setWireframe(e.target.checked)}
                            />
                            <span>Wireframe</span>
                        </label>
                        {skeletonData && (
                            <label className="model-preview__toggle">
                                <input
                                    type="checkbox"
                                    checked={showSkeleton}
                                    onChange={(e) => setShowSkeleton(e.target.checked)}
                                />
                                <span>Show Skeleton ({skeletonData.bones.length} bones)</span>
                            </label>
                        )}
                    </div>
                </div>
            )}

            {activePopup === 'environment' && (
                <div className="model-preview__popup model-preview__popup--top-left">
                    <div className="model-preview__popup-header">
                        <h4>Environment</h4>
                        <button onClick={() => setActivePopup(null)}>×</button>
                    </div>
                    <div className="model-preview__popup-body">
                        <label className="model-preview__toggle">
                            <input
                                type="checkbox"
                                checked={showSkybox}
                                onChange={(e) => setShowSkybox(e.target.checked)}
                            />
                            <span>Skybox</span>
                        </label>

                        <div className="model-preview__select-group">
                            <label className="model-preview__select-label">Floor</label>
                            <select
                                value={floorMode}
                                onChange={(e) => setFloorMode(e.target.value as 'grid' | 'textured' | 'none')}
                                className="model-preview__select"
                            >
                                <option value="grid">Grid</option>
                                <option value="textured">Textured</option>
                                <option value="none">None</option>
                            </select>
                        </div>

                        <div className="model-preview__slider">
                            <label className="model-preview__slider-label">
                                <span>Ambient Light</span>
                                <span className="model-preview__slider-value">{ambientIntensity.toFixed(1)}</span>
                            </label>
                            <input
                                type="range"
                                min="0"
                                max="2"
                                step="0.1"
                                value={ambientIntensity}
                                onChange={(e) => setAmbientIntensity(parseFloat(e.target.value))}
                                className="model-preview__slider-input"
                            />
                        </div>

                        <div className="model-preview__slider">
                            <label className="model-preview__slider-label">
                                <span>Directional Light</span>
                                <span className="model-preview__slider-value">{directionalIntensity.toFixed(1)}</span>
                            </label>
                            <input
                                type="range"
                                min="0"
                                max="3"
                                step="0.1"
                                value={directionalIntensity}
                                onChange={(e) => setDirectionalIntensity(parseFloat(e.target.value))}
                                className="model-preview__slider-input"
                            />
                        </div>
                    </div>
                </div>
            )}

            {activePopup === 'materials' && (
                <div className="model-preview__popup model-preview__popup--top-right model-preview__popup--wide">
                    <div className="model-preview__popup-header">
                        <h4>Materials ({meshData.materials.length})</h4>
                        <div className="model-preview__header-actions">
                            <button className="model-preview__toggle-btn model-preview__toggle-btn--all" onClick={() => toggleAllMaterials(true)} title="Show all materials">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M1 12s4-8 11-8 11 8 11 8-4 8-11 8-11-8-11-8z"/>
                                    <circle cx="12" cy="12" r="3"/>
                                </svg>
                            </button>
                            <button className="model-preview__toggle-btn model-preview__toggle-btn--none" onClick={() => toggleAllMaterials(false)} title="Hide all materials">
                                <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                    <path d="M17.94 17.94A10.07 10.07 0 0 1 12 20c-7 0-11-8-11-8a18.45 18.45 0 0 1 5.06-5.94M9.9 4.24A9.12 9.12 0 0 1 12 4c7 0 11 8 11 8a18.5 18.5 0 0 1-2.16 3.19m-6.72-1.07a3 3 0 1 1-4.24-4.24"/>
                                    <line x1="1" y1="1" x2="23" y2="23"/>
                                </svg>
                            </button>
                            <button onClick={() => setActivePopup(null)}>×</button>
                        </div>
                    </div>
                    <div className="model-preview__popup-body model-preview__popup-body--scrollable">
                        {meshData.texture_warning && (
                            <div className="model-preview__warning" style={{
                                background: 'rgba(251, 191, 36, 0.1)',
                                border: '1px solid rgba(251, 191, 36, 0.3)',
                                borderRadius: '4px',
                                padding: '8px',
                                marginBottom: '12px',
                                fontSize: '12px',
                            }}>
                                <div style={{ display: 'flex', alignItems: 'flex-start', gap: '6px' }}>
                                    <span style={{ fontSize: '14px' }}>⚠️</span>
                                    <span style={{ color: 'var(--text-secondary)' }}>{meshData.texture_warning}</span>
                                </div>
                            </div>
                        )}
                        <div className="model-preview__materials-list">
                            {meshData.materials.map((mat, index) => {
                                const matName = typeof mat === 'string' ? mat : mat.name;
                                const hasTexture =
                                    (isSknMeshData(meshData) && (
                                        meshData.material_data?.[matName] ||
                                        meshData.textures?.[matName]
                                    )) ||
                                    (!isSknMeshData(meshData) && (meshData as ScbMeshData).material_data?.[matName]);
                                const isVisible = visibleMaterials.has(matName);
                                return (
                                    <label
                                        key={matName || index}
                                        className={`material-toggle ${isVisible ? 'material-toggle--visible' : ''} ${hasTexture ? 'material-toggle--has-texture' : 'material-toggle--no-texture'}`}
                                        onMouseEnter={(e) => {
                                            setHoveredMaterial(matName);
                                            setPreviewPosition({ x: e.clientX, y: e.clientY });
                                        }}
                                        onMouseLeave={() => setHoveredMaterial(null)}
                                        onMouseMove={(e) => {
                                            setPreviewPosition({ x: e.clientX, y: e.clientY });
                                        }}
                                    >
                                        <input
                                            type="checkbox"
                                            checked={isVisible}
                                            onChange={() => toggleMaterial(matName)}
                                        />
                                        <div className="material-toggle__info">
                                            <span className="material-toggle__name" title={matName}>
                                                {matName || `Material ${index}`}
                                            </span>
                                            <span className={`material-toggle__status ${hasTexture ? 'material-toggle__status--loaded' : 'material-toggle__status--missing'}`}>
                                                {hasTexture ? (
                                                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                                                        <path d="M12.207 4.793a1 1 0 010 1.414l-5 5a1 1 0 01-1.414 0l-2-2a1 1 0 011.414-1.414L6.5 9.086l4.293-4.293a1 1 0 011.414 0z"/>
                                                    </svg>
                                                ) : (
                                                    <svg width="10" height="10" viewBox="0 0 16 16" fill="currentColor">
                                                        <path d="M4.646 4.646a.5.5 0 01.708 0L8 7.293l2.646-2.647a.5.5 0 01.708.708L8.707 8l2.647 2.646a.5.5 0 01-.708.708L8 8.707l-2.646 2.647a.5.5 0 01-.708-.708L7.293 8 4.646 5.354a.5.5 0 010-.708z"/>
                                                    </svg>
                                                )}
                                                {hasTexture ? 'Texture loaded' : 'No texture'}
                                            </span>
                                        </div>
                                    </label>
                                );
                            })}
                        </div>
                    </div>
                </div>
            )}

            {activePopup === 'animations' && animations.length > 0 && (
                <div className="model-preview__popup model-preview__popup--top-right">
                    <div className="model-preview__popup-header">
                        <h4>Animations ({animations.length})</h4>
                        <button onClick={() => setActivePopup(null)}>×</button>
                    </div>
                    <div className="model-preview__popup-body">
                        <div className="model-preview__select-group">
                            <select
                                className="model-preview__select"
                                value={selectedAnimation}
                                onChange={(e) => setSelectedAnimation(e.target.value)}
                            >
                                <option value="">-- Select Animation --</option>
                                {animations.map((anim, index) => (
                                    <option key={index} value={anim.animation_path}>
                                        {anim.name}
                                    </option>
                                ))}
                            </select>
                        </div>
                        {selectedAnimation && (
                            <>
                                <div className="model-preview__playback-controls">
                                    <button
                                        className={`model-preview__playback-btn ${isPlaying ? 'model-preview__playback-btn--active' : ''}`}
                                        onClick={() => setIsPlaying(!isPlaying)}
                                        title={isPlaying ? 'Pause' : 'Play'}
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            {isPlaying ? (
                                                <>
                                                    <rect x="6" y="4" width="4" height="16" />
                                                    <rect x="14" y="4" width="4" height="16" />
                                                </>
                                            ) : (
                                                <polygon points="5 3 19 12 5 21 5 3" />
                                            )}
                                        </svg>
                                        <span>{isPlaying ? 'Pause' : 'Play'}</span>
                                    </button>
                                    <button
                                        className="model-preview__playback-btn"
                                        onClick={() => { setIsPlaying(false); setCurrentTime(0); }}
                                        title="Stop"
                                    >
                                        <svg width="14" height="14" viewBox="0 0 24 24" fill="none" stroke="currentColor" strokeWidth="2" strokeLinecap="round" strokeLinejoin="round">
                                            <rect x="6" y="6" width="12" height="12" />
                                        </svg>
                                        <span>Stop</span>
                                    </button>
                                </div>
                                {animationData && (
                                    <div className="model-preview__timeline">
                                        <input
                                            type="range"
                                            min={0}
                                            max={animationData.duration}
                                            step={0.001}
                                            value={currentTime}
                                            onChange={(e) => setCurrentTime(parseFloat(e.target.value))}
                                            className="model-preview__timeline-slider"
                                        />
                                        <div className="model-preview__timeline-info">
                                            <span>{currentTime.toFixed(2)}s / {animationData.duration.toFixed(2)}s</span>
                                            <span className="model-preview__timeline-fps">
                                                {animationData.fps.toFixed(0)} FPS · {animationData.joint_count} joints
                                            </span>
                                        </div>
                                    </div>
                                )}
                            </>
                        )}
                    </div>
                </div>
            )}

            {/* Texture Preview Tooltip */}
            {hoveredMaterial && (
                <div
                    className="asset-preview-tooltip"
                    style={{
                        position: 'fixed',
                        left: previewPosition.x - 240,
                        top: previewPosition.y - 100,
                        zIndex: 9999,
                        pointerEvents: 'none'
                    }}
                >
                            <div className="asset-preview-tooltip__header">
                                {hoveredMaterial}
                            </div>
                            <div className="asset-preview-tooltip__content">
                                {(() => {
                                    // Get texture from material_data (works for both SKN and SCB)
                                    const sknData = meshData as SknMeshData;
                                    const scbData = meshData as ScbMeshData;
                                    const textureData = sknData.material_data?.[hoveredMaterial]?.texture ||
                                        scbData.material_data?.[hoveredMaterial]?.texture ||
                                        sknData.textures?.[hoveredMaterial];
                                    if (textureData) {
                                        return (
                                            <div className="asset-preview-tooltip__texture">
                                                <img
                                                    src={`data:image/png;base64,${textureData}`}
                                                    alt={hoveredMaterial}
                                                    style={{
                                                        maxWidth: '180px',
                                                        maxHeight: '160px',
                                                        objectFit: 'contain',
                                                        borderRadius: '4px',
                                                        background: 'repeating-conic-gradient(var(--bg-tertiary) 0% 25%, var(--bg-primary) 0% 50%) 50% / 10px 10px'
                                                    }}
                                                />
                                            </div>
                                        );
                                    } else {
                                        return (
                                            <div className="asset-preview-tooltip__error">
                                                <span className="asset-preview-tooltip__error-icon">🎨</span>
                                                <span>No texture loaded</span>
                                            </div>
                                        );
                                    }
                                })()}
                            </div>
                        </div>
                    )}
        </div>
    );
};
