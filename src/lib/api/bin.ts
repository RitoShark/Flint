import { invokeCommand, invokeRaw, utf8Decoder } from './core';

export async function convertBinToText(binData: Uint8Array): Promise<string> {
    return invokeRaw('convert_bin_bytes_to_text', binData);
}

export async function convertBinToJson(binData: Uint8Array): Promise<unknown> {
    return invokeRaw('convert_bin_bytes_to_json', binData);
}

export async function convertTextToBin(textContent: string): Promise<Uint8Array> {
    const result = await invokeCommand<number[]>('convert_text_to_bin', { textContent });
    return new Uint8Array(result);
}

export async function convertJsonToBin(jsonContent: unknown): Promise<Uint8Array> {
    const result = await invokeCommand<number[]>('convert_json_to_bin', { jsonContent });
    return new Uint8Array(result);
}

export async function readBinInfo(binData: Uint8Array): Promise<{ version: string; entryCount: number }> {
    return invokeCommand('read_bin_info', { binData: Array.from(binData) });
}

export async function parseBinFileToText(path: string): Promise<string> {
    const buf = await invokeCommand<ArrayBuffer>('parse_bin_file_to_text', { path });
    return utf8Decoder.decode(buf);
}

export async function readOrConvertBin(binPath: string): Promise<string> {
    const buf = await invokeCommand<ArrayBuffer>('read_or_convert_bin', { binPath });
    return utf8Decoder.decode(buf);
}

export async function saveRitobinToBin(binPath: string, content: string): Promise<void> {
    return invokeCommand('save_ritobin_to_bin', { binPath, content });
}

export async function parseBinToTree(binPath: string): Promise<unknown[]> {
    return invokeCommand('parse_bin_to_tree', { binPath });
}

export async function getBinPaths(binPath: string): Promise<unknown[]> {
    return invokeCommand('get_bin_paths', { binPath });
}

export async function compileRitobinTextToBytes(content: string): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('compile_ritobin_text_to_bytes', { content });
    return new Uint8Array(buf);
}

/** Re-resolve `0x…` hash tokens in ritobin text against the cached BIN hash
 *  dictionary. Returns the unhashed text and how many tokens were replaced. */
export async function unhashBinText(text: string): Promise<{ text: string; replaced: number }> {
    return invokeCommand('unhash_bin_text', { text });
}

export interface LinkedBinText {
    path: string;
    text: string;
}

/** Ritobin text of every BIN in this BIN's direct `linked` header. */
export async function listLinkedBinTexts(binPath: string): Promise<LinkedBinText[]> {
    return invokeCommand('list_linked_bin_texts', { binPath });
}
