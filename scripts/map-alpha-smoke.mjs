import { chromium } from 'playwright';
import { build } from 'esbuild';
import { createServer } from 'node:http';
import { fileURLToPath } from 'node:url';
import assert from 'node:assert/strict';

const root = fileURLToPath(new URL('../', import.meta.url));
const bundle = await build({ absWorkingDir: root, entryPoints: ['scripts/map-alpha-smoke.ts'], bundle: true, format: 'esm', write: false });
const server = createServer((req, res) => {
    res.setHeader('Content-Type', req.url === '/test.js' ? 'application/javascript' : 'text/html');
    res.end(req.url === '/test.js' ? bundle.outputFiles[0].contents : '<canvas width="64" height="64"></canvas><script type="module" src="/test.js"></script>');
});
await new Promise(resolve => server.listen(0, '127.0.0.1', resolve));
let browser;
try {
    browser = await chromium.launch({ channel: 'chromium', headless: true, args: ['--enable-webgl', '--ignore-gpu-blocklist'] });
    const page = await browser.newPage();
    const errors = [];
    page.on('pageerror', error => { errors.push(String(error)); console.error(error); });
    page.on('console', message => console.log(message.text()));
    await page.goto(`http://127.0.0.1:${server.address().port}`);
    await Promise.race([
        page.waitForFunction(() => window.mapAlphaResult, undefined, { timeout: 60000 }),
        new Promise((_, reject) => page.once('pageerror', reject)),
    ]);
    const result = await page.evaluate(() => window.mapAlphaResult);
    assert.deepEqual(errors, []);
    for (const format of ['bc1', 'rgba']) {
        for (const mode of ['fallback', 'terrain']) {
            const name = `${format}-${mode}`;
            assert.equal(result[`${name}-0`], 0, `${name}: opaque material must cover transparent texels`);
            assert.ok(result[`${name}-0.5`] > 400 && result[`${name}-0.5`] < 624, `${name}: half of the texture must be cut out`);
        }
    }
    console.log('Map alpha rendering passed:', result);
} finally {
    await browser?.close();
    server.close();
}
