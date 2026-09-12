/**
 * Native file/folder pickers, normalized.
 *
 * The Tauri plugin hands back OS paths with `\` on Windows. Import `open`/`save`
 * from here, never from `@tauri-apps/plugin-dialog`, so a picked path reaches the
 * app spelled the same way every other path is.
 */

import {
    open as pluginOpen,
    save as pluginSave,
    type OpenDialogOptions,
    type OpenDialogReturn,
    type SaveDialogOptions,
} from '@tauri-apps/plugin-dialog';

import { toPosix } from '../pathIdentity';

export async function open<T extends OpenDialogOptions>(
    options?: T,
): Promise<OpenDialogReturn<T>> {
    const picked = await pluginOpen(options);
    if (picked === null) return picked as OpenDialogReturn<T>;
    const normalized = Array.isArray(picked) ? picked.map(toPosix) : toPosix(picked);
    return normalized as OpenDialogReturn<T>;
}

export async function save(options?: SaveDialogOptions): Promise<string | null> {
    const picked = await pluginSave(options);
    return picked === null ? null : toPosix(picked);
}
