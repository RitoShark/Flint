export interface CcToggleState {
  noEdits: boolean
  noCommercial: boolean
}

export interface ResolvedCcLicense {
  spdx: 'CC-BY-4.0' | 'CC-BY-NC-4.0' | 'CC-BY-ND-4.0' | 'CC-BY-NC-ND-4.0'
  label: 'CC BY 4.0' | 'CC BY-NC 4.0' | 'CC BY-ND 4.0' | 'CC BY-NC-ND 4.0'
  fullTitle: string
  url: string
  summary: string
  terms: string[]
}

export interface FormatLicenseFileOptions {
  spdx: string
  label?: string
  fullTitle?: string
  url?: string
  author?: string
  year?: number
  modName?: string
}

export function resolveCcLicense(state: CcToggleState): ResolvedCcLicense {
  const { noEdits, noCommercial } = state

  if (!noEdits && !noCommercial) {
    return {
      spdx: 'CC-BY-4.0',
      label: 'CC BY 4.0',
      fullTitle: 'Creative Commons Attribution 4.0 International',
      url: 'https://creativecommons.org/licenses/by/4.0/',
      summary: 'Others may share, remix, and use this mod for any purpose (including commercial) as long as they credit you.',
      terms: [
        'You must give appropriate credit, provide a link to the license, and indicate if changes were made.',
        'You may share and adapt the material for any purpose, even commercially.',
      ],
    }
  }

  if (!noEdits && noCommercial) {
    return {
      spdx: 'CC-BY-NC-4.0',
      label: 'CC BY-NC 4.0',
      fullTitle: 'Creative Commons Attribution-NonCommercial 4.0 International',
      url: 'https://creativecommons.org/licenses/by-nc/4.0/',
      summary: 'Others may share and remix this mod for non-commercial purposes only, and must credit you.',
      terms: [
        'You must give appropriate credit, provide a link to the license, and indicate if changes were made.',
        'You may not use the material for commercial purposes.',
        'You may share and adapt the material for non-commercial purposes.',
      ],
    }
  }

  if (noEdits && !noCommercial) {
    return {
      spdx: 'CC-BY-ND-4.0',
      label: 'CC BY-ND 4.0',
      fullTitle: 'Creative Commons Attribution-NoDerivatives 4.0 International',
      url: 'https://creativecommons.org/licenses/by-nd/4.0/',
      summary: 'Others may share this mod unmodified (including commercially) with credit, but may not distribute modified versions.',
      terms: [
        'You must give appropriate credit, provide a link to the license, and indicate if changes were made.',
        'If you remix, transform, or build upon the material, you may not distribute the modified material.',
        'You may copy and redistribute the material in any medium or format for any purpose, even commercially.',
      ],
    }
  }

  return {
    spdx: 'CC-BY-NC-ND-4.0',
    label: 'CC BY-NC-ND 4.0',
    fullTitle: 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International',
    url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    summary: 'Others may download and share this mod unmodified with credit, but may not modify it or use it commercially.',
    terms: [
      'You must give appropriate credit, provide a link to the license, and indicate if changes were made.',
      'You may not use the material for commercial purposes.',
      'If you remix, transform, or build upon the material, you may not distribute the modified material.',
    ],
  }
}

export function parseCcLicenseSpdx(spdx: string): CcToggleState | null {
  switch (spdx.trim().toUpperCase()) {
    case 'CC-BY-4.0':
      return { noEdits: false, noCommercial: false }
    case 'CC-BY-NC-4.0':
      return { noEdits: false, noCommercial: true }
    case 'CC-BY-ND-4.0':
      return { noEdits: true, noCommercial: false }
    case 'CC-BY-NC-ND-4.0':
      return { noEdits: true, noCommercial: true }
    default:
      return null
  }
}

export function formatLicenseFileText(options: FormatLicenseFileOptions): string {
  const spdx = options.spdx.trim()
  const parsed = parseCcLicenseSpdx(spdx)
  const cc = parsed ? resolveCcLicense(parsed) : null

  const label = options.label?.trim() || cc?.label || spdx
  const fullTitle = options.fullTitle?.trim() || cc?.fullTitle || spdx
  const url = options.url?.trim() || cc?.url || ''
  const authorDisplay = options.author?.trim() || 'Mod Author'
  const year = options.year ?? new Date().getFullYear()
  const modLine = options.modName?.trim() ? `Mod: ${options.modName.trim()}\n` : ''

  if (cc) {
    const termsBlock = cc.terms.map((t) => `- ${t}`).join('\n')
    return `${fullTitle} (${label})\n\nCopyright © ${year} ${authorDisplay}\n${modLine}\nThis work is licensed under the ${fullTitle} License (${cc.spdx}).\n\nSummary of Terms:\n${termsBlock}\n\nFull License Text:\n${url}\n`
  }

  const urlBlock = url ? `\nFull License Text:\n${url}\n` : ''
  return `${fullTitle}\n\nCopyright © ${year} ${authorDisplay}\n${modLine}\nThis work is licensed under ${spdx}.\n${urlBlock}`
}

export {
  CcLicensePresetPicker,
  type CcLicensePresetPickerProps,
} from '../../components/modals/modinfo/CcLicensePresetPicker'
