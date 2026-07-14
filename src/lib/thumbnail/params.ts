export interface ThumbnailParams { project: string; skn: string; }

export function parseThumbnailParams(hash: string): ThumbnailParams {
  const q = hash.indexOf('?');
  const search = q >= 0 ? hash.slice(q + 1) : '';
  const sp = new URLSearchParams(search);
  return { project: sp.get('project') ?? '', skn: sp.get('skn') ?? '' };
}
