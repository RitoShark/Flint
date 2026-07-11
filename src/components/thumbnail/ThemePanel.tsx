import { resolveGlowColor } from '../../lib/thumbnail/hue';
import { DlIcon, DlSlider } from '../ui/design-lab';

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

  return (
    <div className="dl-card" style={{ padding: 12, display: 'flex', flexDirection: 'column', gap: 10 }}>
      <div style={{ display: 'flex', alignItems: 'center', justifyContent: 'space-between' }}>
        <span style={{ display: 'inline-flex', alignItems: 'center', gap: 6, fontSize: 12, fontWeight: 600, color: 'var(--text-secondary)' }}>
          <DlIcon name="color-palette" size={14} />Theme hue
        </span>
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
      <DlSlider
        hue
        min={0}
        max={360}
        value={hue}
        bubble={`${Math.round(hue)}°`}
        aria-label="Theme hue"
        onChange={onChange}
      />
    </div>
  );
}
