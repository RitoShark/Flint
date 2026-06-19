import React, { useState, useEffect, useRef } from 'react';
import { Engine } from '@babylonjs/core/Engines/engine';
import { Scene } from '@babylonjs/core/scene';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { HemisphericLight } from '@babylonjs/core/Lights/hemisphericLight';
import { DirectionalLight } from '@babylonjs/core/Lights/directionalLight';
import { Mesh } from '@babylonjs/core/Meshes/mesh';
import { VertexData } from '@babylonjs/core/Meshes/mesh.vertexData';
import { StandardMaterial } from '@babylonjs/core/Materials/standardMaterial';
import { Vector3, Color3, Color4 } from '@babylonjs/core/Maths/math';
import * as api from '../../lib/api';

interface AssetPreviewTooltipProps {
    assetPath: string;
    basePath: string;
    position: { x: number; y: number };
    visible: boolean;
    onClose?: () => void;
}

interface MeshData {
    positions: Float32Array;
    indices: Uint16Array | Uint32Array;
    materials: string[] | { name: string }[];
}

type PreviewState =
    | { status: 'loading' }
    | { status: 'error'; message: string }
    | { status: 'texture'; data: string; width: number; height: number; format: string }
    | { status: 'mesh'; meshData: MeshData; vertexCount: number; faceCount: number };

function getAssetType(path: string): 'texture' | 'mesh' | 'unknown' {
    const ext = path.toLowerCase().split('.').pop() || '';
    if (['tex', 'dds'].includes(ext)) {
        return 'texture';
    }
    if (['scb', 'sco', 'skn'].includes(ext)) {
        return 'mesh';
    }
    return 'unknown';
}

const MiniMeshPreview: React.FC<{ meshData: MeshData }> = ({ meshData }) => {
    const canvasRef = useRef<HTMLCanvasElement>(null);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas || !meshData.positions.length) return;

        const engine = new Engine(canvas, true, {
            preserveDrawingBuffer: false,
            stencil: false,
            antialias: true,
            alpha: true
        });
        const scene = new Scene(engine);
        scene.clearColor = new Color4(0.106, 0.106, 0.106, 1.0);

        const mesh = new Mesh("mini-preview-mesh", scene);
        const vd = new VertexData();
        vd.positions = meshData.positions;

        // Swap triangle winding for Babylon (left-handed space)
        const indexCount = meshData.indices.length;
        const indices = new Uint32Array(indexCount);
        for (let i = 0; i < indexCount; i += 3) {
            indices[i] = meshData.indices[i];
            indices[i + 1] = meshData.indices[i + 2];
            indices[i + 2] = meshData.indices[i + 1];
        }
        vd.indices = indices;

        const normals = new Float32Array(meshData.positions.length);
        VertexData.ComputeNormals(meshData.positions, indices, normals);
        vd.normals = normals;

        vd.applyToMesh(mesh);

        mesh.computeWorldMatrix(true);
        const boundingInfo = mesh.getBoundingInfo();
        const center = boundingInfo.boundingBox.center;
        mesh.position.set(-center.x, -center.y, -center.z);

        const extents = boundingInfo.boundingBox.extendSize;
        const maxDim = Math.max(extents.x, extents.y, extents.z) * 2;

        const material = new StandardMaterial("mini-preview-mat", scene);
        material.diffuseColor = new Color3(0.4, 0.6, 0.8);
        material.specularColor = new Color3(0, 0, 0);
        material.backFaceCulling = false;
        mesh.material = material;

        const camera = new ArcRotateCamera(
            "mini-camera",
            0,
            Math.PI / 3,
            maxDim * 2.0,
            Vector3.Zero(),
            scene
        );

        const ambientLight = new HemisphericLight("mini-ambient", new Vector3(0, 1, 0), scene);
        ambientLight.intensity = 0.8;
        ambientLight.specular = new Color3(0, 0, 0);

        const dirLight = new DirectionalLight("mini-dir", new Vector3(1, 1, 1), scene);
        dirLight.intensity = 0.5;

        engine.runRenderLoop(() => {
            camera.alpha += 0.015;
            scene.render();
        });

        return () => {
            engine.dispose();
        };
    }, [meshData]);

    return (
        <canvas
            ref={canvasRef}
            width={180}
            height={140}
            className="asset-preview-tooltip__mesh-canvas"
        />
    );
};

