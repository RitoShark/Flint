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
import { LoadingView } from './components/ui/LoadingView';

import './styles/index.css';

const App = React.lazy(() => import('./components/layout/App').then(module => ({ default: module.App })));
const DesignLab = React.lazy(() => import('./components/ui/DesignLab').then(module => ({ default: module.DesignLab })));
const MapPreviewWindow = React.lazy(() => import('./components/preview/MapPreviewWindow').then(module => ({ default: module.MapPreviewWindow })));
const ThumbnailWindow = React.lazy(() => import('./components/thumbnail/ThumbnailWindow').then(module => ({ default: module.ThumbnailWindow })));

const isDesignLab =
    typeof window !== 'undefined' &&
    (window.location.hash === '#design-lab' || window.location.search.includes('lab'));

const isMapPreview =
    typeof window !== 'undefined' && window.location.hash.startsWith('#map-preview');

const isThumbnail =
    typeof window !== 'undefined' && window.location.hash.startsWith('#thumbnail');

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
    React.createElement(React.Suspense, { fallback: React.createElement(LoadingView) },
        isThumbnail
            ? React.createElement(ThumbnailWindow)
            : isMapPreview
                ? React.createElement(MapPreviewWindow)
                : isDesignLab
                    ? React.createElement(React.StrictMode, null, React.createElement(DesignLab, { standalone: true }))
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
    )
);

if (!isDesignLab) {
    initBackendLogListener();
}
void getCurrentWindow();
console.log(isDesignLab ? '[Flint] Design Lab mounted' : '[Flint] Main frontend mounted behind startup gate');
