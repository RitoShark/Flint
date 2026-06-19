const SIDECAR_SUFFIXES = ['.ritobin'] as const;

export function isSidecarFile(path: string): boolean {
    const lower = path.toLowerCase();
    return SIDECAR_SUFFIXES.some((suf) => lower.endsWith(suf));
}
