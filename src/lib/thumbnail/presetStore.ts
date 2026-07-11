import { parsePresetFile, PresetFile } from './presetFile';

/**
 * Local persistence for user-saved thumbnail presets (localStorage). "Save
 * preset" writes here so presets survive closing/reopening the Thumbnail
 * window — the in-memory session list alone would lose them. Export/Import
 * (to a .json file) is separate and for sharing between machines.
 */
const KEY = 'flint.thumbnail.presets.v1';

export interface StoredPreset {
  id: string;
  file: PresetFile;
}

/** Load all saved presets. Corrupt/invalid entries are skipped, not fatal. */
export function loadStoredPresets(): StoredPreset[] {
  try {
    const raw = localStorage.getItem(KEY);
    if (!raw) return [];
    const arr = JSON.parse(raw);
    if (!Array.isArray(arr)) return [];
    const out: StoredPreset[] = [];
    for (const entry of arr) {
      if (!entry || typeof entry.id !== 'string') continue;
      try {
        // Re-validate the stored file through the same parser used for imports.
        out.push({ id: entry.id, file: parsePresetFile(JSON.stringify(entry.file)) });
      } catch {
        // skip a corrupt entry
      }
    }
    return out;
  } catch {
    return [];
  }
}

/** Persist the full preset list (overwrites). */
export function saveStoredPresets(presets: StoredPreset[]): void {
  try {
    localStorage.setItem(KEY, JSON.stringify(presets));
  } catch {
    // storage full / unavailable — non-fatal; session list still works.
  }
}
