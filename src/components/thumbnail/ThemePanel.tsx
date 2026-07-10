import { resolveGlowColor } from '../../lib/thumbnail/hue';

interface ThemePanelProps {
  hue: number;
  onChange: (hue: number) => void;
}

/**
 * Single global hue control (Task 12). Replaces any per-text color picker —
 * text/glow/accent color all derive from this ONE value via `hue.ts`
 * (subtle mix for the Riot style, strong for Divine — see ThumbnailArtboard's
 * use of `resolveTextColor`).
 */
export function ThemePanel({ hue, onChange }: ThemePanelProps) {
  const swatch = resolveGlowColor(hue);
  const pct = (hue / 360) * 100;

  return (
    <div className="dl-card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 8 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>Theme hue</span>
        <div
          title={swatch}
          style={{
            width: 18,
            height: 18,
            borderRadius: '50%',
            background: swatch,
            border: '1px solid var(--border)',
            boxShadow: '0 0 6px 1px ' + swatch,
            flexShrink: 0,
          }}
        />
      </div>
      <div className="dl-slider dl-slider--hue" style={{ ['--_value' as never]: `${pct}%` }}>
        <input
          type="range"
          min={0}
          max={360}
          value={hue}
          onChange={(e) => onChange(parseInt(e.target.value, 10))}
          aria-label="Theme hue"
        />
        <span className="dl-slider__bubble">{Math.round(hue)}&deg;</span>
      </div>
    </div>
  );
}
