import React from 'react'
import {
  type CcToggleState,
  type ResolvedCcLicense,
  resolveCcLicense,
} from '../../../lib/editor/ccLicense'

export interface CcLicensePresetPickerProps {
  value: CcToggleState
  onChange: (next: CcToggleState, resolved: ResolvedCcLicense) => void
  compact?: boolean
}

export const CcLicensePresetPicker: React.FC<CcLicensePresetPickerProps> = ({
  value,
  onChange,
  compact = false,
}) => {
  const resolved = resolveCcLicense(value)

  const handleToggleNoEdits = () => {
    const next: CcToggleState = { ...value, noEdits: !value.noEdits }
    onChange(next, resolveCcLicense(next))
  }

  const handleToggleNoCommercial = () => {
    const next: CcToggleState = { ...value, noCommercial: !value.noCommercial }
    onChange(next, resolveCcLicense(next))
  }

  return (
    <div className={`cc-preset${compact ? ' cc-preset--compact' : ''}`}>
      <div className="cc-preset__toggles">
        <button
          type="button"
          className="cc-preset__pill cc-preset__pill--on cc-preset__pill--locked"
          disabled
          aria-pressed="true"
          title="Attribution (BY) is always required for Creative Commons BY presets"
        >
          <span className="cc-preset__switch" aria-hidden="true">
            <span className="cc-preset__knob" />
          </span>
          <span className="cc-preset__pill-text">
            <span className="cc-preset__pill-title">Give attribution</span>
            <span className="cc-preset__pill-code">BY · Required</span>
          </span>
        </button>

        <button
          type="button"
          className={`cc-preset__pill${value.noEdits ? ' cc-preset__pill--on' : ''}`}
          onClick={handleToggleNoEdits}
          aria-pressed={value.noEdits}
        >
          <span className="cc-preset__switch" aria-hidden="true">
            <span className="cc-preset__knob" />
          </span>
          <span className="cc-preset__pill-text">
            <span className="cc-preset__pill-title">No edits</span>
            <span className="cc-preset__pill-code">ND · {value.noEdits ? 'ON' : 'OFF'}</span>
          </span>
        </button>

        <button
          type="button"
          className={`cc-preset__pill${value.noCommercial ? ' cc-preset__pill--on' : ''}`}
          onClick={handleToggleNoCommercial}
          aria-pressed={value.noCommercial}
        >
          <span className="cc-preset__switch" aria-hidden="true">
            <span className="cc-preset__knob" />
          </span>
          <span className="cc-preset__pill-text">
            <span className="cc-preset__pill-title">No commercial use</span>
            <span className="cc-preset__pill-code">NC · {value.noCommercial ? 'ON' : 'OFF'}</span>
          </span>
        </button>
      </div>

      <div className="cc-preset__summary">
        <span className="cc-preset__badge">{resolved.label}</span>
        <span className="cc-preset__summary-text">{resolved.summary}</span>
      </div>
    </div>
  )
}

