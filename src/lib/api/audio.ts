import { invokeCommand, invokeRaw } from './core';
import type { AudioBankInfo, DecodedAudio, HircData, BinEventString, EventMapping } from '../types';

export async function parseAudioBank(path: string): Promise<AudioBankInfo> {
    return invokeCommand('parse_audio_bank', { path });
}

function toBytes(data: ArrayLike<number> | Uint8Array): Uint8Array {
    return data instanceof Uint8Array ? data : new Uint8Array(data);
}

export async function parseAudioBankBytes(data: ArrayLike<number> | Uint8Array): Promise<AudioBankInfo> {
    return invokeRaw('parse_audio_bank_bytes', toBytes(data));
}

export async function readAudioEntry(path: string, fileId: number): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('read_audio_entry', { path, fileId });
    return new Uint8Array(buf);
}

export async function readAudioEntryBytes(
    data: ArrayLike<number> | Uint8Array,
    fileId: number,
): Promise<Uint8Array> {
    const buf = await invokeRaw<ArrayBuffer>(
        'read_audio_entry_bytes',
        toBytes(data),
        { 'file-id': String(fileId) },
    );
    return new Uint8Array(buf);
}

export async function decodeWem(wemData: ArrayLike<number> | Uint8Array): Promise<DecodedAudio> {
    return invokeRaw('decode_wem', toBytes(wemData));
}

export async function parseBnkHirc(path: string): Promise<HircData | null> {
    return invokeCommand('parse_bnk_hirc', { path });
}

export async function parseBnkHircBytes(data: ArrayLike<number> | Uint8Array): Promise<HircData | null> {
    return invokeRaw('parse_bnk_hirc_bytes', toBytes(data));
}

export async function extractBinAudioEvents(data: ArrayLike<number> | Uint8Array): Promise<BinEventString[]> {
    return invokeRaw('extract_bin_audio_events', toBytes(data));
}

export async function mapAudioEvents(
    binData: number[],
    eventsBnkData: number[]
): Promise<EventMapping[]> {
    return invokeCommand('map_audio_events', { binData, eventsBnkData });
}

export async function replaceAudioEntry(
    bankData: number[],
    fileId: number,
    newWemData: number[]
): Promise<number[]> {
    return invokeCommand('replace_audio_entry', { bankData, fileId, newWemData });
}

export async function replaceAudioEntries(
    bankData: number[],
    replacements: { file_id: number; new_data: number[] }[]
): Promise<number[]> {
    return invokeCommand('replace_audio_entries', { bankData, replacements });
}

export async function silenceAudioEntry(bankData: number[], fileId: number): Promise<number[]> {
    return invokeCommand('silence_audio_entry', { bankData, fileId });
}

export async function removeAudioEntry(bankData: number[], fileId: number): Promise<number[]> {
    return invokeCommand('remove_audio_entry', { bankData, fileId });
}

export async function saveAudioFile(path: string, data: Uint8Array | number[]): Promise<void> {
    const bytes = data instanceof Uint8Array ? data : new Uint8Array(data);
    return invokeRaw('save_audio_file', bytes, { path });
}
