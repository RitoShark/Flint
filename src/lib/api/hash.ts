import { invokeCommand } from './core';
import type { HashStatus } from '../types';

export async function downloadHashes(): Promise<{ downloaded: number; total: number }> {
    return invokeCommand('download_hashes');
}

export async function getHashStatus(): Promise<HashStatus> {
    return invokeCommand('get_hash_status');
}

export async function reloadHashes(): Promise<{ count: number }> {
    return invokeCommand('reload_hashes');
}

export async function forceRebuildHashes(): Promise<void> {
    return invokeCommand('force_rebuild_hashes');
}
