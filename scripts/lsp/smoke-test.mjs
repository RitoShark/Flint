// Exercise the real server with metadata fetching explicitly disabled.
import { spawn } from 'node:child_process';
import { resolve, dirname, join } from 'node:path';
import { pathToFileURL } from 'node:url';
import assert from 'node:assert/strict';
import { existsSync } from 'node:fs';

const binary = resolve(process.argv[2]);
const metadata = resolve(dirname(binary), '../../dump.json');
assert.ok(existsSync(metadata), 'Upstream metadata fixture is required');
const child = spawn(binary, [], { stdio: ['pipe', 'pipe', 'pipe'], windowsHide: true });
const messages = [];
let buffer = Buffer.alloc(0);
let exited = false;
child.on('exit', () => { exited = true; });
child.on('error', error => { console.error(error); process.exitCode = 1; });
child.stderr.resume();
child.stdout.on('data', chunk => {
    buffer = Buffer.concat([buffer, chunk]);
    while (true) {
        const end = buffer.indexOf('\r\n\r\n');
        if (end < 0) break;
        const size = Number(/Content-Length:\s*(\d+)/i.exec(buffer.subarray(0, end).toString())[1]);
        if (buffer.length < end + 4 + size) break;
        messages.push(JSON.parse(buffer.subarray(end + 4, end + 4 + size).toString()));
        buffer = buffer.subarray(end + 4 + size);
    }
});
function send(method, params, id) {
    const body = Buffer.from(JSON.stringify({ jsonrpc: '2.0', method, params, id }));
    child.stdin.write(`Content-Length: ${body.length}\r\n\r\n`);
    child.stdin.write(body);
}
async function receive(predicate) {
    const deadline = Date.now() + 30000;
    while (Date.now() < deadline) {
        const index = messages.findIndex(predicate);
        if (index >= 0) {
            const message = messages.splice(index, 1)[0];
            assert.equal(message.error, undefined, JSON.stringify(message));
            return message;
        }
        if (exited) throw new Error('LSP exited unexpectedly');
        await new Promise(resolve => setTimeout(resolve, 20));
    }
    throw new Error('Timed out waiting for LSP response');
}
try {
    send('initialize', {
        processId: null, rootUri: pathToFileURL(dirname(binary)).href, capabilities: {},
        initializationOptions: { hashPath: '', metaDumpPath: metadata },
    }, 1);
    const { result } = await receive(m => m.id === 1);
    assert.equal(result.capabilities.experimental.flintNoHashes, 1);
    assert.ok(result.capabilities.completionProvider);
    send('initialized', {});
    const loaded = await receive(m => m.method === 'experimental/serverStatus' && m.params.quiescent);
    assert.equal(loaded.params.health, 'ok', JSON.stringify(loaded));
    const uri = pathToFileURL(join(dirname(binary), 'flint-smoke.ritobin')).href;
    send('textDocument/didOpen', { textDocument: { uri, languageId: 'ritobin', version: 1, text: 'invalid {' } });
    const diagnostics = await receive(m => m.method === 'textDocument/publishDiagnostics');
    assert.ok(diagnostics.params.diagnostics.length);
    assert.equal(diagnostics.params.version, 1);
    send('textDocument/completion', { textDocument: { uri }, position: { line: 0, character: 0 } }, 2);
    await receive(m => m.id === 2);
    send('textDocument/didChange', {
        textDocument: { uri, version: 2 },
        contentChanges: [{ text: 'entries: map[hash,embed] = {\n    "test" = SkinCharacterDataProperties {\n        \n    }\n}\n' }],
    });
    send('textDocument/completion', { textDocument: { uri }, position: { line: 2, character: 8 } }, 4);
    const completed = (await receive(m => m.id === 4)).result;
    assert.ok((Array.isArray(completed) ? completed : completed?.items)?.length, 'Class metadata must provide property completions');
    send('textDocument/didClose', { textDocument: { uri } });
    send('shutdown', undefined, 3);
    await receive(m => m.id === 3);
    send('exit');
    const code = await Promise.race([
        new Promise(resolve => child.once('exit', resolve)),
        new Promise((_, reject) => { const timer = setTimeout(() => reject(new Error('Shutdown timed out')), 10000); timer.unref(); }),
    ]);
    assert.equal(code, 0);
    console.log('PASS: hash-isolated handshake, versioned diagnostics, class property completion, close and shutdown');
} finally {
    if (!exited) child.kill();
}
