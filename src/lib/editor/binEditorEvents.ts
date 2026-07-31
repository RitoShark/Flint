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
