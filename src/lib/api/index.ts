/**
 * Flint API — Tauri command bridge layer.
 *
 * This barrel re-exports every domain module so consumers can keep using
 * `import * as api from '../lib/api'` exactly as before. New code can also
 * cherry-pick from a specific module (e.g. `import { readFileBytes } from
 * '../lib/api/file'`) when only one slice is needed.
 *
 * Each module owns a single domain. If you're adding a new Tauri command,
 * pick the matching file (or create a new one and re-export it here).
 *   - core           — FlintError, invokeCommand/invokeRaw, IPC tracing
 *   - logging        — log-level toggle
 *   - hash           — WAD path hash DB
 *   - league         — League install detection
 *   - champion       — champion + skin lookups
 *   - project        — project lifecycle (create/open/save/layers)
 *   - map            — map-project lifecycle
 *   - mapPreview     — separate-window 3D map preview (geometry + textures)
 *   - ltk            — LTK Manager / Celestial / watcher integration
 *   - wad            — WAD read / extract / chunk APIs
 *   - wadEdit        — in-memory WAD edit sessions
 *   - bin            — BIN ↔ ritobin / JSON conversions
 *   - binSplit       — BIN split / organize-vfx
 *   - file           — file IO + management + folder grid
 *   - texture        — DDS/TEX/PNG conversions + preview decoding
 *   - mesh           — SKN/SCB/SKL/animation
 *   - animask        — animation mask blend weights
 *   - audio          — BNK/WPK editor
 *   - checkpoint     — project history
 *   - export         — fantome / modpkg export
 *   - import         — fantome / modpkg import
 *   - hashOverlay    — project-local hash overlay build/clear
 *   - hud            — HUD editor
 *   - externalApps   — Jade/Quartz launch + Windows file associations
 *   - shell          — pending Explorer-verb action (ShellAction/PendingFileOpen)
 *   - dev            — schema aggregation (dev-only)
 *   - settings       — disk-backed settings + themes
 *   - updater        — self-update
 *   - compare        — find-original / per-file backups
 *   - chroma         — chroma porting
 *   - thumbnail      — standalone Thumbnail Creator window
 */

export * from './core';
export * from './logging';
export * from './hash';
export * from './league';
export * from './champion';
export * from './project';
export * from './map';
export * from './mapPreview';
export * from './ltk';
export * from './wad';
export * from './wadEdit';
export * from './modpkgEdit';
export * from './archiveEdit';
export * from './bin';
export * from './binSplit';
export * from './file';
export * from './texture';
export * from './mesh';
export * from './animask';
export * from './audio';
export * from './checkpoint';
export * from './export';
export * from './import';
export * from './hashOverlay';
export * from './hud';
export * from './externalApps';
export * from './shell';
export * from './dev';
export * from './legacyFormats';
export * from './settings';
export * from './updater';
export * from './loadscreenBanner';
export * from './compare';
export * from './chroma';
export * from './taskbar';
export * from './cdn';
export * from './thumbnail';
export * from './skinFixer';
