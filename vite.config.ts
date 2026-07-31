import { defineConfig, Plugin } from 'vite';
import react from '@vitejs/plugin-react';
import path from 'path';
import { existsSync } from 'fs';

// Private shader-preview overlay: when the (gitignored) private/ clone is
// present the @shaderforge alias resolves to the real module, otherwise to
// the committed stub — public checkouts build identically without it.
const shaderforgePrivate = path.resolve(__dirname, 'private/shaderforge/ts/index.ts');
const shaderforgeEntry = existsSync(shaderforgePrivate)
    ? shaderforgePrivate
    : path.resolve(__dirname, 'src/lib/shaderforge-stub/index.ts');

/**
 * Strip `crossorigin` from <link rel="stylesheet"> tags in the built HTML.
 *
 * Tauri 2's `tauri://localhost` custom protocol does not send CORS headers,
 * so the browser silently blocks CSS fetched with a CORS request.  Removing
 * the attribute makes the browser use a normal (no-CORS) fetch instead.
 */
function tauriCSSFix(): Plugin {
    return {
        name: 'tauri-css-fix',
        enforce: 'post',
        transformIndexHtml(html) {
            return html.replace(
                /<link rel="stylesheet" crossorigin/g,
                '<link rel="stylesheet"',
            );
        },
    };
}

export default defineConfig({
    plugins: [react(), tauriCSSFix()],
    clearScreen: false,
    server: {
        port: 1421,
        strictPort: true,
        // NOTE: tried `server.warmup.clientFiles` to pre-transform the entry
        // tree during the WebView2 cold boot — it actually made things
        // worse (+33 s on the page_load Started→Finished phase). Vite's
        // warmup runs the warmup transforms in parallel and the WebView's
        // first real request gets queued behind them. Removed.
    },
    envPrefix: ['VITE_', 'TAURI_'],
    build: {
        target: ['es2021', 'chrome100', 'safari13'],
        minify: !process.env.TAURI_DEBUG ? 'esbuild' : false,
        sourcemap: !!process.env.TAURI_DEBUG,

        // Code splitting for better caching and faster initial load
        rollupOptions: {
            output: {
                manualChunks: (id) => {
                    // Monaco editor workers MUST stay in main bundle for blob: URL worker initialization
                    if (id.includes('monaco-editor') && id.includes('worker')) {
                        return undefined; // Keep in main bundle
                    }
                    // React vendor chunk
                    if (id.includes('node_modules/react') || id.includes('node_modules/react-dom')) {
                        return 'react-vendor';
                    }
                    // Monaco Editor UI (not workers) - lazy loaded
                    if (id.includes('@monaco-editor/react') || id.includes('monaco-editor')) {
                        return 'monaco';
                    }
                    // Three.js 3D rendering - lazy loaded
                    if (id.includes('three') || id.includes('@react-three')) {
                        return 'three';
                    }
                    // Tauri APIs
                    if (id.includes('@tauri-apps')) {
                        return 'tauri-apis';
                    }
                },
            },
        },

        // Increase chunk size warning limit after optimization
        chunkSizeWarningLimit: 600,
    },
    resolve: {
        alias: {
            '@': path.resolve(__dirname, './src'),
            '@shaderforge': shaderforgeEntry,
        },
    },

    // Optimize dependency pre-bundling.
    //
    // CRITICAL for cold-start speed: anything NOT listed here is bundled
    // on-demand when the WebView first imports it. That's what was causing
    // the ~1m29s gap between "Vite ready in 543ms" and `main.tsx` actually
    // executing — Vite was discovering and bundling `three`, `@react-three/*`,
    // each `@tauri-apps/*` entry point, zustand, etc. one-by-one AS the
    // WebView fetched them, and each round-trip blocks the next request.
    //
    // Listing them here pre-bundles everything at server start (one-time,
    // cached in `node_modules/.vite/deps/`). Subsequent starts read from
    // cache. When adding a new heavy dep to package.json, add it here too.
    //
    // If startup is still slow after editing this list, blow the cache:
    //   `rm -rf node_modules/.vite` (then re-run `npm run tauri dev`).
    optimizeDeps: {
        include: [
            // React core
            'react',
            'react-dom',
            'react-dom/client',
            'react/jsx-runtime',

            // Editor
            'monaco-editor',

            // Tauri API surface — each entry point was discovered separately
            // and triggered its own optimization round.
            '@tauri-apps/api/core',
            '@tauri-apps/api/event',
            '@tauri-apps/api/window',
            '@tauri-apps/api/webview',
            '@tauri-apps/api/path',
            '@tauri-apps/api/app',
            '@tauri-apps/plugin-dialog',
            '@tauri-apps/plugin-opener',
            '@tauri-apps/plugin-process',
            '@tauri-apps/plugin-updater',

            // State + virtualization
            'zustand',
            'zustand/react/shallow',
            // (react-window was listed here but is not actually imported by
            //  the app — Flint uses its own `VirtualizedList` in WadExplorer.
            //  Pre-bundling unused deps just slows cold start.)
        ],
    },
});
