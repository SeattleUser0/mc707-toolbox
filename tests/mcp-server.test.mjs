// The desktop app's MCP server (main-mcp.cjs) and the stdio bridge (mcp/toolbox-mcp-bridge.cjs) in plain
// Node, with a stand-in for the app's page: the protocol, the checks on the caller, the SD card rules and the
// project writes. The tools themselves run in the page and are tested there (tests/mcp-tools.test.mjs).
//
// Revision history
//   0.1.0  2026-11-20  First version (fork, MCP server work).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { spawn } from 'node:child_process';
import { createRequire } from 'node:module';
import { fileURLToPath } from 'node:url';

const require = createRequire(import.meta.url);
const ROOT = path.join(path.dirname(fileURLToPath(import.meta.url)), '..');
const M = require(path.join(ROOT, 'main-mcp.cjs'));

const TOKEN = 'a'.repeat(64);
const PORT = 20000 + Math.floor(Math.random() * 20000);
/* the page's side: tools/list and an echo tool */
const ask = async (method, params) => {
  if (method === 'tools/list') return { tools: [{ name: 'echo', inputSchema: { type: 'object' } }] };
  if (params.name === 'boom') throw new Error('the page failed');
  return { content: [{ type: 'text', text: JSON.stringify(params.arguments) }] };
};
let server;
test.before(
  () =>
    new Promise(r => (server = M.serve({ port: PORT, token: TOKEN }, M.makeHandle(ask, '9.9.9'))).on('listening', r))
);
test.after(() => server.close());

const call = (body, headers = {}, method = 'POST') =>
  fetch('http://127.0.0.1:' + PORT + (headers.path || '/mcp'), {
    method,
    headers: { 'Content-Type': 'application/json', Authorization: 'Bearer ' + TOKEN, ...headers },
    body: method === 'POST' ? (typeof body === 'string' ? body : JSON.stringify(body)) : undefined
  });

test('initialize answers with the client version when it knows it', async () => {
  const r = await (
    await call({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-03-26' } })
  ).json();
  assert.equal(r.result.protocolVersion, '2025-03-26');
  assert.equal(r.result.serverInfo.name, 'mc707-toolbox');
  assert.equal(r.result.serverInfo.version, '9.9.9');
  assert.ok(r.result.capabilities.tools);
  const r2 = await (
    await call({ jsonrpc: '2.0', id: 2, method: 'initialize', params: { protocolVersion: '1999-01-01' } })
  ).json();
  assert.equal(r2.result.protocolVersion, '2025-06-18');
});

test('tools pass through to the page; errors come back as JSON-RPC errors', async () => {
  const l = await (await call({ jsonrpc: '2.0', id: 3, method: 'tools/list' })).json();
  assert.equal(l.result.tools[0].name, 'echo');
  const c = await (
    await call({ jsonrpc: '2.0', id: 4, method: 'tools/call', params: { name: 'echo', arguments: { a: 1 } } })
  ).json();
  assert.equal(c.result.content[0].text, '{"a":1}');
  const b = await (await call({ jsonrpc: '2.0', id: 5, method: 'tools/call', params: { name: 'boom' } })).json();
  assert.equal(b.error.code, -32603);
  assert.equal(b.error.message, 'the page failed');
  const u = await (await call({ jsonrpc: '2.0', id: 6, method: 'resources/list' })).json();
  assert.equal(u.error.code, -32601);
  const p = await (await call({ jsonrpc: '2.0', id: 7, method: 'ping' })).json();
  assert.deepEqual(p.result, {});
});

test('notifications get 202, batches get a list, bad JSON 400', async () => {
  assert.equal((await call({ jsonrpc: '2.0', method: 'notifications/initialized' })).status, 202);
  const b = await (
    await call([
      { jsonrpc: '2.0', id: 8, method: 'ping' },
      { jsonrpc: '2.0', method: 'notifications/initialized' }
    ])
  ).json();
  assert.equal(b.length, 1);
  assert.equal(b[0].id, 8);
  const bad = await call('{not json');
  assert.equal(bad.status, 400);
  assert.equal((await bad.json()).error.code, -32700);
  const inv = await (await call({ id: 9, method: 'ping' })).json();
  assert.equal(inv.error.code, -32600);
});

test('the caller is checked: token, origin, method, path, size', async () => {
  const ping = { jsonrpc: '2.0', id: 1, method: 'ping' };
  assert.equal((await call(ping, { Authorization: 'Bearer wrong' })).status, 401);
  assert.equal((await call(ping, { Authorization: '' })).status, 401);
  assert.equal((await call(ping, { Origin: 'https://evil.example' })).status, 403);
  assert.equal((await call(ping, { Origin: 'http://localhost:' + PORT })).status, 200);
  assert.equal((await call(null, {}, 'GET')).status, 405);
  assert.equal((await call(ping, { path: '/other' })).status, 404);
  const big = await call(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'ping', pad: 'x'.repeat(5 * 1024 * 1024) })
  ).catch(e => ({ status: 413, e }));
  assert.equal(big.status, 413);
});

