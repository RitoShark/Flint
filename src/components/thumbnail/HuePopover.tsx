import { useEffect, useLayoutEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { resolveGlowColor } from '../../lib/thumbnail/hue';
import { DlSlider } from '../ui/design-lab';

const POP_W = 240;

/**
 * The global theme-hue control as a circular swatch button (top-right of the
 * artboard) that opens a small anchored popover with the hue slider — same
 * interaction as the model mesh/anim popup (portal, click-outside / Esc close).
 * Replaces the sidebar ThemePanel so the hue lives over the canvas.
 */
export function HuePopover({ hue, onChange }: { hue: number; onChange: (hue: number) => void }) {
  const btnRef = useRef<HTMLButtonElement>(null);
  const popRef = useRef<HTMLDivElement>(null);
  const [open, setOpen] = useState(false);
  const [pos, setPos] = useState<{ left: number; top: number } | null>(null);
  const swatch = resolveGlowColor(hue);

  // Position the popover under-left of the swatch button, clamped to viewport.
  useLayoutEffect(() => {
    if (!open) { setPos(null); return; }
    const anchor = btnRef.current;
    if (!anchor) return;
    const place = () => {
      const r = anchor.getBoundingClientRect();
      const margin = 8;
      let left = r.right - POP_W;
      left = Math.max(margin, Math.min(left, window.innerWidth - POP_W - margin));
      const top = r.bottom + 6;
      setPos({ left, top });
    };
    place();
    window.addEventListener('resize', place);
    window.addEventListener('scroll', place, true);
    return () => {
      window.removeEventListener('resize', place);
      window.removeEventListener('scroll', place, true);
    };
  }, [open]);

  // Close on Esc / click outside (button + popover).
  useEffect(() => {
    if (!open) return;
    const onKey = (e: KeyboardEvent) => { if (e.key === 'Escape') setOpen(false); };
    const onDown = (e: MouseEvent) => {
      const t = e.target as Node;
      if (popRef.current?.contains(t) || btnRef.current?.contains(t)) return;
      setOpen(false);
    };
    window.addEventListener('keydown', onKey);
    document.addEventListener('mousedown', onDown);
    return () => {
      window.removeEventListener('keydown', onKey);
      document.removeEventListener('mousedown', onDown);
    };
  }, [open]);

  return (
    <>
      <button
        ref={btnRef}
        type="button"
        className="tb-hue-btn"
        title="Theme hue"
        aria-label="Theme hue"
        onClick={() => setOpen(o => !o)}
        style={{ background: swatch, boxShadow: `0 0 8px 1px ${swatch}` }}
      />
      {open && createPortal(
        <div
          ref={popRef}
          className="tb-hue-pop dl-card"
          style={{ left: pos?.left ?? -9999, top: pos?.top ?? -9999, width: POP_W, visibility: pos ? 'visible' : 'hidden' }}
          onMouseDown={(e) => e.stopPropagation()}
        >
          <div className="tb-hue-pop__head">
            <span>Theme hue</span>
            <span className="tb-hue-pop__val">{Math.round(hue)}°</span>
          </div>
          <DlSlider hue min={0} max={360} value={hue} bubble={`${Math.round(hue)}°`} aria-label="Theme hue" onChange={onChange} />
        </div>,
        document.body,
      )}
    </>
  );
}
