import fs from 'node:fs';
import path from 'node:path';
import { fileURLToPath } from 'node:url';

const dist = fileURLToPath(new URL('../dist/', import.meta.url));
const manifestPath = path.join(dist, '.vite', 'manifest.json');
if (!fs.existsSync(manifestPath)) {
    throw new Error('Build with --manifest first: npm run build -- --manifest');
}
const manifest = JSON.parse(fs.readFileSync(manifestPath, 'utf8'));
const seen = new Set();
function visit(key) {
    if (seen.has(key)) return;
    seen.add(key);
    for (const dependency of manifest[key].imports ?? []) visit(dependency);
}
visit('index.html');
for (const [key, chunk] of Object.entries(manifest)) {
    if (chunk.name === 'App') visit(key);
}
const chunks = [...seen].map(key => ({
    file: manifest[key].file,
    bytes: fs.statSync(path.join(dist, manifest[key].file)).size,
}));
console.log(JSON.stringify({ bytes: chunks.reduce((sum, chunk) => sum + chunk.bytes, 0), chunks }, null, 2));
