import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
    plugins: [{ name: 'paint-fixture', setup(build) {
        build.onLoad({ filter: /[\\/]lib[\\/]api[\\/]index\.ts$/ }, () => ({ loader: 'ts', contents: `
            const colors = { color: { isConstant: false, keyframes: [{ time: 0, rgba: [0.2,0.8,1,0] }, { time: 0.5, rgba: [0.5,0.1,1,1] }, { time: 1, rgba: [1,0.2,0.5,0.5] }] }, birthColor: null, fresnelColor: null, lingerColor: null };
            const systems = Array.from({ length: 12 }, (_, i) => ({ key: 's'+i, name: 'Kayn_Skin20_Heartsteel_' + ['Recall', 'Slayer', 'Assassin'][i%3] + '_' + i, emitterKeys: ['e'+i], particleName: null }));
            const model = { systems, systemOrder: systems.map(s => s.key), emitters: systems.map((s,i) => ({ key: 'e'+i, name: ['Glow', 'Trail', 'Spark'][i%3], systemKey: s.key, blendMode: i%5, colors })), materials: [], materialOrder: [], stats: { systemCount: 12, emitterCount: 12, materialCount: 0, colorParamCount: 0 } };
            export async function paintOpen() { return { sessionId: 1, model }; }
            export async function paintClose() {}
            export async function paintModel() { return model; }
            export async function paintSetBlendMode() { return true; }
            export async function paintSetMaterialParam() { return true; }
            export async function paintIsDirty() { return true; }
            export async function paintUndo() { return model; }
            export async function paintRedo() { return model; }
            export async function paintRecolor(...args) { window.recolor = args; return { changed: 1, colors: {} }; }
            export async function paintSetEmitterColor(...args) { window.colorEdit = args; return model; }
            export async function paintSave() { return { saved: 'fixture', checkpointed: true }; }
        ` }));
        build.onLoad({ filter: /[\\/]stores[\\/]index\.ts$/ }, () => ({ loader: 'ts', contents: `export const useNotificationStore = selector => selector({ showToast: () => {} });` }));
    } }],
    absWorkingDir: root, bundle: true, format: 'esm', write: false, outdir: '.tmp/bin-issues',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
    external: ['/fonts/*', '/images/*'],
    stdin: { resolveDir: root, loader: 'tsx', contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { ColorPickerHost } from './src/components/common/ColorPicker';
        import { PaintPanel } from './src/components/preview/paint/PaintPanel';
        import './src/styles/index.css';
        function App() { return <div style={{ height: '100vh' }}><PaintPanel binPath="fixture.bin" /><ColorPickerHost /></div>; }
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
    await page.getByLabel('Select all emitters', { exact: true }).check();
    await page.getByRole('button', { name: 'Recolor (12)', exact: true }).click();
    assert.equal(await page.evaluate(() => window.recolor[1].length), 12);
    await page.screenshot({ path: '../.tmp/flint-paint-hue.png' });
    await page.getByTitle('Recolor mode', { exact: true }).click();
    await page.getByRole('option', { name: 'Palette gradient', exact: true }).click();
    assert.equal(await page.locator('.gradient-stops').count(), 0);
    const count = page.getByRole('slider', { name: 'Palette color count', exact: true });
    await count.press('Home');
    await count.press('ArrowRight');
    await count.press('ArrowRight');
    assert.equal(await page.locator('.palette-swatches__item').count(), 3);
    await page.getByRole('button', { name: 'Palette color 2', exact: true }).click();
    assert.equal(await page.getByRole('dialog').count(), 0);
    await page.getByLabel('Hex color', { exact: true }).fill('#22aaff');
    await page.getByLabel('Palette opacity', { exact: true }).press('Home');
    await page.getByLabel('Hex color', { exact: true }).fill('#33bbff');
    await page.screenshot({ path: '../.tmp/flint-palette-popover.png' });
    await page.keyboard.press('Escape');
    await page.getByRole('button', { name: 'Palette Manager', exact: true }).click();
    await page.getByLabel('Palette name', { exact: true }).fill('Sky');
    await page.getByRole('button', { name: 'Save palette', exact: true }).click();
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await count.press('Home');
    assert.equal(await page.locator('.palette-swatches__item').count(), 1);
    await page.getByRole('button', { name: 'Palette Manager', exact: true }).click();
    await page.getByRole('button', { name: 'Load', exact: true }).click();
    assert.equal(await page.locator('.palette-swatches__item').count(), 3);
    await page.getByRole('button', { name: 'Recolor (12)', exact: true }).click();
    assert.equal(await page.evaluate(() => window.recolor[4].mode), 'linear');
    assert.deepEqual(await page.evaluate(() => window.recolor[3].map(stop => stop.time)), [0, .5, 1]);
    assert.deepEqual(await page.evaluate(() => window.recolor[3][1].vec4), [0.2, 187/255, 1, 0]);
    assert.equal(await page.getByRole('button', { name: 'Undo', exact: true }).textContent(), '');
    assert.equal(await page.getByRole('button', { name: 'Redo', exact: true }).textContent(), '');
    assert.equal(await page.locator('.paint-settings').count(), 0);
    const color = await page.getByLabel('Select all emitters', { exact: true }).evaluate(el => getComputedStyle(el).backgroundColor);
    assert.equal(color, await page.evaluate(() => { const el = document.createElement('span'); el.style.color = 'var(--accent-primary)'; document.body.append(el); const color = getComputedStyle(el).color; el.remove(); return color; }));
    await page.getByLabel('Select all emitters', { exact: true }).uncheck();
    await page.waitForFunction(() => document.querySelectorAll('.paint-row.is-selected').length === 0);
    await page.screenshot({ path: '../.tmp/flint-paint-workspace.png', animations: 'disabled' });
    await page.locator('.paint-block[role=button]').first().click();
    await page.getByRole('radio', { name: 'Color 2', exact: true }).click();
    const square = page.getByRole('slider', { name: 'Saturation and brightness' }).last();
    await square.click({ position: { x: 80, y: 65 } });
    assert.notEqual(await page.getByLabel('Hex color', { exact: true }).last().inputValue(), '#801aff');
    await square.press('ArrowRight');
    await page.getByLabel('Hex color', { exact: true }).last().fill('#ffaa22');
    await page.getByLabel('Alpha', { exact: true }).fill('0.25');
    await page.getByLabel('Red', { exact: true }).fill('2.5');
    const alignment = await page.locator('.paint-color-editor__alpha').evaluate(el => [...el.children].map(child => { const box = child.getBoundingClientRect(); return box.y + box.height / 2; }));
    assert.ok(Math.max(...alignment) - Math.min(...alignment) < 2);
    await page.screenshot({ path: '../.tmp/flint-color-picker.png' });
    await page.getByRole('button', { name: 'Apply color' }).click();
    assert.equal(await page.evaluate(() => window.colorEdit[3]), 1);
    assert.equal(await page.evaluate(() => window.colorEdit[4][0]), 2.5);
    assert.equal(await page.evaluate(() => window.colorEdit[4][3]), 0.25);
    await page.getByRole('button', { name: 'Close', exact: true }).click();
    await page.setViewportSize({ width: 540, height: 800 });
    assert.ok(await page.locator('.paint-panel').evaluate(el => el.scrollWidth <= el.clientWidth));
    assert.deepEqual(errors, []);
    console.log('Paint layout, palette recolor, direct HDR/alpha edits and narrow layout passed.');
} finally {
    await browser?.close();
    server.close();
}
