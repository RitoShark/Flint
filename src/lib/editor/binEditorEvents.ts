/* Window events that let siblings of the BIN editor drive it without lifting
   the whole editor's state up. Both carry `filePath` so a second open editor
   ignores a message meant for someone else. */

/** Ask the BIN editor for `filePath` to run its unhash pass. Dispatched by the
 *  preview panel's info bar, which is a sibling of the editor. */
export const UNHASH_REQUEST_EVENT = 'flint:bin-unhash-request';

/** Ask the BIN editor to reveal a name in the text — the Paint panel's
 *  double-click-an-emitter gesture. */
export const REVEAL_TEXT_EVENT = 'flint:bin-reveal-text';

export interface UnhashRequestDetail {
    filePath: string;
}

export interface RevealTextDetail {
    filePath: string;
    /** The literal text to find, e.g. an emitter or particle name. */
    needle: string;
}

export function requestUnhash(filePath: string): void {
    window.dispatchEvent(
        new CustomEvent<UnhashRequestDetail>(UNHASH_REQUEST_EVENT, { detail: { filePath } }),
    );
}

export function requestRevealText(filePath: string, needle: string): void {
    window.dispatchEvent(
        new CustomEvent<RevealTextDetail>(REVEAL_TEXT_EVENT, { detail: { filePath, needle } }),
    );
}

/** Ask the BIN editor to jump to the next / previous VFX system. Dispatched by
 *  the preview panel's info bar, which is a sibling of the editor. */
export const STEP_SYSTEM_EVENT = 'flint:bin-step-system';

/** The BIN editor reporting how many VFX systems its text currently has, so a
 *  sibling can hide the navigation when there are none. */
export const SYSTEM_COUNT_EVENT = 'flint:bin-system-count';

export interface StepSystemDetail {
    filePath: string;
    forward: boolean;
}

export interface SystemCountDetail {
    filePath: string;
    count: number;
}

export function requestStepSystem(filePath: string, forward: boolean): void {
    window.dispatchEvent(
        new CustomEvent<StepSystemDetail>(STEP_SYSTEM_EVENT, { detail: { filePath, forward } }),
    );
}

export function reportSystemCount(filePath: string, count: number): void {
    window.dispatchEvent(
        new CustomEvent<SystemCountDetail>(SYSTEM_COUNT_EVENT, { detail: { filePath, count } }),
    );
}

/* Revealing a line in a BIN that is not open yet cannot go through an event:
   the editor's listener does not exist until it has mounted and decoded the
   file, which is well after the caller navigates. So the line is STASHED and
   the editor pulls it once it is ready — the same pull handshake the
   cold-start "Open with" path uses. */
const pendingReveals = new Map<string, number>();

function revealKey(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}

export function stashRevealLine(filePath: string, line: number): void {
    pendingReveals.set(revealKey(filePath), line);
}

/** Consumes the stashed line, so a later remount does not jump again. */
export function takeRevealLine(filePath: string): number | null {
    const key = revealKey(filePath);
    const line = pendingReveals.get(key);
    if (line === undefined) return null;
    pendingReveals.delete(key);
    return line;
}
