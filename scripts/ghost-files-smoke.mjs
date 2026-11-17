import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
    plugins: [{ name: 'fixture-hook', setup(build) {
        build.onLoad({ filter: /[\\/]lib[\\/]api[\\/]index\.ts$/ }, () => ({ loader: 'ts', contents: `
            export async function scanGameWads() { return [{ name: 'ahri.wad.client', path: 'game/ahri.wad.client' }]; }
            export async function getWadChunks() { return [
                { hash: '0000000000000001', path: 'assets/needed.tex', size: 10 },
                { hash: '0000000000000002', path: 'assets/present.tex', size: 10 },
                { hash: '0000000000000003', path: 'assets/unrelated.tex', size: 10 }
            ]; }
            export async function listProjectLayers() { return [{ name: 'base' }, { name: 'effects' }]; }
            export async function listProjectFiles() { return {}; }
        ` }));
        build.onLoad({ filter: /[\\/]lib[\\/]api[\\/]core\.ts$/ }, () => ({ loader: 'ts', contents: `
            export async function invokeCommand(command, args) {
                if (command === 'project_ghost_inventory') return { present: ['ahri.wad.client/0000000000000002'], references: ['0000000000000001', '0000000000000002'], wads: ['ahri.wad.client'] };
                if (command === 'bring_ghost_to_layer') { window.brought = args; return 'project/content/effects/ahri.wad.client/assets/needed.tex'; }
            }
        ` }));
        build.onLoad({ filter: /[\\/]stores[\\/]index\.ts$/ }, () => ({ loader: 'ts', contents: `
            const state = { leaguePath: 'game', setFileTree: () => { window.refreshed = true; } };
            const store = Object.assign(selector => selector(state), { getState: () => state });
            export const useConfigStore = store, useProjectTabStore = store;
        ` }));
        build.onLoad({ filter: /ChunkPreview\.tsx$/ }, () => ({ loader: 'tsx', contents: `
            import React from 'react';
            export function ChunkPreview({ chunk }) { return <p>Read-only preview: {chunk.path}</p>; }
        ` }));
    } }],
    absWorkingDir: root, bundle: true, format: 'esm', write: false, outdir: '.tmp/bin-issues',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
    external: ['/fonts/*', '/images/*'],
    stdin: { resolveDir: root, loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { ProjectGhostFiles } from './src/components/browser/ProjectGhostFiles';
        import './src/styles/index.css';
        createRoot(document.getElementById('root')).render(<div style={{ width: 340, height: '100vh', display: 'flex', flexDirection: 'column' }}>
            <ProjectGhostFiles tab={{ id: 'project', projectPath: 'project', project: { champion: 'Ahri' } }} />
        </div>);
    ` },
});
const js = bundle.outputFiles.find(file => file.path.endsWith('.js')).contents;
const css = bundle.outputFiles.find(file => file.path.endsWith('.css')).contents;
const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/app.js' ? 'application/javascript' : req.url === '/app.css' ? 'text/css' : 'text/html');
    res.end(req.url === '/app.js' ? js : req.url === '/app.css' ? css : '<html><head><link rel="stylesheet" href="/app.css"></head><body><div id="root"></div><script type="module" src="/app.js"></script></body></html>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({ channel: 'msedge', headless: true });
    const page = await browser.newPage({ viewport: { width: 1280, height: 900 } });
    const errors = [];
    page.on('pageerror', error => errors.push(String(error)));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await page.getByRole('button', { name: 'Game files +' }).click();
    await page.locator('summary').filter({ hasText: 'ahri.wad.client' }).click();
    await page.getByText('1 available files', { exact: true }).waitFor();
    await page.locator('summary').filter({ hasText: /^assets$/ }).click();
    assert.equal(await page.getByRole('button', { name: 'present.tex', exact: true }).count(), 0);
    assert.equal(await page.getByRole('button', { name: 'unrelated.tex', exact: true }).count(), 0);
    await page.getByRole('button', { name: 'needed.tex', exact: true }).click();
    await page.getByText('Read-only preview: assets/needed.tex').waitFor();
    await page.getByLabel('Layer', { exact: true }).selectOption('effects');
    await page.getByRole('button', { name: 'Bring to layer', exact: true }).click();
    await page.getByText('0 available files', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.brought.layer), 'effects');
    assert.equal(await page.evaluate(() => window.brought.assetPath), 'assets/needed.tex');
    assert.equal(await page.evaluate(() => window.refreshed), true);
    assert.deepEqual(errors, []);
    console.log('Referenced-only ghost filtering, preview, layer selection and refresh passed.');
} finally {
    await browser?.close();
    server.close();
}
