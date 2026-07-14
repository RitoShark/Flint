const __FLINT_JS_START = performance.now();
const __FLINT_JS_START_WALL = new Date().toISOString();
// eslint-disable-next-line no-console
console.log(`[startup] JS entry hit at ${__FLINT_JS_START_WALL} (perf=${__FLINT_JS_START.toFixed(1)}ms since navigationStart)`);

import React from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { initializeLogger, initBackendLogListener } from './lib/util/logger';
import { AppProvider } from './lib/stores';
import { bootUxPrefs } from './lib/stores/uxStore';
import { App } from './components/layout/App';
import { DesignLab } from './components/ui/DesignLab';
import { MapPreviewWindow } from './components/preview/MapPreviewWindow';
import { ThumbnailWindow } from './components/thumbnail/ThumbnailWindow';

import './styles/index.css';
// Must load AFTER index.css to override.
import './styles/ui-primitives.css';
import './styles/settings-polish.css';
import './styles/project-list-polish.css';
import './styles/new-project-polish.css';
import './styles/logger-polish.css';
import './styles/wad-explorer-polish.css';
import './styles/cheat-sheet-polish.css';
import './styles/browse-wad-polish.css';
import './styles/titlebar-polish.css';
import './styles/tutorial-polish.css';
import './styles/design-lab.css';
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

// eslint-disable-next-line no-console
console.log(`[startup] imports resolved in ${(performance.now() - __FLINT_JS_START).toFixed(1)}ms`);

initializeLogger();
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
    isThumbnail
        ? React.createElement(ThumbnailWindow)
        : isMapPreview
            ? React.createElement(MapPreviewWindow)
            : isDesignLab
                ? React.createElement(React.StrictMode, null, React.createElement(DesignLab))
                : React.createElement(
                      React.StrictMode,
                      null,
                      React.createElement(AppProvider, null, React.createElement(App))
                  )
);

if (!isDesignLab) {
    initBackendLogListener();
}
void getCurrentWindow();
console.log(isDesignLab ? '[Flint] Design Lab mounted' : '[Flint] Window already visible (boot skeleton handed off to React)');
