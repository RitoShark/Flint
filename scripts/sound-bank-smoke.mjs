import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({
    plugins: [{ name: 'fixture-hook', setup(build) {
        build.onLoad({ filter: /[\\/]lib[\\/]api[\\/]dialog\.ts$/ }, () => ({ loader: 'ts', contents: "export async function open() { return 'fixture/voice.bin'; } export async function save() { return null; }" }));
        build.onLoad({ filter: /[\\/]lib[\\/]api[\\/]core\.ts$/ }, () => ({ loader: 'ts', contents: `
            export class FlintError extends Error {}
            export const utf8Decoder = new TextDecoder();
            export async function invokeRaw() { return []; }
            export async function invokeCommand(command, args) {
                if (command === 'parse_audio_bank') return { format: 'bnk', entry_count: 2, version: 134, has_hirc: false, entries: [{ id: 1001, size: 42000 }, { id: 1002, size: 28000 }] };
                if (command === 'read_voice_document') return { version: 'fixture', fields: [{ id: 0, label: 'Attack / ContextualActionPlayAudio / EventName', kind: 'string', value: 'Play_Evelynn_Attack' }, { id: 1, label: 'Attack / Chance', kind: 'float', value: 0.5 }] };
                if (command === 'save_voice_document') { window.voiceSave = args; return { version: 'saved', fields: [] }; }
                return null;
            }
        ` }));
        build.onLoad({ filter: /[\\/]stores[\\/]index\.ts$/ }, () => ({ loader: 'ts', contents: `
            const state = { openTabs: [], activeTabId: null, fileVersionsRev: 0, getFileVersion: () => 0, incrementFileVersion: () => {}, showToast: () => {}, openConfirm: () => {} };
            const store = Object.assign(selector => selector(state), { getState: () => state });
            export const useAppMetadataStore = store, useProjectTabStore = store, useNotificationStore = store, useModalStore = store, useConfigStore = store;
        ` }));
    } }],
    absWorkingDir: root, bundle: true, format: 'esm', write: false, outdir: '.tmp/bin-issues',
    loader: { '.woff2': 'dataurl', '.woff': 'dataurl', '.ttf': 'dataurl', '.png': 'dataurl', '.svg': 'dataurl' },
    external: ['/fonts/*', '/images/*'],
    stdin: { resolveDir: root, loader: 'tsx', contents: `
        import React from 'react';
        import { createRoot } from 'react-dom/client';
        import { BnkPreview } from './src/components/preview/BnkPreview';
        import './src/styles/index.css';
        function App() {
            return <div style={{ height: '100vh' }}><BnkPreview filePath="fixture/evelynn_audio.bnk" /></div>;
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
    await page.getByText('1001.wem', { exact: true }).click();
    await page.getByRole('heading', { name: 'WEM 1001', exact: true }).waitFor();
    await page.getByRole('button', { name: 'Replace audio...', exact: true }).waitFor();
    await page.screenshot({ path: '../.tmp/flint-sound-bank-workflows.png' });
    await page.getByRole('button', { name: 'Voice rules', exact: true }).click();
    await page.getByRole('button', { name: 'Choose voice BIN...' }).click();
    await page.getByLabel('Attack / ContextualActionPlayAudio / EventName').fill('Play_Evelynn_Custom');
    assert.ok(await page.locator('.voice-editor__field').first().evaluate(el => el.getBoundingClientRect().height) <= 40);
    await page.getByRole('button', { name: 'Media', exact: true }).click();
    await page.getByRole('button', { name: 'Voice rules', exact: true }).click();
    assert.equal(await page.getByLabel('Attack / ContextualActionPlayAudio / EventName').inputValue(), 'Play_Evelynn_Custom');
    await page.screenshot({ path: '../.tmp/flint-compact-voice-rules.png' });
    await page.getByRole('button', { name: 'Save voice rules', exact: true }).click();
    await page.getByText('No ContextualActionData entries in this BIN. Open the skin\'s voice-rules BIN.').waitFor();
    assert.deepEqual(await page.evaluate(() => window.voiceSave.edits), [{ id: 0, value: 'Play_Evelynn_Custom' }]);
    assert.deepEqual(errors, []);
    console.log('Sound-bank inspector and structured voice edits passed.');
} finally {
    await browser?.close();
    server.close();
}
