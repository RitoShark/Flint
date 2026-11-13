export interface CcToggleState {
  giveCredit?: boolean
  noEdits: boolean
  noCommercial: boolean
  shareAlike?: boolean
}

export interface ResolvedCcLicense {
  spdx:
    | 'CC-BY-4.0'
    | 'CC-BY-SA-4.0'
    | 'CC-BY-ND-4.0'
    | 'CC-BY-NC-4.0'
    | 'CC-BY-NC-SA-4.0'
    | 'CC-BY-NC-ND-4.0'
    | 'CC0-1.0'
  label:
    | 'CC BY 4.0'
    | 'CC BY-SA 4.0'
    | 'CC BY-ND 4.0'
    | 'CC BY-NC 4.0'
    | 'CC BY-NC-SA 4.0'
    | 'CC BY-NC-ND 4.0'
    | 'CC0 1.0'
  fullTitle: string
  url: string
  summary: string
  permissions: string[]
  conditions: string[]
  limitations: string[]
  terms: string[]
}

export interface LicenseCatalogEntry {
  spdx: string
  label: string
  fullTitle: string
  category: 'cc' | 'open-source'
  url: string
  summary: string
  permissions: string[]
  conditions: string[]
  limitations: string[]
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

export const CC_LICENSE_CATALOG: Record<ResolvedCcLicense['spdx'], ResolvedCcLicense> = {
  'CC-BY-4.0': {
    spdx: 'CC-BY-4.0',
    label: 'CC BY 4.0',
    fullTitle: 'Creative Commons Attribution 4.0 International',
    url: 'https://creativecommons.org/licenses/by/4.0/',
    summary: 'Others may share, edit/remix, and use this mod for any purpose (including commercial) as long as they credit you.',
    permissions: ['Share & redistribute', 'Edit & remix', 'Commercial use', 'Private use'],
    conditions: ['Give credit (BY)', 'Indicate changes', 'Include license link'],
    limitations: ['No endorsement claim', 'No warranty'],
    terms: [
      'You must give appropriate credit, provide a link to the license, and indicate if changes were made.',
      'You may share and adapt the material for any purpose, even commercially.',
    ],
  },
  'CC-BY-SA-4.0': {
    spdx: 'CC-BY-SA-4.0',
    label: 'CC BY-SA 4.0',
    fullTitle: 'Creative Commons Attribution-ShareAlike 4.0 International',
    url: 'https://creativecommons.org/licenses/by-sa/4.0/',
    summary: 'Others may share, edit/remix, and use this mod commercially with credit, provided remixes are shared under the same license.',
    permissions: ['Share & redistribute', 'Edit & remix', 'Commercial use', 'Private use'],
    conditions: ['Give credit (BY)', 'Share with same license (SA)', 'Indicate changes', 'Include license link'],
    limitations: ['No re-licensing under different terms', 'No warranty'],
    terms: [
      'You must give appropriate credit, provide a link to the license, and indicate if changes were made.',
      'If you remix, transform, or build upon the material, you must distribute your contributions under the same license as the original.',
      'You may share and adapt the material for any purpose, even commercially.',
    ],
  },
  'CC-BY-ND-4.0': {
    spdx: 'CC-BY-ND-4.0',
    label: 'CC BY-ND 4.0',
    fullTitle: 'Creative Commons Attribution-NoDerivatives 4.0 International',
    url: 'https://creativecommons.org/licenses/by-nd/4.0/',
    summary: 'Others may share this mod unmodified (including commercially) with credit, but may not distribute edited or remixed versions.',
    permissions: ['Share unmodified copies', 'Commercial use', 'Private use'],
    conditions: ['Give credit (BY)', 'Include license link'],
    limitations: ['No edits / derivatives distributed (ND)', 'No warranty'],
    terms: [
      'You must give appropriate credit, provide a link to the license, and indicate if changes were made.',
      'If you remix, transform, or build upon the material, you may not distribute the modified material.',
      'You may copy and redistribute the material in any medium or format for any purpose, even commercially.',
    ],
  },
  'CC-BY-NC-4.0': {
    spdx: 'CC-BY-NC-4.0',
    label: 'CC BY-NC 4.0',
    fullTitle: 'Creative Commons Attribution-NonCommercial 4.0 International',
    url: 'https://creativecommons.org/licenses/by-nc/4.0/',
    summary: 'Others may share and edit/remix this mod for non-commercial purposes only, and must credit you.',
    permissions: ['Share & redistribute', 'Edit & remix', 'Private use'],
    conditions: ['Give credit (BY)', 'Indicate changes', 'Include license link'],
    limitations: ['No commercial use (NC)', 'No warranty'],
    terms: [
      'You must give appropriate credit, provide a link to the license, and indicate if changes were made.',
      'You may not use the material for commercial purposes.',
      'You may share and adapt the material for non-commercial purposes.',
    ],
  },
  'CC-BY-NC-SA-4.0': {
    spdx: 'CC-BY-NC-SA-4.0',
    label: 'CC BY-NC-SA 4.0',
    fullTitle: 'Creative Commons Attribution-NonCommercial-ShareAlike 4.0 International',
    url: 'https://creativecommons.org/licenses/by-nc-sa/4.0/',
    summary: 'Others may share and edit/remix this mod non-commercially with credit, provided remixes use the exact same license.',
    permissions: ['Share & redistribute', 'Edit & remix', 'Private use'],
    conditions: ['Give credit (BY)', 'Share with same license (SA)', 'Indicate changes', 'Include license link'],
    limitations: ['No commercial use (NC)', 'No re-licensing under different terms', 'No warranty'],
    terms: [
      'You must give appropriate credit, provide a link to the license, and indicate if changes were made.',
      'You may not use the material for commercial purposes.',
      'If you remix, transform, or build upon the material, you must distribute your contributions under the same license as the original.',
    ],
  },
  'CC-BY-NC-ND-4.0': {
    spdx: 'CC-BY-NC-ND-4.0',
    label: 'CC BY-NC-ND 4.0',
    fullTitle: 'Creative Commons Attribution-NonCommercial-NoDerivatives 4.0 International',
    url: 'https://creativecommons.org/licenses/by-nc-nd/4.0/',
    summary: 'Others may download and share this mod unmodified with credit, but may not edit it or use it commercially.',
    permissions: ['Share unmodified copies', 'Private use'],
    conditions: ['Give credit (BY)', 'Include license link'],
    limitations: ['No commercial use (NC)', 'No edits / derivatives distributed (ND)', 'No warranty'],
    terms: [
      'You must give appropriate credit, provide a link to the license, and indicate if changes were made.',
      'You may not use the material for commercial purposes.',
      'If you remix, transform, or build upon the material, you may not distribute the modified material.',
    ],
  },
  'CC0-1.0': {
    spdx: 'CC0-1.0',
    label: 'CC0 1.0',
    fullTitle: 'Creative Commons Zero v1.0 Universal',
    url: 'https://creativecommons.org/publicdomain/zero/1.0/',
    summary: 'Public Domain Dedication (No Rights Reserved) — others may copy, edit, and use this mod for any purpose without asking or giving credit.',
    permissions: ['Share & redistribute', 'Edit & remix', 'Commercial use', 'Private use', 'No credit required'],
    conditions: ['None (Public Domain)'],
    limitations: ['No warranty', 'No trademark rights'],
    terms: [
      'The person who associated a work with this deed has dedicated the work to the public domain by waiving all of his or her rights to the work worldwide under copyright law.',
      'You can copy, modify, distribute and perform the work, even for commercial purposes, all without asking permission.',
    ],
  },
}

export const OPEN_SOURCE_LICENSE_CATALOG: Record<string, LicenseCatalogEntry> = {
  MIT: {
    spdx: 'MIT',
    label: 'MIT',
    fullTitle: 'MIT License',
    category: 'open-source',
    url: 'https://opensource.org/license/mit/',
    summary: 'Permissive license letting anyone reuse, modify, and distribute the work as long as the copyright and license notice are preserved.',
    permissions: ['Commercial use', 'Edit & modify', 'Distribution', 'Private use'],
    conditions: ['Include copyright & license notice'],
    limitations: ['No liability', 'No warranty'],
    terms: [
      'Permission is hereby granted, free of charge, to any person obtaining a copy of this software and associated files, to deal in the work without restriction, including without limitation the rights to use, copy, modify, merge, publish, distribute, sublicense, and/or sell copies.',
      'The above copyright notice and this permission notice shall be included in all copies or substantial portions of the work.',
    ],
  },
  'Apache-2.0': {
    spdx: 'Apache-2.0',
    label: 'Apache 2.0',
    fullTitle: 'Apache License 2.0',
    category: 'open-source',
    url: 'https://www.apache.org/licenses/LICENSE-2.0',
    summary: 'Permissive license that also provides an express grant of patent rights and requires stating significant changes.',
    permissions: ['Commercial use', 'Edit & modify', 'Distribution', 'Private use'],
    conditions: ['Include copyright & license notice', 'State changes'],
    limitations: ['No trademark use', 'No liability', 'No warranty'],
    terms: [
      'You may reproduce and distribute copies of the Work or Derivative Works thereof in any medium, with or without modifications, provided that you retain all copyright notices and state any significant changes.',
    ],
  },
  'GPL-3.0-only': {
    spdx: 'GPL-3.0-only',
    label: 'GPL 3.0',
    fullTitle: 'GNU General Public License v3.0',
    category: 'open-source',
    url: 'https://www.gnu.org/licenses/gpl-3.0.html',
    summary: 'Strong copyleft license requiring derivative works and distributions to be shared under the same GPL v3.0 license.',
    permissions: ['Commercial use', 'Edit & modify', 'Distribution', 'Private use'],
    conditions: ['Disclose source', 'Include copyright & license', 'Same license (GPL 3.0)', 'State changes'],
    limitations: ['No liability', 'No warranty'],
    terms: [
      'You may copy, distribute and modify the work as long as you track changes/dates in source files and keep any modifications under the GNU GPL v3.0.',
    ],
  },
  'AGPL-3.0-only': {
    spdx: 'AGPL-3.0-only',
    label: 'AGPL 3.0',
    fullTitle: 'GNU Affero General Public License v3.0',
    category: 'open-source',
    url: 'https://www.gnu.org/licenses/agpl-3.0.html',
    summary: 'Strong copyleft license requiring source disclosure and same-license distribution, including over network services.',
    permissions: ['Commercial use', 'Edit & modify', 'Distribution', 'Private use'],
    conditions: ['Disclose source', 'Include copyright & license', 'Same license (AGPL 3.0)', 'State changes'],
    limitations: ['No liability', 'No warranty'],
    terms: [
      'Permissions of this strongest copyleft license are conditioned on making available complete source code of licensed works and modifications under the same license.',
    ],
  },
  'MPL-2.0': {
    spdx: 'MPL-2.0',
    label: 'MPL 2.0',
    fullTitle: 'Mozilla Public License 2.0',
    category: 'open-source',
    url: 'https://www.mozilla.org/en-US/MPL/2.0/',
    summary: 'File-level copyleft license allowing combination with proprietary files while keeping modified MPL files open.',
    permissions: ['Commercial use', 'Edit & modify', 'Distribution', 'Private use'],
    conditions: ['Disclose source of MPL files', 'Include copyright & license', 'Same license (per file)'],
    limitations: ['No trademark use', 'No liability', 'No warranty'],
    terms: [
      'Modifications to MPL-licensed files must be shared under MPL 2.0, while larger works may combine files under other terms.',
    ],
  },
  'BSD-3-Clause': {
    spdx: 'BSD-3-Clause',
    label: 'BSD 3-Clause',
    fullTitle: 'BSD 3-Clause "New" or "Revised" License',
    category: 'open-source',
    url: 'https://opensource.org/license/bsd-3-clause/',
    summary: 'Permissive license similar to MIT that also prohibits using the author or contributor names for endorsement without permission.',
    permissions: ['Commercial use', 'Edit & modify', 'Distribution', 'Private use'],
    conditions: ['Include copyright & license notice'],
    limitations: ['No endorsement without permission', 'No liability', 'No warranty'],
    terms: [
      'Redistribution and use in source and binary forms, with or without modification, are permitted provided that the copyright notice is retained and the names of contributors are not used to endorse derived products without permission.',
    ],
  },
  Unlicense: {
    spdx: 'Unlicense',
    label: 'Unlicense',
    fullTitle: 'The Unlicense',
    category: 'open-source',
    url: 'https://unlicense.org/',
    summary: 'Public domain dedication with no conditions whatsoever.',
    permissions: ['Commercial use', 'Edit & modify', 'Distribution', 'Private use', 'No credit required'],
    conditions: ['None (Public Domain)'],
    limitations: ['No liability', 'No warranty'],
    terms: [
      'This is free and unencumbered software released into the public domain. Anyone is free to copy, modify, publish, use, compile, sell, or distribute this work for any purpose.',
    ],
  },
}

export function resolveCcLicense(state: CcToggleState): ResolvedCcLicense {
  const giveCredit = state.giveCredit ?? true
  if (!giveCredit) {
    return CC_LICENSE_CATALOG['CC0-1.0']
  }

  const { noEdits, noCommercial } = state
  const shareAlike = !noEdits && Boolean(state.shareAlike)

  if (!noEdits && !noCommercial && !shareAlike) return CC_LICENSE_CATALOG['CC-BY-4.0']
  if (!noEdits && !noCommercial && shareAlike) return CC_LICENSE_CATALOG['CC-BY-SA-4.0']
  if (noEdits && !noCommercial) return CC_LICENSE_CATALOG['CC-BY-ND-4.0']
  if (!noEdits && noCommercial && !shareAlike) return CC_LICENSE_CATALOG['CC-BY-NC-4.0']
  if (!noEdits && noCommercial && shareAlike) return CC_LICENSE_CATALOG['CC-BY-NC-SA-4.0']
  return CC_LICENSE_CATALOG['CC-BY-NC-ND-4.0']
}

export function parseCcLicenseSpdx(spdx: string): CcToggleState | null {
  switch (spdx.trim().toUpperCase()) {
    case 'CC-BY-4.0':
      return { giveCredit: true, noEdits: false, noCommercial: false, shareAlike: false }
    case 'CC-BY-SA-4.0':
      return { giveCredit: true, noEdits: false, noCommercial: false, shareAlike: true }
    case 'CC-BY-ND-4.0':
      return { giveCredit: true, noEdits: true, noCommercial: false, shareAlike: false }
    case 'CC-BY-NC-4.0':
      return { giveCredit: true, noEdits: false, noCommercial: true, shareAlike: false }
    case 'CC-BY-NC-SA-4.0':
      return { giveCredit: true, noEdits: false, noCommercial: true, shareAlike: true }
    case 'CC-BY-NC-ND-4.0':
      return { giveCredit: true, noEdits: true, noCommercial: true, shareAlike: false }
    case 'CC0-1.0':
      return { giveCredit: false, noEdits: false, noCommercial: false, shareAlike: false }
    default:
      return null
  }
}

export function lookupLicenseDetails(spdx: string): LicenseCatalogEntry | null {
  const trimmed = spdx.trim()
  const parsedCc = parseCcLicenseSpdx(trimmed)
  if (parsedCc) {
    const cc = resolveCcLicense(parsedCc)
    return { ...cc, category: 'cc' }
  }
  return OPEN_SOURCE_LICENSE_CATALOG[trimmed] ?? null
}

export function formatLicenseFileText(options: FormatLicenseFileOptions): string {
  const spdx = options.spdx.trim()
  const details = lookupLicenseDetails(spdx)

  const label = options.label?.trim() || details?.label || spdx
  const fullTitle = options.fullTitle?.trim() || details?.fullTitle || spdx
  const url = options.url?.trim() || details?.url || ''
  const authorDisplay = options.author?.trim() || 'Mod Author'
  const year = options.year ?? new Date().getFullYear()
  const modLine = options.modName?.trim() ? `Mod: ${options.modName.trim()}\n` : ''

  if (details) {
    const termsBlock = details.terms.map((t) => `- ${t}`).join('\n')
    const header = fullTitle !== label ? `${fullTitle} (${label})` : fullTitle
    return `${header}\n\nCopyright © ${year} ${authorDisplay}\n${modLine}\nThis work is licensed under the ${fullTitle} (${details.spdx}).\n\nSummary of Terms:\n${termsBlock}\n\nFull License Text:\n${url}\n`
  }

  const urlBlock = url ? `\nFull License Text:\n${url}\n` : ''
  return `${fullTitle}\n\nCopyright © ${year} ${authorDisplay}\n${modLine}\nThis work is licensed under ${spdx}.\n${urlBlock}`
}

export {
  CcLicensePresetPicker,
  type CcLicensePresetPickerProps,
} from '../../components/modals/modinfo/CcLicensePresetPicker'