test('the stdio bridge carries lines both ways', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true, port: PORT, token: TOKEN }));
  const p = spawn(process.execPath, [path.join(ROOT, 'mcp', 'toolbox-mcp-bridge.cjs')], {
    env: { ...process.env, MC707_MCP_SETTINGS: file }
  });
  let text = '';
  p.stdout.on('data', d => (text += d));
  const done = new Promise(r => p.on('exit', r));
  p.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', id: 1, method: 'initialize', params: { protocolVersion: '2025-06-18' } }) + '\n'
  );
  p.stdin.write(JSON.stringify({ jsonrpc: '2.0', method: 'notifications/initialized' }) + '\n');
  p.stdin.write(
    JSON.stringify({ jsonrpc: '2.0', id: 2, method: 'tools/call', params: { name: 'echo', arguments: { b: 2 } } }) +
      '\n'
  );
  p.stdin.end();
  await done;
  const lines = text
    .trim()
    .split('\n')
    .map(l => JSON.parse(l));
  assert.equal(lines.length, 2);
  const byId = Object.fromEntries(lines.map(l => [l.id, l]));
  assert.equal(byId[1].result.serverInfo.name, 'mc707-toolbox');
  assert.equal(byId[2].result.content[0].text, '{"b":2}');
});

test('the bridge says what is wrong when the token is refused', async () => {
  const dir = fs.mkdtempSync(path.join(os.tmpdir(), 'mcp-bridge-'));
  const file = path.join(dir, 'mcp.json');
  fs.writeFileSync(file, JSON.stringify({ enabled: true, port: PORT, token: 'b'.repeat(64) }));
  const p = spawn(process.execPath, [path.join(ROOT, 'mcp', 'toolbox-mcp-bridge.cjs')], {
    env: { ...process.env, MC707_MCP_SETTINGS: file }
  });
  let text = '';
  p.stdout.on('data', d => (text += d));
  const done = new Promise(r => p.on('exit', r));
  p.stdin.end(JSON.stringify({ jsonrpc: '2.0', id: 7, method: 'ping' }) + '\n');
  await done;
  const l = JSON.parse(text.trim());
  assert.equal(l.id, 7);
  assert.match(l.error.message, /token .* was refused/);
});

