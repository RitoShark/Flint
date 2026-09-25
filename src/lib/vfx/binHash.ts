import { fnv1a32Lower } from '../babylon/submeshVisibility';
const encoder = new TextEncoder();
export function fnv1a32(value: string): number {
    const bytes = encoder.encode(value.toLowerCase());
    const text = Array.from(bytes, byte => String.fromCharCode(byte)).join('');
    return fnv1a32Lower(text);
}
export const nameHash = (value: string): string => '0x' + fnv1a32(value).toString(16).padStart(8, '0');
