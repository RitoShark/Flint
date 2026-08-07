import React, { useEffect, useRef } from 'react';
import { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';
import { createSknScene, type SknSceneHandle } from '../../lib/babylon/sknScene';
import * as api from '../../lib/api';
import { decodeMeshPayload } from '../../lib/api/mesh';
import type { SknMeshData } from '../../lib/api/mesh';
import { useModelEditorStore } from '../../lib/stores/modelEditorStore';

export interface EditorViewportProps {
    sknPath: string;
    /** Bumped by `reloadGeometry` after a structural op; a derived reload must
     *  not re-frame the camera (a duplicate must not yank the view). */
    reloadToken: number;
    onPick: (name: string | null) => void;
    handleRef: React.MutableRefObject<SknSceneHandle | null>;
}

/** Textures/material data resolve only through `readSknMesh`'s BIN lookup —
 *  `deriveModelMesh` returns geometry only, so every derived reload splices
 *  these back onto the fresh payload or the model goes untextured. */
interface StashedMaterials {
    textures?: SknMeshData['textures'];
    material_data?: SknMeshData['material_data'];
}

export const EditorViewport: React.FC<EditorViewportProps> = ({ sknPath, reloadToken, onPick, handleRef }) => {
    const canvasRef = useRef<HTMLCanvasElement | null>(null);
    const materialsRef = useRef<StashedMaterials | null>(null);
    // Session's skeleton loads on a separate, independently-timed effect in
    // ModelEditorWindow; read through a ref (updated every render, same
    // pattern as BinEditor/WadPreviewPanel's `saveRef`) so the async mesh
    // fetch below picks up whatever value is current when it settles instead
    // of needing `skeleton` as an effect dependency, which would re-run the
    // load a second time the moment the skeleton effect resolves after it.
    const skeleton = useModelEditorStore((s) => s.skeleton);
    const skeletonRef = useRef(skeleton);
    skeletonRef.current = skeleton;
    // First load after mount/retarget skips the reloadToken effect — 0 is the
    // sentinel "nothing staged yet" value reloadGeometry never produces.
    const isInitialReloadToken = useRef(true);

    useEffect(() => {
        const canvas = canvasRef.current;
        if (!canvas) return;
        const handle = createSknScene(canvas);
        handleRef.current = handle;
        return () => {
            handleRef.current = null;
            handle.dispose();
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, []);

    // First load: goes through `readSknMesh` so textures/material data
    // resolve via the BIN lookup. Frames the camera.
    useEffect(() => {
        let cancelled = false;
        void (async () => {
            try {
                const mesh = await api.readSknMesh(sknPath);
                if (cancelled) return;
                materialsRef.current = { textures: mesh.textures, material_data: mesh.material_data };
                const handle = handleRef.current;
                if (!handle) return;
                await handle.loadMesh(mesh, skeletonRef.current);
            } catch (err) {
                console.debug('[EditorViewport] readSknMesh failed', sknPath, err);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [sknPath]);

    // Derived reload after a structural op (duplicate/delete/paste): geometry
    // only, stashed textures spliced back on, camera left alone.
    useEffect(() => {
        if (isInitialReloadToken.current) {
            isInitialReloadToken.current = false;
            return;
        }
        let cancelled = false;
        void (async () => {
            try {
                const sessionId = useModelEditorStore.getState().sessionId;
                const handle = handleRef.current;
                if (!sessionId || !handle) return;
                const buf = await api.deriveModelMesh(sessionId);
                if (cancelled) return;
                const mesh = decodeMeshPayload(buf);
                if (mesh.kind === 'skn' && materialsRef.current) {
                    mesh.textures = materialsRef.current.textures;
                    mesh.material_data = materialsRef.current.material_data;
                }

                // `loadMesh` unconditionally reframes from the new mesh's
                // bounding box — save/restore the camera around the call so a
                // duplicate/delete does not yank the view.
                const camera = handle.scene.activeCamera as ArcRotateCamera | null;
                const priorView = camera
                    ? { alpha: camera.alpha, beta: camera.beta, radius: camera.radius, target: camera.target.clone() }
                    : null;

                await handle.loadMesh(mesh, skeletonRef.current);

                if (camera && priorView) {
                    camera.alpha = priorView.alpha;
                    camera.beta = priorView.beta;
                    camera.radius = priorView.radius;
                    camera.target = priorView.target;
                }
            } catch (err) {
                console.debug('[EditorViewport] deriveModelMesh reload failed', err);
            }
        })();
        return () => {
            cancelled = true;
        };
        // eslint-disable-next-line react-hooks/exhaustive-deps
    }, [reloadToken]);

    const handleClick = (e: React.MouseEvent<HTMLCanvasElement>) => {
        const handle = handleRef.current;
        if (!handle) return;
        onPick(handle.pickAt(e.nativeEvent.offsetX, e.nativeEvent.offsetY));
    };

    return (
        <canvas
            ref={canvasRef}
            className="m3d__canvas"
            style={{ width: '100%', height: '100%', display: 'block', outline: 'none' }}
            onClick={handleClick}
        />
    );
};
