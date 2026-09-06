// Explicit developer command: validate and stage our patched server locally.
// It is never invoked by application startup or by the release workflow.
import { execFileSync } from 'node:child_process';
import { createHash } from 'node:crypto';
import { copyFileSync, mkdirSync, readFileSync, renameSync, writeFileSync } from 'node:fs';
import { dirname, join, resolve } from 'node:path';
import { fileURLToPath } from 'node:url';

if (!process.argv[2]) {
    console.error('Usage: node scripts/lsp/stage-dev.mjs <path-to-patched-ritobin-lsp.exe>');
    process.exit(1);
}
const scripts = dirname(fileURLToPath(import.meta.url));
const root = resolve(scripts, '../..');
const binary = resolve(process.argv[2]);

// Requires the upstream metadata fixture beside target/, and confirms the
// no-hashes handshake, diagnostics and real class-property completions.
execFileSync(process.execPath, [join(scripts, 'smoke-test.mjs'), binary], {
    stdio: 'inherit', windowsHide: true,
});
const flintVersion = JSON.parse(readFileSync(join(root, 'src-tauri/tauri.conf.json'), 'utf8')).version;
const sha256 = createHash('sha256').update(readFileSync(binary)).digest('hex');
const version = `dev-${sha256.slice(0, 16)}`;
const asset = `ritobin-lsp-${version}-windows-x86_64.exe`;
const output = join(root, 'src-tauri/binaries/ritobin-lsp');
mkdirSync(output, { recursive: true });
const stagedBinary = join(output, asset);
try {
    // Re-staging the same build is harmless even while Windows is running it.
    if (createHash('sha256').update(readFileSync(stagedBinary)).digest('hex') !== sha256) {
        throw new Error('Replace corrupt staged binary');
    }
} catch {
    copyFileSync(binary, stagedBinary);
}
const staging = join(output, 'manifest.json.tmp');
writeFileSync(staging, JSON.stringify({ version, flintVersion, asset, sha256, noHashes: 1 }, null, 2));
renameSync(staging, join(output, 'manifest.json'));
console.log(`Staged verified development LSP for Flint ${flintVersion}: ${stagedBinary}`);
console.log('Restart the Flint Rust backend, then enable LSP or press Retry LSP. No release upload is needed.');
