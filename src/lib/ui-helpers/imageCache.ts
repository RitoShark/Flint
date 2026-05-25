/**
 * Image Cache
 * LRU cache for decoded DDS/TEX image data
 */

const IMAGE_CACHE_MAX_SIZE = 50;
const imageCache = new Map<string, unknown>();

/**
 * Get a cached image by path
 * @param path - The file path to look up
 * @returns The cached image data or null if not found
 */
export function getCachedImage(path: string): unknown | null {
  const key = path.replaceAll('\\', '/');
  const cached = imageCache.get(key);
  if (cached) {
    // Move to end (most recently used)
    imageCache.delete(key);
    imageCache.set(key, cached);
    return cached;
  }
  return null;
}

/**
 * Cache an image by path
 * @param path - The file path to cache
 * @param imageData - The image data to cache
 */
export function cacheImage(path: string, imageData: unknown): void {
  const key = path.replaceAll('\\', '/');
  // Evict oldest if at capacity
  if (imageCache.size >= IMAGE_CACHE_MAX_SIZE) {
    const oldestKey = imageCache.keys().next().value;
    if (oldestKey) {
      imageCache.delete(oldestKey);
    }
  }
  imageCache.set(key, imageData);
}

/**
 * Clear all cached images
 */
export function clearImageCache(): void {
  imageCache.clear();
}

/**
 * Invalidate a specific cached image by path
 * @param path - The file path to invalidate
 * @returns true if an entry was removed, false if not found
 */
export function invalidateCachedImage(path: string): boolean {
  return imageCache.delete(path.replaceAll('\\', '/'));
}
