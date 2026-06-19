import { invokeCommand, utf8Decoder } from './core';

export interface StringTableRow {
    hash: string;          // existing entry: decimal u64 as string
    key?: string;          // new row added in UI: the unhashed key string
    value: string;
    encrypted: boolean;
}

export interface StringTableData {
    version: number;
    mode: number;
    fontConfig: string | null;
    readOnly: boolean;     // true when the file contains encrypted entries
    rows: StringTableRow[];
}

export interface ManifestFile {
    path: string;
    size: number;
    flags: string[];
}

export interface ManifestData {
    version: [number, number];
    manifestId: string;
    flags: number;
    fileCount: number;
    totalSize: number;
    files: ManifestFile[];
}

export async function readLuabinText(path: string): Promise<string> {
    const buf = await invokeCommand<ArrayBuffer>('read_luabin_text', { path });
    return utf8Decoder.decode(buf);
}

export async function readTroybinText(path: string): Promise<string> {
    const buf = await invokeCommand<ArrayBuffer>('read_troybin_text', { path });
    return utf8Decoder.decode(buf);
}

export async function readInibinText(path: string): Promise<string> {
    const buf = await invokeCommand<ArrayBuffer>('read_inibin_text', { path });
    return utf8Decoder.decode(buf);
}

export async function saveInibinText(path: string, content: string): Promise<void> {
    return invokeCommand('save_inibin_text', { path, content });
}

export async function readStringTable(path: string): Promise<StringTableData> {
    const buf = await invokeCommand<ArrayBuffer>('read_stringtable_json', { path });
    return JSON.parse(utf8Decoder.decode(buf)) as StringTableData;
}

export async function saveStringTable(path: string, data: StringTableData): Promise<void> {
    return invokeCommand('save_stringtable_json', { path, content: JSON.stringify(data) });
}

export async function readManifest(path: string): Promise<ManifestData> {
    const buf = await invokeCommand<ArrayBuffer>('read_manifest_json', { path });
    return JSON.parse(utf8Decoder.decode(buf)) as ManifestData;
}
