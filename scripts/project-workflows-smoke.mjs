import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
    plugins: [{ name: 'fixture-hook', setup(build) {
        build.onLoad({ filter: /useModInfo\.ts$/ }, () => ({ loader: 'ts', contents: `
            import { useState } from 'react';
            export function useModInfo() {
                const [draft, setDraft] = useState({ displayName: 'Elysian Angel Evelynn', version: '1.0.0', description: 'A custom skin with luminous wings and recolored effects.', authors: [{ name: 'SirDexal', role: 'Creator' }], champions: ['Evelynn'], maps: [], tags: ['champion-skin'], thumbnail: '', licenseKind: 'none', licenseName: '', licenseUrl: '', licenseSpdx: '' });
                return { draft, slug: 'elysian-angel-evelynn', dirty: true, saving: false, rawJson: JSON.stringify(draft), update: patch => setDraft(old => ({ ...old, ...patch })), save: async () => true };
            }
        ` }));
    } }],
    absWorkingDir: root, bundle: true, format: 'esm', write: false, outdir: '.tmp/bin-issues',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
    external: ['/fonts/*', '/images/*'],
    stdin: { resolveDir: root, loader: 'tsx', contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ModConfigEditor } from './src/components/preview/ModConfigEditor';
        import { ColorValueEditor } from './src/components/preview/paint/ColorValueEditor';
        import './src/styles/index.css';
        function App() {
            const [color, setColor] = useState(false);
            return <div style={{ height: '100vh' }}><button onClick={() => setColor(true)}>Test color editor</button>
                <ModConfigEditor filePath="fixture/mod.config.json" />
                {color && <ColorValueEditor title="Emitter colors" colors={[{ time: 0, rgba: [1,0,0,1] }, { time: 1, rgba: [0,0,1,.5] }]}
                    onClose={() => setColor(false)} onApply={async (index, value) => { window.colorEdit = { index, value }; }} />}
            </div>;
        }
        createRoot(document.getElementById('root')).render(<App />);
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
    await page.getByRole('button', { name: 'Overview', exact: true }).waitFor();
    await page.getByLabel('Display name', { exact: true }).fill('Elysian Angel');
    await page.getByRole('heading', { name: 'Elysian Angel', exact: true }).waitFor();
    assert.equal(await page.locator('.mi-card:visible').count(), 1);
    await page.getByRole('button', { name: 'People & targets', exact: true }).click();
    assert.equal(await page.locator('.mi-card:visible').count(), 1);
    await page.getByRole('button', { name: 'License & credits', exact: true }).click();
    assert.equal(await page.locator('.mi-card:visible').count(), 1);
    await page.getByRole('button', { name: 'Overview', exact: true }).click();
    await page.screenshot({ path: '../.tmp/flint-project-workflows.png' });
    await page.evaluate(() => { document.querySelector('.mi-inline').style.width = '520px'; });
    assert.ok(await page.evaluate(() => document.querySelector('.mi-inline').scrollWidth <= 520));
    await page.getByRole('button', { name: 'Test color editor' }).click();
    await page.getByRole('radio', { name: 'Color 2' }).click();
    await page.getByLabel('Red', { exact: true }).fill('2.5');
    await page.getByLabel('Alpha', { exact: true }).fill('0.25');
    await page.getByRole('button', { name: 'Apply color' }).click();
    assert.deepEqual(await page.evaluate(() => window.colorEdit), { index: 1, value: [2.5, 0, 1, 0.25] });
    assert.deepEqual(errors, []);
    console.log('Project information tabs, narrow layout and individual color editing passed.');
} finally {
    await browser?.close();
    server.close();
}
