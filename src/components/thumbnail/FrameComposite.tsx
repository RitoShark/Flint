import { useEffect, useState } from 'react';
import { FrameLayer } from '../../lib/thumbnail/layers';
import { resolveGlowColor } from '../../lib/thumbnail/hue';
import { loadThumbnailAsset, ThumbnailAssetName } from '../../lib/api/thumbnail';

// Module-level cache: the bundled frame WebP bytes never change at runtime, so
// every FrameComposite instance shares one fetch + one object URL per asset.
const urlCache = new Map<string, Promise<string>>();

function objectUrlFor(asset: string): Promise<string> {
  const cached = urlCache.get(asset);
  if (cached) return cached;
  const p = loadThumbnailAsset(asset as ThumbnailAssetName).then(bytes => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/webp' });
    return URL.createObjectURL(blob);
  });
  urlCache.set(asset, p);
  return p;
}

/** Renders a `frame` layer (the white line-art corner brackets) tinted toward
 *  the theme hue. The art is white on transparent, so we paint a solid tint
 *  color and use the image as an alpha `mask` — the visible pixels take the
 *  tint color, the transparent ones stay transparent. `tint` blends between the
 *  original white (tint 0) and the full hue color (tint 1) by stacking the
 *  original white image at reduced opacity over the masked tint. Fills the
 *  parent `.tb-el` box (`inset:0`), so placement/size comes from the layer. */
export function FrameComposite({ layer, hue }: { layer: FrameLayer; hue: number }) {
  const [url, setUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    objectUrlFor(layer.asset).then(u => { if (!cancelled) setUrl(u); });
    return () => { cancelled = true; };
  }, [layer.asset]);

  if (!url) return null;

  const tint = Math.max(0, Math.min(1, layer.tint));
  const hueColor = resolveGlowColor(hue);
  const maskStyle: React.CSSProperties = {
    position: 'absolute',
    inset: 0,
    WebkitMaskImage: `url("${url}")`,
    maskImage: `url("${url}")`,
    WebkitMaskSize: 'contain',
    maskSize: 'contain',
    WebkitMaskRepeat: 'no-repeat',
    maskRepeat: 'no-repeat',
    WebkitMaskPosition: 'center',
    maskPosition: 'center',
  };

  return (
    <div className="tb-frame-composite" style={{ position: 'absolute', inset: 0, pointerEvents: 'none' }}>
      {/* The original white art (fades out as tint → 1). */}
      <img
        src={url}
        alt=""
        style={{ position: 'absolute', inset: 0, width: '100%', height: '100%', objectFit: 'contain', opacity: 1 - tint }}
      />
      {/* The hue-tinted copy (fades in as tint → 1), masked to the art's alpha. */}
      <div style={{ ...maskStyle, backgroundColor: hueColor, opacity: tint }} />
    </div>
  );
}
