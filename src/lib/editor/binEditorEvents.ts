/* Window events that let siblings of the BIN editor drive it without lifting
   the whole editor's state up. Both carry `filePath` so a second open editor
   ignores a message meant for someone else. */

/** Ask the BIN editor for `filePath` to run its unhash pass. Dispatched by the
 *  preview panel's info bar, which is a sibling of the editor. */
export const UNHASH_REQUEST_EVENT = 'flint:bin-unhash-request';

/** Ask the BIN editor to reveal a name in the text — the Paint panel's
 *  double-click-an-emitter gesture. */
export const REVEAL_TEXT_EVENT = 'flint:bin-reveal-text';

/** Ask an ALREADY-MOUNTED BIN editor to jump to a line — a workspace-search hit
 *  in the file that is already open. */
export const REVEAL_LINE_EVENT = 'flint:bin-reveal-line';

export interface UnhashRequestDetail {
    filePath: string;
}

export interface RevealLineDetail {
    filePath: string;
    line: number;
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

/* Revealing a line in a BIN that is not open yet cannot go through an event:
   the editor's listener does not exist until it has mounted and decoded the
   file, which is well after the caller navigates. So the line is STASHED and
   the editor pulls it once it is ready — the same pull handshake the
   cold-start "Open with" path uses. */
const pendingReveals = new Map<string, number>();

function revealKey(filePath: string): string {
    return filePath.replace(/\\/g, '/').toLowerCase();
}

/* Same pull handshake as the line stash, and for the same reason: the audit report
   NAVIGATES to the file, so it fires this before that editor exists. */
const pendingTextReveals = new Map<string, string>();

export function takeRevealText(filePath: string): string | null {
    const key = revealKey(filePath);
    const needle = pendingTextReveals.get(key);
    if (needle === undefined) return null;
    pendingTextReveals.delete(key);
    return needle;
}

export function requestRevealText(filePath: string, needle: string): void {
    pendingTextReveals.set(revealKey(filePath), needle);
    window.dispatchEvent(
        new CustomEvent<RevealTextDetail>(REVEAL_TEXT_EVENT, { detail: { filePath, needle } }),
    );
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

export function isSameRevealTarget(a: string, b: string): boolean {
    return revealKey(a) === revealKey(b);
}

/* Stash AND announce: the editor for this file may or may not be mounted yet.
   Mounted, it hears the event; not mounted, it pulls the stash once it is
   ready. Without the event a second hit in the file already open does nothing,
   because navigating to an active tab remounts nothing. */
export function requestRevealLine(filePath: string, line: number): void {
    stashRevealLine(filePath, line);
    window.dispatchEvent(
        new CustomEvent<RevealLineDetail>(REVEAL_LINE_EVENT, { detail: { filePath, line } }),
    );
}
