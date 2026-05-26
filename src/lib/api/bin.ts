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

// Multi-MB ritobin text comes back as raw UTF-8 bytes — `TextDecoder` is
// faster than `JSON.parse('"..."')` for huge strings.
export async function parseBinFileToText(path: string): Promise<string> {
    const buf = await invokeCommand<ArrayBuffer>('parse_bin_file_to_text', { path });
    return utf8Decoder.decode(buf);
}

export async function readOrConvertBin(binPath: string, useJade?: boolean): Promise<string> {
    const buf = await invokeCommand<ArrayBuffer>('read_or_convert_bin', { binPath, useJade });
    return utf8Decoder.decode(buf);
}

export async function saveRitobinToBin(binPath: string, content: string, useJade?: boolean): Promise<void> {
    return invokeCommand('save_ritobin_to_bin', { binPath, content, useJade });
}

export async function parseBinToTree(binPath: string): Promise<unknown[]> {
    return invokeCommand('parse_bin_to_tree', { binPath });
}

export async function getBinPaths(binPath: string): Promise<unknown[]> {
    return invokeCommand('get_bin_paths', { binPath });
}

export async function compileRitobinTextToBytes(content: string, useJade?: boolean): Promise<Uint8Array> {
    const buf = await invokeCommand<ArrayBuffer>('compile_ritobin_text_to_bytes', { content, useJade });
    return new Uint8Array(buf);
}
