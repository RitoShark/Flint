import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
    absWorkingDir: root, bundle: true, format: 'esm', write: false, outdir: '.tmp/bin-issues',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
    external: ['/fonts/*', '/images/*'],
    stdin: { resolveDir: root, loader: 'tsx', contents: `
        import React, { useState } from 'react';
        import { createRoot } from 'react-dom/client';
        import { BinIssueModal } from './src/components/preview/BinIssueModal';
        import './src/styles/index.css';
        const initial = [
            { code: 'bin.old-vfx-shape', severity: 'warning', file: 'ahri.bin', message: '12 emitters use the old VFX shape layout.' },
            { code: 'bin.stale-sampler-field', severity: 'warning', file: 'ahri.bin', message: 'Material sampler fields use retired names.' },
            { code: 'bin.hash-ref-not-migrated', severity: 'critical', file: 'ahri.bin', message: 'Texture references use hash instead of file.', line: 44 },
            { code: 'bin.missing-ref', severity: 'warning', file: 'ahri.bin', message: 'Missing referenced texture.', paths: ['assets/characters/ahri/skins/skin01/ahri_diffuse.tex'] },
        ];
        function App() {
            const [open, setOpen] = useState(true);
            const [issues, setIssues] = useState(initial);
            const [dirty, setDirty] = useState(false);
            const [busy, setBusy] = useState(false);
            const [result, setResult] = useState(null);
            return <BinIssueModal open={open} issues={issues} dirty={dirty} busy={busy} result={result} error={null}
                onClose={() => setOpen(false)} onGoToLine={() => setOpen(false)}
                onSave={() => { setIssues([]); setDirty(false); setResult(null); }}
                onRepair={kind => { window.repairKind = kind; setBusy(true); setTimeout(() => {
                    setBusy(false); setDirty(true); setResult({ text: '', metadata_version: '16.22', report: {
                        changed: 3, repaired: ['Migrated 12 VFX shapes', 'Updated material sampler fields'],
                        blocked: ['Texture: original asset path is unknown.']
                    }});
                }, 100); }} />;
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
    await page.getByRole('heading', { name: 'BIN issues (4)' }).waitFor();
    assert.equal(await page.locator('.bin-issues__item').count(), 4);
    await page.getByRole('button', { name: 'Review 1', exact: true }).click();
    assert.equal(await page.locator('.bin-issues__item').count(), 1);
    await page.getByText('ahri_diffuse.tex', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Inspect source' }).count(), 0);
    await page.getByRole('button', { name: 'All 4', exact: true }).click();
    await page.getByRole('textbox', { name: 'Search issues' }).fill('sampler');
    assert.equal(await page.locator('.bin-issues__item').count(), 1);
    await page.getByRole('button', { name: 'Repair material samplers', exact: true }).waitFor();
    await page.getByRole('textbox', { name: 'Search issues' }).fill('');
    if (process.env.FLINT_ISSUES_SCREENSHOT) await page.screenshot({ path: process.env.FLINT_ISSUES_SCREENSHOT });
    await page.getByRole('button', { name: 'Fix all safe issues', exact: true }).click();
    await page.getByText('3 repairs applied to the editor', { exact: true }).waitFor();
    assert.equal(await page.evaluate(() => window.repairKind), 'all');
    await page.getByText('Texture: original asset path is unknown.', { exact: true }).waitFor();
    await page.setViewportSize({ width: 640, height: 780 });
    const box = await page.locator('.modal--bin-issues').boundingBox();
    assert.ok(box.x >= 0 && box.x + box.width <= 640);
    assert.ok(box.y >= 0 && box.y + box.height <= 780);
    await page.getByRole('button', { name: 'Save and recheck', exact: true }).click();
    await page.getByText('No issues found in the saved file.', { exact: true }).waitFor();
    assert.equal(await page.getByRole('button', { name: 'Fix all safe issues', exact: true }).isDisabled(), true);
    await page.keyboard.press('Escape');
    await page.locator('.modal--bin-issues').waitFor({ state: 'detached' });
    assert.deepEqual(errors, []);
    console.log('BIN Issues modal: filtering, guidance, repairs, results, save/recheck, narrow layout and Escape passed.');
} finally {
    await browser?.close();
    server.close();
}
