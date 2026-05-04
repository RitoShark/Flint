/**
 * Flint - League of Legends Modding IDE
 * React Entry Point
 */

// === Startup timing instrumentation ===
// Logged BEFORE any imports do real work so we can attribute time spent
// before this point to Vite/WebView (bundle parse, optimizeDeps, etc.)
// rather than our own code. Compare against Rust's "Flint starting..."
// timestamp — the gap is the cost of the JS bundle reaching this line.
const __FLINT_JS_START = performance.now();
const __FLINT_JS_START_WALL = new Date().toISOString();
// eslint-disable-next-line no-console
console.log(`[startup] JS entry hit at ${__FLINT_JS_START_WALL} (perf=${__FLINT_JS_START.toFixed(1)}ms since navigationStart)`);

import React from 'react';
import { createRoot } from 'react-dom/client';
import { getCurrentWindow } from '@tauri-apps/api/window';
import { initializeLogger, initBackendLogListener } from './lib/logger';
import { installButtonGlow } from './lib/buttonGlow';
import { AppProvider } from './lib/stores';
import { App } from './components/App';
import { DesignLab } from './components/ui/DesignLab';

// Import styles
import './styles/index.css';
// Modernized component layer — must load AFTER index.css to override
import './styles/ui-primitives.css';
// Settings polish + Picker styles — load after primitives
import './styles/settings-polish.css';
// Fixer modal polish — load after settings
import './styles/fixer-polish.css';
// Project list modal polish
import './styles/project-list-polish.css';
// New project modal polish
import './styles/new-project-polish.css';
// Logger / status-bar polish
import './styles/logger-polish.css';
// WAD Explorer polish
import './styles/wad-explorer-polish.css';
// WAD Cheat Sheet modal polish
import './styles/cheat-sheet-polish.css';
// Browse-WAD modal
import './styles/browse-wad-polish.css';
// Design lab primitives — usable in the main app via .dl-root scope
import './styles/design-lab.css';
// Import default theme (can be swapped via custom theme import)
import './themes/default.css';

// Hash bypass: opening with #design-lab loads the new-design showcase
// without booting any app state. Live-reloads via Vite the same as the app.
const isDesignLab =
    typeof window !== 'undefined' &&
    (window.location.hash === '#design-lab' || window.location.search.includes('lab'));

// eslint-disable-next-line no-console
console.log(`[startup] imports resolved in ${(performance.now() - __FLINT_JS_START).toFixed(1)}ms`);

// Initialize logger BEFORE React mounts to capture early logs
initializeLogger();
// Cursor-following glow on .btn — delegated, zero per-button overhead
installButtonGlow();

// Initialize app
const container = document.getElementById('app');
if (!container) {
    throw new Error('[Flint] Could not find #app element');
}

// Remove loading screen
const loadingScreen = document.getElementById('loading-screen');
if (loadingScreen) {
    loadingScreen.remove();
}

const root = createRoot(container);
// eslint-disable-next-line no-console
console.log(`[startup] root.render() at +${(performance.now() - __FLINT_JS_START).toFixed(1)}ms from JS entry`);
root.render(
    isDesignLab
        ? React.createElement(React.StrictMode, null, React.createElement(DesignLab))
        : React.createElement(
              React.StrictMode,
              null,
              React.createElement(AppProvider, null, React.createElement(App))
          )
);

// Show window after React has mounted and painted
// Use requestAnimationFrame to ensure the DOM is ready
requestAnimationFrame(() => {
    requestAnimationFrame(() => {
        getCurrentWindow()
            .show()
            .then(() => {
                console.log(isDesignLab ? '[Flint] Design Lab mounted' : '[Flint] Window shown successfully');
                // Initialize backend log listener after window is ready (skip in lab mode)
                if (!isDesignLab) initBackendLogListener();
            })
            .catch((err) => {
                console.error('[Flint] Failed to show window:', err);
            });
    });
});
