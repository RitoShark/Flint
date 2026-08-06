const __FLINT_JS_START = performance.now();
const __FLINT_JS_START_WALL = new Date().toISOString();
// eslint-disable-next-line no-console
console.log(`[startup] JS entry hit at ${__FLINT_JS_START_WALL} (perf=${__FLINT_JS_START.toFixed(1)}ms since navigationStart)`);

import React from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { invoke } from '@tauri-apps/api/core';
import { initializeLogger, initBackendLogListener } from './lib/util/logger';
import { shaderForgeAvailable } from '@shaderforge';
import { AppProvider } from './lib/stores';
import { useConfigStore } from './lib/stores/configStore';
import { bootUxPrefs } from './lib/stores/uxStore';
import { App } from './components/layout/App';
import { DesignLab } from './components/ui/DesignLab';
import { MapPreviewWindow } from './components/preview/MapPreviewWindow';
import { ThumbnailWindow } from './components/thumbnail/ThumbnailWindow';
import { ModelEditorWindow } from './components/editor3d/ModelEditorWindow';

import './styles/index.css';
// Must load AFTER index.css to override.
import './styles/ui-primitives.css';
import './styles/settings-polish.css';
import './styles/project-list-polish.css';
import './styles/new-project-polish.css';
import './styles/logger-polish.css';
import './styles/wad-explorer-polish.css';
import './styles/cheat-sheet-polish.css';
import './styles/shortcut-cheatsheet.css';
import './styles/browse-wad-polish.css';
import './styles/archive-editor-polish.css';
import './styles/titlebar-polish.css';
import './styles/skin-fixer.css';
import './styles/tutorial-polish.css';
import './styles/design-lab.css';
import './styles/cdn.css';
import './styles/importMod.css';
import './styles/whats-new-polish.css';
// Loaded LAST so its rules win cleanly.
import './styles/flint-2.css';
import './themes/default.css';

const isDesignLab =
    typeof window !== 'undefined' &&
    (window.location.hash === '#design-lab' || window.location.search.includes('lab'));

const isMapPreview =
    typeof window !== 'undefined' && window.location.hash.startsWith('#map-preview');

const isThumbnail =
    typeof window !== 'undefined' && window.location.hash.startsWith('#thumbnail');

const isModelEditor =
    typeof window !== 'undefined' && window.location.hash.startsWith('#model-editor');

function StartupReadySignal() {
    const hydrated = useConfigStore((state) => state._hydrated);
    React.useEffect(() => {
        if (!hydrated) return;
        let cancelled = false;
        void (async () => {
            if (document.fonts?.ready) {
                await Promise.race([
                    document.fonts.ready,
                    new Promise<void>((resolve) => window.setTimeout(resolve, 600)),
                ]);
            }
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            await new Promise<void>((resolve) => requestAnimationFrame(() => resolve()));
            if (!cancelled) {
                await invoke('startup_main_ready').catch((error) => {
                    console.error('[startup] main-ready handshake failed:', error);
                });
            }
        })();
        return () => { cancelled = true; };
    }, [hydrated]);
    return null;
}

// eslint-disable-next-line no-console
console.log(`[startup] imports resolved in ${(performance.now() - __FLINT_JS_START).toFixed(1)}ms`);

initializeLogger();
// eslint-disable-next-line no-console
console.log(`[startup] shader preview module: ${shaderForgeAvailable ? 'available' : 'stub'}`);
// bootUxPrefs() applies the persisted button-glow preference, which attaches
// the cursor listener only when the user has opted in.
bootUxPrefs();

const container = document.getElementById('app');
if (!container) {
    throw new Error('[Flint] Could not find #app element');
}

const loadingScreen = document.getElementById('loading-screen');
if (loadingScreen) {
    loadingScreen.remove();
}

const root = createRoot(container);
// eslint-disable-next-line no-console
console.log(`[startup] root.render() at +${(performance.now() - __FLINT_JS_START).toFixed(1)}ms from JS entry`);
root.render(
    isModelEditor
        ? React.createElement(ModelEditorWindow)
        : isThumbnail
            ? React.createElement(ThumbnailWindow)
            : isMapPreview
                ? React.createElement(MapPreviewWindow)
                : isDesignLab
                    ? React.createElement(React.StrictMode, null, React.createElement(DesignLab))
                    : React.createElement(
                          React.StrictMode,
                          null,
                          React.createElement(
                              AppProvider,
                              null,
                              React.createElement(App),
                              React.createElement(StartupReadySignal),
                          )
                      )
);

if (!isDesignLab) {
    initBackendLogListener();
}
void getCurrentWindow();
console.log(isDesignLab ? '[Flint] Design Lab mounted' : '[Flint] Main frontend mounted behind startup gate');
