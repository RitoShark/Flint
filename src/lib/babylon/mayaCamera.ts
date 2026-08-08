import type { ArcRotateCamera } from '@babylonjs/core/Cameras/arcRotateCamera';

type Action = 'tumble' | 'track' | 'dolly';

const DOLLY_SENSIBILITY = 0.004;

function actionFor(button: number): Action | null {
    if (button === 0) return 'tumble';
    if (button === 1) return 'track';
    if (button === 2) return 'dolly';
    return null;
}

/**
 * Maya navigation: Alt+LMB tumbles, Alt+MMB tracks, Alt+RMB dollies, wheel still zooms. Removes
 * Babylon's own pointer input so an un-modified drag stays free for selection and brush strokes.
 *
 * Writes the legacy `inertial*` fields rather than Babylon 9's inputMap — ArcRotateCamera still
 * folds those in through `_checkInputs`, and they carry the camera's configured inertia for free.
 */
export function attachMayaCameraControls(camera: ArcRotateCamera, canvas: HTMLCanvasElement): () => void {
    const pointers = camera.inputs.attached.pointers;
    if (pointers) camera.inputs.remove(pointers);

    let action: Action | null = null;
    let activePointer = -1;
    let lastX = 0;
    let lastY = 0;
    let suppressNextClick = false;

    const end = () => {
        if (action === null) return;
        action = null;
        suppressNextClick = true;
        if (activePointer >= 0 && canvas.hasPointerCapture(activePointer)) {
            canvas.releasePointerCapture(activePointer);
        }
        activePointer = -1;
    };

    const onPointerDown = (e: PointerEvent) => {
        // Babylon's own pointer input is gone, so nothing else stops the webview's middle-click autoscroll.
        if (e.button === 1) e.preventDefault();
        // A pointerup outside the canvas produces no click, so the flag would otherwise survive and
        // eat the next real one.
        if (!e.altKey) suppressNextClick = false;
        if (!e.altKey || action !== null) return;
        const next = actionFor(e.button);
        if (!next) return;
        action = next;
        activePointer = e.pointerId;
        lastX = e.clientX;
        lastY = e.clientY;
        canvas.setPointerCapture(e.pointerId);
        e.preventDefault();
        e.stopPropagation();
    };

    const onPointerMove = (e: PointerEvent) => {
        if (action === null || e.pointerId !== activePointer) return;
        const dx = e.clientX - lastX;
        const dy = e.clientY - lastY;
        lastX = e.clientX;
        lastY = e.clientY;

        if (action === 'tumble') {
            camera.inertialAlphaOffset -= dx / camera.angularSensibilityX;
            camera.inertialBetaOffset -= dy / camera.angularSensibilityY;
        } else if (action === 'track') {
            const scale = camera.panningSensibility !== 0 ? 1 / camera.panningSensibility : 0;
            camera.inertialPanningX += -dx * scale;
            camera.inertialPanningY += dy * scale;
        } else {
            camera.inertialRadiusOffset += (dx - dy) * camera.radius * DOLLY_SENSIBILITY;
        }
        e.preventDefault();
        e.stopPropagation();
    };

    const onPointerUp = (e: PointerEvent) => {
        if (e.pointerId !== activePointer) return;
        end();
        e.preventDefault();
    };

    // The click lands after pointerup has already cleared `action`, so a tumble would otherwise
    // fall through and re-select whatever the cursor came to rest on.
    const swallowNavigationClick = (e: Event) => {
        if (action === null && !suppressNextClick) return;
        suppressNextClick = false;
        e.preventDefault();
        e.stopPropagation();
    };

    canvas.addEventListener('pointerdown', onPointerDown, true);
    canvas.addEventListener('pointermove', onPointerMove, true);
    canvas.addEventListener('pointerup', onPointerUp, true);
    canvas.addEventListener('pointercancel', onPointerUp, true);
    canvas.addEventListener('auxclick', swallowNavigationClick, true);
    canvas.addEventListener('click', swallowNavigationClick, true);
    window.addEventListener('blur', end);

    return () => {
        canvas.removeEventListener('pointerdown', onPointerDown, true);
        canvas.removeEventListener('pointermove', onPointerMove, true);
        canvas.removeEventListener('pointerup', onPointerUp, true);
        canvas.removeEventListener('pointercancel', onPointerUp, true);
        canvas.removeEventListener('auxclick', swallowNavigationClick, true);
        canvas.removeEventListener('click', swallowNavigationClick, true);
        window.removeEventListener('blur', end);
        end();
    };
}