export const AssetPreviewTooltip: React.FC<AssetPreviewTooltipProps> = ({
    assetPath,
    basePath,
    position,
    visible
}) => {
    const [preview, setPreview] = useState<PreviewState>({ status: 'loading' });
    const [resolvedPath, setResolvedPath] = useState<string>('');
    const containerRef = useRef<HTMLDivElement>(null);

    useEffect(() => {
        if (!visible || !assetPath) {
            return;
        }

        setPreview({ status: 'loading' });
        setResolvedPath('');

        const assetType = getAssetType(assetPath);

        const loadPreview = async () => {
            try {
                const fullPath = await api.resolveAssetPath(assetPath, basePath);
                setResolvedPath(fullPath);
                console.log('[AssetPreview] Resolved:', assetPath, '->', fullPath);

                if (assetType === 'texture') {
                    const result = await api.decodeDdsToPng(fullPath);
                    setPreview({
                        status: 'texture',
                        data: result.data,
                        width: result.width,
                        height: result.height,
                        format: result.format
                    });
                } else if (assetType === 'mesh') {
                    const ext = assetPath.toLowerCase().split('.').pop() || '';
                    let meshData: MeshData;

                    if (ext === 'skn') {
                        const mesh = await api.readSknMesh(fullPath);
                        meshData = {
                            positions: mesh.positions,
                            indices: mesh.indices,
                            materials: mesh.materials,
                        };
                    } else {
                        const mesh = await api.readScbMesh(fullPath);
                        meshData = {
                            positions: mesh.positions,
                            indices: mesh.indices,
                            materials: mesh.materials,
                        };
                    }

                    setPreview({
                        status: 'mesh',
                        meshData,
                        vertexCount: meshData.positions.length / 3,
                        faceCount: Math.floor(meshData.indices.length / 3)
                    });
                } else {
                    setPreview({ status: 'error', message: 'Unknown asset type' });
                }
            } catch (err) {
                console.error('[AssetPreviewTooltip] Failed to load:', err);
                setPreview({
                    status: 'error',
                    message: (err as Error).message || 'Failed to load asset'
                });
            }
        };

        loadPreview();
    }, [assetPath, basePath, visible]);

    if (!visible) {
        return null;
    }

    const tooltipWidth = 260;
    const tooltipHeight = 240;
    const margin = 20;

    let left = position.x + margin;
    let top = position.y - tooltipHeight / 2;

    if (left + tooltipWidth > window.innerWidth) {
        left = position.x - tooltipWidth - margin;
    }
    if (top < margin) {
        top = margin;
    }
    if (top + tooltipHeight > window.innerHeight - margin) {
        top = window.innerHeight - tooltipHeight - margin;
    }

    return (
        <div
            ref={containerRef}
            className="asset-preview-tooltip"
            style={{
                position: 'fixed',
                left,
                top,
                zIndex: 9999,
                pointerEvents: 'none'
            }}
        >
            <div className="asset-preview-tooltip__header">
                {assetPath.split(/[/\\]/).pop()}
            </div>

            <div className="asset-preview-tooltip__content">
                {preview.status === 'loading' && (
                    <div className="asset-preview-tooltip__loading">
                        <div className="spinner spinner--sm" />
                        <span>Loading...</span>
                    </div>
                )}

                {preview.status === 'error' && (
                    <div className="asset-preview-tooltip__error">
                        <span className="asset-preview-tooltip__error-icon">⚠️</span>
                        <span>{preview.message}</span>
                    </div>
                )}

                {preview.status === 'texture' && (
                    <div className="asset-preview-tooltip__texture">
                        <img
                            src={`data:image/png;base64,${preview.data}`}
                            alt={assetPath}
                            style={{
                                maxWidth: '200px',
                                maxHeight: '160px',
                                objectFit: 'contain',
                                borderRadius: '4px',
                                background: 'repeating-conic-gradient(var(--bg-tertiary) 0% 25%, var(--bg-primary) 0% 50%) 50% / 10px 10px'
                            }}
                        />
                        <div className="asset-preview-tooltip__info">
                            {preview.width}×{preview.height} • {preview.format}
                        </div>
                    </div>
                )}

                {preview.status === 'mesh' && (
                    <div className="asset-preview-tooltip__mesh">
                        <MiniMeshPreview meshData={preview.meshData} />
                        <div className="asset-preview-tooltip__mesh-stats">
                            {preview.vertexCount.toLocaleString()} verts • {preview.faceCount.toLocaleString()} tris
                        </div>
                    </div>
                )}
            </div>

            <div className="asset-preview-tooltip__footer">
                {resolvedPath.split('\\').slice(-2).join('\\')}
            </div>
        </div>
    );
};

export default AssetPreviewTooltip;
