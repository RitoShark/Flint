/**
 * Flint - ModelPreview Component
 * 3D preview for SKN mesh files with material visibility controls
 */

import React, { useState, useEffect, useMemo, useRef } from 'react';
import { Canvas, useThree } from '@react-three/fiber';
import { OrbitControls, PerspectiveCamera } from '@react-three/drei';
import * as THREE from 'three';
import * as api from '../../lib/api';

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

interface SknMeshData {
    materials: MaterialRange[];
    positions: [number, number, number][];
    normals: [number, number, number][];
    uvs: [number, number][];
    indices: number[];
    bounding_box: [[number, number, number], [number, number, number]];
    textures?: Record<string, string>;
}

interface BoneData {
    name: string;
    id: number;
    parent_id: number;
    local_translation: [number, number, number];
    local_rotation: [number, number, number, number];
    local_scale: [number, number, number];
    world_position: [number, number, number];
}

interface SklData {
    name: string;
    asset_name: string;
    bones: BoneData[];
}

interface ModelPreviewProps {
    filePath: string;
}

// ============================================================================
// Mesh Component (renders the 3D geometry)
// ============================================================================

interface MeshViewerProps {
    meshData: SknMeshData;
    visibleMaterials: Set<string>;
    wireframe: boolean;
}

const MeshViewer: React.FC<MeshViewerProps> = ({ meshData, visibleMaterials, wireframe }) => {
    const { camera } = useThree();
    const groupRef = useRef<THREE.Group>(null);

    // Create geometry from mesh data
    const geometry = useMemo(() => {
        const geo = new THREE.BufferGeometry();

        // Set vertex positions
        const positions = new Float32Array(meshData.positions.flat());
        geo.setAttribute('position', new THREE.BufferAttribute(positions, 3));

        // Set normals
        const normals = new Float32Array(meshData.normals.flat());
        geo.setAttribute('normal', new THREE.BufferAttribute(normals, 3));

        // Set UVs
        const uvs = new Float32Array(meshData.uvs.flat());
        geo.setAttribute('uv', new THREE.BufferAttribute(uvs, 2));

        // Set indices
        const indices = new Uint16Array(meshData.indices);
        geo.setIndex(new THREE.BufferAttribute(indices, 1));

        return geo;
    }, [meshData]);

    // Create material groups for visibility control
    const materialGroups = useMemo(() => {
        return meshData.materials.map((mat, index) => ({
            ...mat,
            visible: visibleMaterials.has(mat.name),
            color: new THREE.Color().setHSL((index * 0.618033988749895) % 1, 0.7, 0.5),
        }));
    }, [meshData.materials, visibleMaterials]);

    // Load textures from base64 data
    const textureMap = useMemo(() => {
        const map: Record<string, THREE.Texture> = {};
        if (meshData.textures) {
            const loader = new THREE.TextureLoader();
            Object.entries(meshData.textures).forEach(([name, base64]) => {
                const dataUrl = `data:image/png;base64,${base64}`;
                const texture = loader.load(dataUrl);
                texture.flipY = true; // League textures are often flipped
                texture.colorSpace = THREE.SRGBColorSpace;
                map[name] = texture;
            });
        }
        return map;
    }, [meshData.textures]);

    // Center camera on mesh
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

                // Create a sub-geometry for this material range
                const subGeo = geometry.clone();
                const startIdx = mat.start_index;
                const count = mat.index_count;

                // Draw only this material's triangles
                subGeo.setDrawRange(startIdx, count);

                return (
                    <mesh key={mat.name || index} geometry={subGeo}>
                        <meshStandardMaterial
                            color={textureMap[mat.name] ? undefined : mat.color}
                            map={textureMap[mat.name] || null}
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
// Skeleton Viewer Component (renders bone lines)
// ============================================================================

interface SkeletonViewerProps {
    skeletonData: SklData;
}

const SkeletonViewer: React.FC<SkeletonViewerProps> = ({ skeletonData }) => {
    // Use world_position directly from the backend (pre-computed from inverted bind matrix)
    const bonePositions = useMemo(() => {
        const positions: Record<number, THREE.Vector3> = {};

        skeletonData.bones.forEach(bone => {
            positions[bone.id] = new THREE.Vector3(
                bone.world_position[0],
                bone.world_position[1],
                bone.world_position[2]
            );
        });

        return positions;
    }, [skeletonData]);

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
        <group>
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

export const ModelPreview: React.FC<ModelPreviewProps> = ({ filePath }) => {
    const [meshData, setMeshData] = useState<SknMeshData | null>(null);
    const [loading, setLoading] = useState(true);
    const [error, setError] = useState<string | null>(null);
    const [wireframe, setWireframe] = useState(false);
    const [visibleMaterials, setVisibleMaterials] = useState<Set<string>>(new Set());

    // Animation state
    const [animations, setAnimations] = useState<{ name: string; animation_path: string }[]>([]);
    const [selectedAnimation, setSelectedAnimation] = useState<string>('');
    const [isPlaying, setIsPlaying] = useState(false);

    // Skeleton state
    const [skeletonData, setSkeletonData] = useState<SklData | null>(null);
    const [showSkeleton, setShowSkeleton] = useState(true);

    // Load mesh data
    useEffect(() => {
        let cancelled = false;

        const loadMesh = async () => {
            setLoading(true);
            setError(null);

            try {
                const data = await api.readSknMesh(filePath);
                if (cancelled) return;

                // Debug: log texture loading
                if (data.textures && Object.keys(data.textures).length > 0) {
                    console.log('[ModelPreview] Loaded textures:', Object.keys(data.textures));
                } else {
                    console.log('[ModelPreview] No textures found in mesh data');
                }

                setMeshData(data);
                // Initialize all materials as visible
                setVisibleMaterials(new Set(data.materials.map((m: MaterialRange) => m.name)));

                // Try to load animation list
                try {
                    const animList = await api.readAnimationList(filePath);
                    if (animList.clips && animList.clips.length > 0) {
                        console.log('[ModelPreview] Found animations:', animList.clips.length);
                        setAnimations(animList.clips);
                    }
                } catch (animErr) {
                    console.log('[ModelPreview] No animations found:', animErr);
                }

                // Try to load skeleton from same folder as SKN
                const sklPath = filePath.replace(/\.skn$/i, '.skl');
                try {
                    const skeleton = await api.readSklSkeleton(sklPath);
                    console.log('[ModelPreview] Loaded skeleton with', skeleton.bones.length, 'bones');
                    setSkeletonData(skeleton);
                } catch (sklErr) {
                    console.log('[ModelPreview] No skeleton found:', sklErr);
                }
            } catch (err) {
                if (cancelled) return;
                console.error('[ModelPreview] Failed to load mesh:', err);
                setError((err as Error).message || 'Failed to load mesh');
            } finally {
                if (!cancelled) {
                    setLoading(false);
                }
            }
        };

        loadMesh();
        return () => { cancelled = true; };
    }, [filePath]);

    // Load animation when selection changes
    useEffect(() => {
        if (!selectedAnimation) return;

        const loadAnimation = async () => {
            console.log('[ModelPreview] Loading animation:', selectedAnimation);
            try {
                const animData = await api.readAnimation(selectedAnimation, filePath);
                console.log('[ModelPreview] Loaded animation:', animData);
                // TODO: Apply animation keyframes to skeleton bones
            } catch (err) {
                console.error('[ModelPreview] Failed to load animation:', err);
            }
        };

        loadAnimation();
    }, [selectedAnimation, filePath]);

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
            setVisibleMaterials(new Set(meshData.materials.map(m => m.name)));
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
            {/* 3D Canvas */}
            <div className="model-preview__canvas">
                <Canvas>
                    <PerspectiveCamera makeDefault fov={50} position={[0, 0, 5]} />
                    <ambientLight intensity={0.5} />
                    <directionalLight position={[10, 10, 10]} intensity={1} />
                    <directionalLight position={[-10, -10, -10]} intensity={0.3} />
                    <MeshViewer
                        meshData={meshData}
                        visibleMaterials={visibleMaterials}
                        wireframe={wireframe}
                    />
                    {showSkeleton && skeletonData && (
                        <SkeletonViewer skeletonData={skeletonData} />
                    )}
                    <OrbitControls />
                </Canvas>
            </div>

            {/* Sidebar with controls */}
            <div className="model-preview__sidebar">
                <div className="model-preview__controls">
                    <h4>Display</h4>
                    <label className="model-preview__toggle">
                        <input
                            type="checkbox"
                            checked={wireframe}
                            onChange={(e) => setWireframe(e.target.checked)}
                        />
                        <span>Wireframe</span>
                    </label>
                </div>

                <div className="model-preview__materials">
                    <div className="model-preview__materials-header">
                        <h4>Materials ({meshData.materials.length})</h4>
                        <div className="model-preview__materials-actions">
                            <button
                                className="btn btn--sm"
                                onClick={() => toggleAllMaterials(true)}
                                title="Show all"
                            >
                                All
                            </button>
                            <button
                                className="btn btn--sm"
                                onClick={() => toggleAllMaterials(false)}
                                title="Hide all"
                            >
                                None
                            </button>
                        </div>
                    </div>
                    <div className="model-preview__materials-list">
                        {meshData.materials.map((mat, index) => (
                            <label key={mat.name || index} className="material-toggle">
                                <input
                                    type="checkbox"
                                    checked={visibleMaterials.has(mat.name)}
                                    onChange={() => toggleMaterial(mat.name)}
                                />
                                <span
                                    className="material-toggle__color"
                                    style={{
                                        backgroundColor: `hsl(${(index * 222.5) % 360}, 70%, 50%)`
                                    }}
                                />
                                <span className="material-toggle__name" title={mat.name}>
                                    {mat.name || `Material ${index}`}
                                </span>
                            </label>
                        ))}
                    </div>
                </div>

                {/* Animation Controls */}
                {animations.length > 0 && (
                    <div className="model-preview__animations">
                        <h4>Animations ({animations.length})</h4>
                        <select
                            className="model-preview__animation-select"
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
                        {selectedAnimation && (
                            <div className="model-preview__playback-controls">
                                <button
                                    className={`btn btn--sm ${isPlaying ? 'btn--active' : ''}`}
                                    onClick={() => setIsPlaying(!isPlaying)}
                                    title={isPlaying ? 'Pause' : 'Play'}
                                >
                                    {isPlaying ? '⏸️ Pause' : '▶️ Play'}
                                </button>
                                <button
                                    className="btn btn--sm"
                                    onClick={() => { setIsPlaying(false); }}
                                    title="Stop"
                                >
                                    ⏹️ Stop
                                </button>
                            </div>
                        )}
                    </div>
                )}

                {/* Skeleton Controls */}
                {skeletonData && (
                    <div className="model-preview__skeleton">
                        <h4>Skeleton ({skeletonData.bones.length} bones)</h4>
                        <label className="model-preview__toggle">
                            <input
                                type="checkbox"
                                checked={showSkeleton}
                                onChange={(e) => setShowSkeleton(e.target.checked)}
                            />
                            <span>Show Skeleton</span>
                        </label>
                    </div>
                )}

                {/* Texture Debug Info */}
                {meshData.textures && Object.keys(meshData.textures).length > 0 && (
                    <div className="model-preview__debug">
                        <small>Textures loaded: {Object.keys(meshData.textures).length}</small>
                    </div>
                )}
            </div>
        </div>
    );
};
