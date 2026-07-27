import { invokeCommand } from './core';

export async function detectJadeInstallation(): Promise<string | null> {
    return invokeCommand('detect_jade_installation', {});
}

export async function detectQuartzInstallation(): Promise<string | null> {
    return invokeCommand('detect_quartz_installation', {});
}

export async function launchJade(filePath: string, jadePath: string): Promise<void> {
    return invokeCommand('launch_jade', { filePath, jadePath });
}

export async function launchQuartz(filePath: string, quartzPath: string): Promise<void> {
    return invokeCommand('launch_quartz', { filePath, quartzPath });
}

/** Each field is the detected install/storage path or null when not found. */
export interface ExternalAppsDetection {
    jade: string | null;
    quartz: string | null;
    ltk_manager: string | null;
    celestial: string | null;
}

export async function detectExternalApps(): Promise<ExternalAppsDetection> {
    return invokeCommand('detect_external_apps', {});
}

// =============================================================================
// Windows file associations (per-user, additive "Open with" — not default)
// =============================================================================

export interface FileAssocStatus {
    /** Extensions currently listing Flint under OpenWithProgids. */
    registered: string[];
    /** Extensions in our spec that aren't yet registered. */
    missing: string[];
    /** Exe path the existing registrations point at, if any. */
    current_exe_path: string | null;
}

export interface FileAssocResult {
    /** Extensions where we successfully touched the registry. */
    touched: string[];
    /** Per-extension error messages. Non-empty = partial failure. */
    errors: string[];
}

/**
 * Register Flint as an "Open with" handler for LoL file types. This does
 * NOT change the user's default handler for any extension. Per-user (HKCU),
 * no admin needed.
 */
export async function registerFileAssociations(): Promise<FileAssocResult> {
    return invokeCommand('register_file_associations', {});
}

export async function unregisterFileAssociations(): Promise<FileAssocResult> {
    return invokeCommand('unregister_file_associations', {});
}

export async function getFileAssociationStatus(): Promise<FileAssocStatus> {
    return invokeCommand('get_file_association_status', {});
}

// `takePendingFileOpen` moved to `./shell` — the backend's pending-open state
// now carries a `{ action, path }` pair (see `shell_args.rs`), not a bare path.
