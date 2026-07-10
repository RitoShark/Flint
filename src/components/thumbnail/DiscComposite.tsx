import { useEffect, useState } from 'react';
import { DiscLayer } from '../../lib/thumbnail/layers';
import { loadThumbnailAsset } from '../../lib/api/thumbnail';

// The disc layer collapses three pieces from the user's saved Riot preset
// (RING image + black circle fill + GLOW/interior-disc image) into ONE
// locked, delete-only layer (see task-10 brief + CLAUDE.md). The three
// sub-pieces are positioned as FIXED offsets from the disc layer's own
// x/y/w/h box, taken directly from the saved preset JSON
// (`.superpowers/sdd/user-saved-riot-preset.json`) with the RING's box
// (x:330,y:0,w:123,h:360) as the anchor (offset 0,0):
//   - GLOW  (interior disc, behind models): x:346,y:0,  w:168,h:360 -> dx:+16, dy:0,   w:168, h:360
//   - BLACK (20% opacity circle fill):      x:346,y:-26,w:407,h:412 -> dx:+16, dy:-26, w:407, h:412
//   - RING  (gold ring/ticks, front):       x:330,y:0,  w:123,h:360 -> dx:0,   dy:0,   w:123, h:360 (= the layer's own box)
// These offsets are fixed composite geometry (like `DiscLayer.opacity`) —
// NOT user-editable; the whole point of collapsing to one layer is that
// it's a single locked unit.
const GLOW_OFFSET = { dx: 16, dy: 0, w: 168, h: 360 };
const BLACK_OFFSET = { dx: 16, dy: -26, w: 407, h: 412 };
const RING_OFFSET = { dx: 0, dy: 0, w: 123, h: 360 };

// Module-level cache: the ring/glow WebP bytes never change at runtime, so
// every DiscComposite instance (only ever one disc layer per preset today,
// but nothing stops two) shares one fetch + one object URL.
let ringUrlPromise: Promise<string> | null = null;
let glowUrlPromise: Promise<string> | null = null;

function objectUrlFor(name: 'ring' | 'glow'): Promise<string> {
  const cacheField = name === 'ring' ? ringUrlPromise : glowUrlPromise;
  if (cacheField) return cacheField;
  const p = loadThumbnailAsset(name).then(bytes => {
    const blob = new Blob([new Uint8Array(bytes)], { type: 'image/webp' });
    return URL.createObjectURL(blob);
  });
  if (name === 'ring') ringUrlPromise = p; else glowUrlPromise = p;
  return p;
}

/** Renders the fixed ring + glow + black-fill disc composite for a `disc`
 *  layer. Purely presentational — sizing/position comes entirely from the
 *  parent `layer` prop (the layer's own x/y/w/h, applied by the caller as
 *  the containing `.tb-el` box); this component fills that box (`inset:0`)
 *  and lays the three pieces out using percentage offsets derived from the
 *  fixed pixel offsets above, so it scales with the layer's box regardless
 *  of layer.w/h. */
export function DiscComposite({ layer }: { layer: DiscLayer }) {
  const [ringUrl, setRingUrl] = useState<string | null>(null);
  const [glowUrl, setGlowUrl] = useState<string | null>(null);

  useEffect(() => {
    let cancelled = false;
    objectUrlFor('ring').then(url => { if (!cancelled) setRingUrl(url); });
    objectUrlFor('glow').then(url => { if (!cancelled) setGlowUrl(url); });
    return () => { cancelled = true; };
  }, []);

  const w = Math.max(1, layer.w);
  const h = Math.max(1, layer.h);
  const pct = (offset: { dx: number; dy: number; w: number; h: number }) => ({
    left: `${(offset.dx / w) * 100}%`,
    top: `${(offset.dy / h) * 100}%`,
    width: `${(offset.w / w) * 100}%`,
    height: `${(offset.h / h) * 100}%`,
  });

  return (
    <div className="tb-disc-composite">
      {glowUrl && (
        <div
          className="tb-disc-piece tb-disc-glow"
          style={{ ...pct(GLOW_OFFSET), backgroundImage: `url("${glowUrl}")` }}
        />
      )}
      <div
        className="tb-disc-piece tb-disc-black"
        style={{ ...pct(BLACK_OFFSET), opacity: layer.opacity / 100 }}
      />
      {ringUrl && (
        <div
          className="tb-disc-piece tb-disc-ring"
          style={{ ...pct(RING_OFFSET), backgroundImage: `url("${ringUrl}")` }}
        />
      )}
    </div>
  );
}
