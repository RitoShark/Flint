import { invokeCommand } from './core';
import type { UpdateInfo } from '../types';

export async function getCurrentVersion(): Promise<string> {
    return invokeCommand('get_current_version');
}

export async function checkForUpdates(): Promise<UpdateInfo> {
    return invokeCommand('check_for_updates');
}

export async function downloadAndInstallUpdate(downloadUrl: string): Promise<void> {
    return invokeCommand('download_and_install_update', { downloadUrl });
}
