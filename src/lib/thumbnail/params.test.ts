import { describe, it, expect } from 'vitest';
import { parseThumbnailParams } from './params';

describe('parseThumbnailParams', () => {
  it('decodes project + skn from the hash query', () => {
    const p = parseThumbnailParams('#thumbnail?project=C%3A%2Fp&skn=hero.skn');
    expect(p).toEqual({ project: 'C:/p', skn: 'hero.skn' });
  });
  it('returns empties when missing', () => {
    expect(parseThumbnailParams('#thumbnail')).toEqual({ project: '', skn: '' });
  });
});
