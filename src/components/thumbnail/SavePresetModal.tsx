import { useEffect, useRef, useState } from 'react';
import { createPortal } from 'react-dom';
import { DlButton, DlIcon } from '../ui/design-lab';

export interface SavePresetModalProps {
  /** Prefill (e.g. the skin/champion name, or the last saved preset name). */
  initialName: string;
  onSave: (name: string) => void;
  onClose: () => void;
}

/**
 * Small design-lab modal that collects a name before saving the current
 * composition as a reusable preset. Portal'd to <body> so it overlays the
 * whole editor window (mirrors DesignLab's modal pattern).
 */
export function SavePresetModal({ initialName, onSave, onClose }: SavePresetModalProps) {
  const [name, setName] = useState(initialName);
  const inputRef = useRef<HTMLInputElement>(null);

  useEffect(() => {
    inputRef.current?.focus();
    inputRef.current?.select();
  }, []);

  const submit = () => {
    const trimmed = name.trim();
    if (!trimmed) return;
    onSave(trimmed);
  };

  return createPortal(
    <div className="dl-modal-backdrop" onMouseDown={(e) => { if (e.target === e.currentTarget) onClose(); }}>
      <div className="dl-modal" style={{ maxWidth: 420 }} onMouseDown={(e) => e.stopPropagation()}>
        <div className="dl-modal__head">
          <h3 className="dl-modal__title"><DlIcon name="save" style={{ marginRight: 8 }} />Save preset</h3>
          <button className="dl-modal__close" onClick={onClose} title="Close"><DlIcon name="close" /></button>
        </div>
        <div className="dl-modal__body" style={{ padding: 16, display: 'flex', flexDirection: 'column', gap: 8 }}>
          <label style={{ fontSize: 12, color: 'var(--text-secondary)' }}>Preset name</label>
          <input
            ref={inputRef}
            className="dl-input"
            value={name}
            placeholder="e.g. PROJECT Yone"
            onChange={(e) => setName(e.target.value)}
            onKeyDown={(e) => {
              if (e.key === 'Enter') submit();
              if (e.key === 'Escape') onClose();
            }}
          />
          <p style={{ fontSize: 11, color: 'var(--text-muted)', margin: 0, lineHeight: 1.5 }}>
            Saves this layout, fonts, and theme hue as a reusable preset. Model file paths are not stored, so the
            preset works with any skin.
          </p>
        </div>
        <div className="dl-modal__foot" style={{ padding: 12, display: 'flex', justifyContent: 'flex-end', gap: 8 }}>
          <DlButton variant="ghost" onClick={onClose}>Cancel</DlButton>
          <DlButton variant="primary" icon="save" onClick={submit} disabled={!name.trim()}>Save preset</DlButton>
        </div>
      </div>
    </div>,
    document.body,
  );
}
