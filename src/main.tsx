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
import { initializeLogger, initBackendLogListener } from './lib/util/logger';
import { installButtonGlow } from './lib/ui-helpers/buttonGlow';
import { AppProvider } from './lib/stores';
import { bootUxPrefs } from './lib/stores/uxStore';
import { App } from './components/layout/App';
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
// Title bar polish (glowing logo, design-lab tabs, animated closes)
import './styles/titlebar-polish.css';
// Tutorial overlay polish (frosted callout, spring motion, progress bar)
import './styles/tutorial-polish.css';
// Design lab primitives — usable in the main app via .dl-root scope
import './styles/design-lab.css';
// What's New modal polish
import './styles/whats-new-polish.css';
// Flint 2.0 polish — animated transitions, glassmorphism, FPS-mode kill switch,
// fullscreen setup wizard, theme tab. Loaded LAST so its rules win cleanly.
import './styles/flint-2.css';
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
// Apply user UX prefs (glass / fps / accent) BEFORE first paint so the
// animated background + glow on the setup wizard reads the right tokens.
bootUxPrefs();
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

// Window is now `visible: true` in `tauri.conf.json`, so the boot skeleton in
// `index.html` shows the moment Tauri creates the window — no hidden-window
// limbo while WebView2 boots and Vite serves modules. We just need to attach
// the log listener once React has mounted; previously this was gated on
// `getCurrentWindow().show()` resolving, which deferred it unnecessarily.
if (!isDesignLab) {
    initBackendLogListener();
}
// Touch the window handle (no-op) so the unused-import linter stays quiet —
// some flows still want a Window reference, and we keep the import explicit
// for those callers.
void getCurrentWindow();
console.log(isDesignLab ? '[Flint] Design Lab mounted' : '[Flint] Window already visible (boot skeleton handed off to React)');
