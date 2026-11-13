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
  showBreakdown?: boolean
}

export const CcLicensePresetPicker: React.FC<CcLicensePresetPickerProps> = ({
  value,
  onChange,
  compact = false,
  showBreakdown = true,
}) => {
  const giveCredit = value.giveCredit ?? true
  const noEdits = giveCredit ? value.noEdits : false
  const noCommercial = giveCredit ? value.noCommercial : false
  const shareAlike = giveCredit && !noEdits ? Boolean(value.shareAlike) : false

  const resolved = resolveCcLicense({
    giveCredit,
    noEdits,
    noCommercial,
    shareAlike,
  })

  const emit = (next: CcToggleState) => {
    onChange(next, resolveCcLicense(next))
  }

  const handleToggleGiveCredit = () => {
    const nextCredit = !giveCredit
    emit({
      giveCredit: nextCredit,
      noEdits: nextCredit ? value.noEdits : false,
      noCommercial: nextCredit ? value.noCommercial : false,
      shareAlike: nextCredit ? Boolean(value.shareAlike) : false,
    })
  }

  const handleToggleNoEdits = () => {
    const nextNoEdits = !noEdits
    emit({
      giveCredit: true,
      noEdits: nextNoEdits,
      noCommercial,
      shareAlike: nextNoEdits ? false : shareAlike,
    })
  }

  const handleToggleShareAlike = () => {
    const nextShareAlike = !shareAlike
    emit({
      giveCredit: true,
      noEdits: nextShareAlike ? false : noEdits,
      noCommercial,
      shareAlike: nextShareAlike,
    })
  }

  const handleToggleNoCommercial = () => {
    emit({
      giveCredit: true,
      noEdits,
      noCommercial: !noCommercial,
      shareAlike,
    })
  }

  return (
    <div className={`cc-preset${compact ? ' cc-preset--compact' : ''}`}>
      <div className="cc-preset__toggles">
        <button
          type="button"
          className={`cc-preset__pill${giveCredit ? ' cc-preset__pill--on' : ''}`}
          onClick={handleToggleGiveCredit}
          aria-pressed={giveCredit}
          title="Require users to credit you (BY). Turn OFF for CC0 Public Domain (no credit required)."
        >
          <span className="cc-preset__switch" aria-hidden="true">
            <span className="cc-preset__knob" />
          </span>
          <span className="cc-preset__pill-text">
            <span className="cc-preset__pill-title">Give attribution</span>
            <span className="cc-preset__pill-code">BY · {giveCredit ? 'Credit required' : 'CC0 Public Domain'}</span>
          </span>
        </button>

        <button
          type="button"
          className={`cc-preset__pill${noEdits ? ' cc-preset__pill--on' : ''}`}
          onClick={handleToggleNoEdits}
          aria-pressed={noEdits}
          title="Forbid distributing edited or remixed versions of your mod (NoDerivatives)."
        >
          <span className="cc-preset__switch" aria-hidden="true">
            <span className="cc-preset__knob" />
          </span>
          <span className="cc-preset__pill-text">
            <span className="cc-preset__pill-title">No edits</span>
            <span className="cc-preset__pill-code">ND · {noEdits ? 'ON' : 'OFF'}</span>
          </span>
        </button>

        <button
          type="button"
          className={`cc-preset__pill${shareAlike ? ' cc-preset__pill--on' : ''}`}
          onClick={handleToggleShareAlike}
          aria-pressed={shareAlike}
          title="Allow edits/remixes only if others distribute them under the exact same license (ShareAlike)."
        >
          <span className="cc-preset__switch" aria-hidden="true">
            <span className="cc-preset__knob" />
          </span>
          <span className="cc-preset__pill-text">
            <span className="cc-preset__pill-title">Share same license</span>
            <span className="cc-preset__pill-code">SA · {shareAlike ? 'ON' : 'OFF'}</span>
          </span>
        </button>

        <button
          type="button"
          className={`cc-preset__pill${noCommercial ? ' cc-preset__pill--on' : ''}`}
          onClick={handleToggleNoCommercial}
          aria-pressed={noCommercial}
          title="Forbid commercial use or monetization of your mod (NonCommercial)."
        >
          <span className="cc-preset__switch" aria-hidden="true">
            <span className="cc-preset__knob" />
          </span>
          <span className="cc-preset__pill-text">
            <span className="cc-preset__pill-title">No commercial use</span>
            <span className="cc-preset__pill-code">NC · {noCommercial ? 'ON' : 'OFF'}</span>
          </span>
        </button>
      </div>

      <div className="cc-preset__summary">
        <span className="cc-preset__badge">{resolved.label}</span>
        <span className="cc-preset__summary-text">{resolved.summary}</span>
      </div>

      {showBreakdown && (
        <div className="cc-preset__breakdown">
          <div className="cc-preset__col">
            <span className="cc-preset__col-title cc-preset__col-title--can">Can do</span>
            <div className="cc-preset__tags">
              {resolved.permissions.map((item) => (
                <span key={item} className="cc-preset__tag cc-preset__tag--can">
                  + {item}
                </span>
              ))}
            </div>
          </div>

          <div className="cc-preset__col">
            <span className="cc-preset__col-title cc-preset__col-title--must">Must do (Credits)</span>
            <div className="cc-preset__tags">
              {resolved.conditions.map((item) => (
                <span key={item} className="cc-preset__tag cc-preset__tag--must">
                  • {item}
                </span>
              ))}
            </div>
          </div>

          <div className="cc-preset__col">
            <span className="cc-preset__col-title cc-preset__col-title--cannot">Cannot do</span>
            <div className="cc-preset__tags">
              {resolved.limitations.map((item) => (
                <span key={item} className="cc-preset__tag cc-preset__tag--cannot">
                  − {item}
                </span>
              ))}
            </div>
          </div>
        </div>
      )}
    </div>
  )
}
