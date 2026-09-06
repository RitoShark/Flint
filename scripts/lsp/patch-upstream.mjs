// Build-only adapter. Fail closed if upstream's hash architecture changes.
import { readFileSync, writeFileSync, readdirSync } from 'node:fs';
import { join } from 'node:path';

const root = join(process.argv[2], 'crates/ritobin-lsp/src');
function replaceOnce(text, old, replacement) {
    if (text.split(old).length !== 2) throw new Error(`Upstream changed; refusing to build: ${old.slice(0, 80)}`);
    return text.replace(old, replacement);
}
function splice(text, from, to, replacement) {
    if (text.split(from).length !== 2 || text.split(to).length !== 2) throw new Error('Upstream hash architecture changed');
    const start = text.indexOf(from), end = text.indexOf(to, start);
    if (end < start) throw new Error('Upstream hash architecture changed');
    return text.slice(0, start) + replacement + text.slice(end);
}
function edit(path, transform) {
    const file = join(root, path);
    writeFileSync(file, transform(readFileSync(file, 'utf8').replaceAll('\r\n', '\n')));
}

edit('main_loop.rs', text => splice(text,
    '    let hashes = Hashes::new()',
    '    tokio::spawn({\n        let server = server.clone();\n        let meta_override',
    `    // Flint owns all hash resolution. Never discover, load or update hash tables.
    let server = Arc::new(Server::new(connection, config.clone(), None));
    server.update_status(|status| {
        status.hashes = TaskStatus::Ready; // Hash support intentionally disabled.
        status.meta = TaskStatus::Loading("Loading meta dump".into());
    });

`).replace('use ltk_mimir_cache::UpdateOutcome;\n', '').replace('server::{Hashes, Server}', 'server::Server'));

// Remove all hash I/O code. Passing an empty hashPath does not disable it upstream.
edit('server.rs', text => splice(text, 'impl Hashes {', '\npub struct Server {',
    `impl Hashes {
    pub fn table(&self, _table: Table) -> Option<Arc<HashDb>> { None }
    pub fn bin_provider(&self) -> BinHashProvider { BinHashProvider::default() }
    pub fn snapshot(&self) -> HashesSnapshot { HashesSnapshot(Arc::new(HashMap::new())) }
}
`).replace('use ltk_mimir_cache::{HashStore, Table, UpdateOptions, UpdateOutcome};', 'use ltk_mimir_cache::{HashStore, Table};'));

edit('lsp/capabilities.rs', text => replaceOnce(text, '    ServerCapabilities {',
    '    ServerCapabilities {\n        experimental: Some(serde_json::json!({ "flintNoHashes": 1 })),')
);

// Upstream omits diagnostic versions. Include them so results for an older edit
// cannot overwrite Monaco markers after the next didChange has been sent.
edit('server.rs', text => replaceOnce(replaceOnce(text,
    '        diagnostics: Vec<Diagnostic>,\n',
    '        diagnostics: Vec<Diagnostic>,\n        version: Option<i32>,\n'),
    '            version: None,', '            version,'));
edit('worker/diagnostics.rs', text => replaceOnce(text,
    '.publish_diagnostics(self.document.uri.clone(), diagnostics)',
    '.publish_diagnostics(self.document.uri.clone(), diagnostics, Some(self.document.version))'));
edit('handlers/notification.rs', text => replaceOnce(text,
    'server.publish_diagnostics(uri, Vec::new())',
    'server.publish_diagnostics(uri, Vec::new(), None)'));

for (const path of readdirSync(root, { recursive: true })) {
    if (!path.endsWith('.rs')) continue;
    const source = readFileSync(join(root, path), 'utf8');
    for (const forbidden of ['Hashes::new(', 'HashStore::discover(', 'hashes.update(', 'hashes.load(', 'mimir/releases/']) {
        if (source.includes(forbidden)) throw new Error(`Hash access remains in ${path}: ${forbidden}`);
    }
}
console.log('Flint no-hashes adapter applied and verified');