/* ---- the SD card ---- */
function volumes(spec) {
  const root = fs.mkdtempSync(path.join(os.tmpdir(), 'vols-'));
  for (const [name, roland] of Object.entries(spec)) {
    fs.mkdirSync(path.join(root, name));
    if (roland) fs.mkdirSync(path.join(root, name, 'ROLAND'));
  }
  return root;
}
test('the card: exactly one removable drive with a ROLAND folder', () => {
  const root = volumes({ 'MC-707': true, 'Samsung 990': true, Other: false });
  const probe = v =>
    v.endsWith('MC-707') ? { RemovableMedia: true, BusProtocol: 'USB' } : { RemovableMedia: false, BusProtocol: 'USB' };
  const c = M.chooseCard({ roots: [root], probe });
  assert.equal(c.status, 'found');
  assert.equal(c.card, path.join(root, 'MC-707'));
  assert.ok(c.lines.some(l => l.includes('Samsung 990') && l.includes('not removable')));
});
test('the card: an SD slot counts; two candidates or none write nowhere', () => {
  const root = volumes({ A: true, B: true });
  const both = M.chooseCard({ roots: [root], probe: () => ({ BusProtocol: 'Secure Digital' }) });
  assert.equal(both.status, 'several');
  assert.equal(both.card, null);
  const none = M.chooseCard({ roots: [root], probe: () => ({ RemovableMedia: false }) });
  assert.equal(none.status, 'none');
  assert.equal(none.card, null);
  const named = M.chooseCard({
    roots: [root],
    probe: () => ({ BusProtocol: 'Secure Digital' }),
    named: path.join(root, 'B')
  });
  assert.equal(named.status, 'named');
  assert.equal(named.card, path.join(root, 'B'));
  const badName = M.chooseCard({ roots: [root], named: path.join(root, 'nope') });
  assert.equal(badName.status, 'named-bad');
});
test('the card: never the drive the app or its Projects folder is on', () => {
  const root = volumes({ Card: true });
  /* the avoided path is on the same drive as every temporary folder here */
  const c = M.chooseCard({ roots: [root], probe: () => ({ RemovableMedia: true }), avoid: [os.tmpdir()] });
  assert.equal(c.status, 'none');
  assert.ok(c.seen.some(s => s.why.includes('Projects folder')));
});

/* ---- writing ---- */
test('saving: the .mpj and the song file, never over an existing file unless asked', () => {
  const root = volumes({ Card: true });
  const projects = fs.mkdtempSync(path.join(os.tmpdir(), 'projects-'));
  const bytes = new Uint8Array(4096).fill(7);
  const opts = { roots: [root], probe: () => ({ RemovableMedia: true }) };
  const r = M.saveProject({ name: 'Night/Bus', bytes, to: 'card', songText: '{"v":1}' }, projects, opts);
  assert.equal(r.to, 'card');
  assert.equal(r.mpj, path.join(root, 'Card', 'ROLAND', 'GROOVEBOX', 'PROJECT', 'Night-Bus.mpj'));
  assert.equal(fs.readFileSync(r.mpj).length, 4096);
  assert.equal(fs.readFileSync(r.song, 'utf8'), '{"v":1}');
  const again = M.saveProject({ name: 'Night/Bus', bytes, to: 'card' }, projects, opts);
  assert.match(again.error, /already there/);
  const over = M.saveProject(
    { name: 'Night/Bus', bytes: new Uint8Array(2048), to: 'card', overwrite: true },
    projects,
    opts
  );
  assert.equal(fs.readFileSync(over.mpj).length, 2048);
  const kept = M.saveProject({ name: 'Night/Bus', bytes, to: 'folder', songText: '{"v":2}' }, projects, opts);
  assert.equal(kept.song, null);
  assert.equal(kept.songKept, path.join(projects, 'Night-Bus.json'));
  assert.equal(fs.readFileSync(kept.songKept, 'utf8'), '{"v":1}');
  const folder = M.saveProject({ name: 'Other', bytes, to: 'folder' }, projects, opts);
  assert.equal(folder.mpj, path.join(projects, 'Other.mpj'));
  const noCard = M.saveProject({ name: 'X', bytes, to: 'card' }, projects, { roots: [], probe: () => null });
  assert.match(noCard.error, /No MC-707 SD card found/);
  assert.equal(
    M.saveProject({ name: 'X', bytes: new Uint8Array(10), to: 'folder' }, projects, opts).error,
    'no project data'
  );
});
