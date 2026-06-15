const IMAGE_CACHE_MAX_SIZE = 50;
const imageCache = new Map<string, unknown>();

export function getCachedImage(path: string): unknown | null {
  const key = path.replaceAll('\\', '/');
  const cached = imageCache.get(key);
  if (cached) {
    imageCache.delete(key);
    imageCache.set(key, cached);
    return cached;
  }
  return null;
}

export function cacheImage(path: string, imageData: unknown): void {
  const key = path.replaceAll('\\', '/');
  if (imageCache.size >= IMAGE_CACHE_MAX_SIZE) {
    const oldestKey = imageCache.keys().next().value;
    if (oldestKey) {
      imageCache.delete(oldestKey);
    }
  }
  imageCache.set(key, imageData);
}

export function clearImageCache(): void {
  imageCache.clear();
}

export function invalidateCachedImage(path: string): boolean {
  return imageCache.delete(path.replaceAll('\\', '/'));
}
