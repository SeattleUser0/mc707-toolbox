// The desktop app's MCP server (docs/MCP-SPEC.md sections 2, 3 and 6). Runs in Electron's main process:
// it speaks MCP over HTTP on 127.0.0.1 only, checks the caller (a token, and no web page as Origin), and
// hands every tools/list and tools/call to the page (src/ui/mcp-tools.js) over IPC, where the app's own code
// does the work. It also finds the MC-707's SD card and writes the project files the page makes.
//
// main.js calls start(getWin, folderFor) once the app is ready. Nothing here runs before that.
//
// The SD card rules are the ones of the mc707-svz launchers (hardware/card.mjs there, MIT, same author):
// a ROLAND folder at the top, not the app's or the Projects folder's drive, and removable media or an SD
// slot by macOS's diskutil; exactly one such drive, or one named in mcp.json.
//
// Revision history
//   0.1.0  2026-11-20  First version (fork, MCP server work).
'use strict';
const http = require('http');
const path = require('path');
const fs = require('fs');
const crypto = require('crypto');
const { execFileSync } = require('child_process');
/* Electron only when the server starts, so the protocol and card code can be tested in plain Node */
const electron = () => require('electron');

const VERSIONS = ['2025-06-18', '2025-03-26', '2024-11-05'];
const MAX_BODY = 4 * 1024 * 1024,
  CALL_MS = 120000,
  DEF_PORT = 8717;

/* ---- settings: mcp.json in the app's data folder, made on first start ---- */
const settingsPath = () => path.join(electron().app.getPath('userData'), 'mcp.json');
function settings() {
  let s = {};
  try {
    s = JSON.parse(fs.readFileSync(settingsPath(), 'utf8')) || {};
  } catch (e) {}
  let changed = false;
  if (typeof s.enabled !== 'boolean') ((s.enabled = true), (changed = true));
  if (!Number.isInteger(s.port) || s.port < 1024 || s.port > 65535) ((s.port = DEF_PORT), (changed = true));
  if (typeof s.token !== 'string' || s.token.length < 32) ((s.token = crypto.randomBytes(32).toString('hex')), (changed = true));
  if (changed)
    try {
      fs.mkdirSync(path.dirname(settingsPath()), { recursive: true });
      fs.writeFileSync(settingsPath(), JSON.stringify(s, null, 2), { mode: 0o600 });
    } catch (e) {}
  return s;
}

/* where mcp.json is, for messages (plain Node in the tests has no Electron) */
function settingsName() {
  try {
    return settingsPath();
  } catch (e) {
    return 'mcp.json (in the Toolbox data folder)';
  }
}

/* ---- the page: calls go over IPC and come back by id ---- */
let getWin = () => null,
  readyIn = null /* the webContents id of the page that said it is ready (a new window must say so again) */,
  nextId = 1;
const waiting = new Map(),
  readyWaiters = [];
const isReady = () => {
  const w = getWin();
  return !!(w && !w.isDestroyed() && w.webContents.id === readyIn);
};
function whenReady(ms) {
  if (isReady()) return Promise.resolve();
  return new Promise((res, rej) => {
    const t = setTimeout(() => rej(new Error('the Toolbox window is not ready')), ms);
    readyWaiters.push(() => (clearTimeout(t), res()));
  });
}
async function askPage(method, params) {
  await whenReady(CALL_MS);
  const win = getWin();
  if (!win || win.isDestroyed()) throw new Error('the Toolbox window is closed');
  const id = nextId++;
  return new Promise((res, rej) => {
    const t = setTimeout(() => (waiting.delete(id), rej(new Error('the Toolbox did not answer in time'))), CALL_MS);
    waiting.set(id, r => (clearTimeout(t), r.error ? rej(new Error(r.error)) : res(r.result)));
    win.webContents.send('mcp-call', id, method, params);
  });
}

/* ---- MCP: one JSON-RPC message in, its answer out (null for a notification) ---- */
const rpcErr = (id, code, message) => ({ jsonrpc: '2.0', id, error: { code, message } });
/** The JSON-RPC handler, given how to ask the page and the app's version (tests give their own). */
function makeHandle(ask, version) {
  return async function handle(msg) {
    if (!msg || msg.jsonrpc !== '2.0' || typeof msg.method !== 'string')
      return rpcErr(msg && msg.id != null ? msg.id : null, -32600, 'Invalid Request');
    const id = msg.id;
    if (id === undefined) return null; /* notifications (initialized, cancelled ...): nothing to answer */
    try {
      if (msg.method === 'initialize') {
        const want = msg.params && msg.params.protocolVersion;
        return {
          jsonrpc: '2.0',
          id,
          result: {
            protocolVersion: VERSIONS.includes(want) ? want : VERSIONS[0],
            capabilities: { tools: { listChanged: false } },
            serverInfo: { name: 'mc707-toolbox', title: 'MC-707 Toolbox', version },
            instructions:
              'Drives the MC-707 Toolbox app: write a song for the Roland MC-707 (song_format, list_sounds, load_song or compose_song), play it through the MC-707 (play, stop), and save it as an MC-707 project on the SD card (save_project).'
          }
        };
      }
      if (msg.method === 'ping') return { jsonrpc: '2.0', id, result: {} };
      if (msg.method === 'tools/list' || msg.method === 'tools/call')
        return { jsonrpc: '2.0', id, result: await ask(msg.method, msg.params || {}) };
      return rpcErr(id, -32601, 'Method not found: ' + msg.method);
    } catch (e) {
      return rpcErr(id, -32603, String((e && e.message) || e));
    }
  };
}

/* ---- HTTP: POST /mcp only, from this computer, with the token, from no web page ---- */
function originOk(req, port) {
  const o = req.headers.origin;
  if (!o || o === 'null') return true;
  return o === 'http://127.0.0.1:' + port || o === 'http://localhost:' + port;
}
function tokenOk(req, token) {
  const h = String(req.headers.authorization || '');
  const got = Buffer.from(h.replace(/^Bearer\s+/i, '')),
    want = Buffer.from(token);
  return got.length === want.length && crypto.timingSafeEqual(got, want);
}
function send(res, code, body) {
  const text = body == null ? '' : JSON.stringify(body);
  res.writeHead(code, { 'Content-Type': 'application/json', 'Cache-Control': 'no-store' });
  res.end(text);
}
/** The HTTP server for settings s ({port, token}) and a JSON-RPC handler; listens on 127.0.0.1 only. */
function serve(s, handle) {
  const server = http.createServer((req, res) => {
    const url = (req.url || '').split('?')[0];
    if (url !== '/mcp') return send(res, 404, { error: 'not found' });
    if (!originOk(req, s.port)) return send(res, 403, { error: 'forbidden origin' });
    if (!tokenOk(req, s.token)) return send(res, 401, { error: 'unauthorized' });
    if (req.method !== 'POST') {
      res.setHeader('Allow', 'POST');
      return send(res, 405, { error: 'POST only' });
    }
    const parts = [];
    let size = 0;
    req.on('data', c => {
      size += c.length;
      if (size > MAX_BODY) (send(res, 413, { error: 'too large' }), req.destroy());
      else parts.push(c);
    });
    req.on('end', async () => {
      if (size > MAX_BODY) return;
      let msg;
      try {
        msg = JSON.parse(Buffer.concat(parts).toString('utf8'));
      } catch (e) {
        return send(res, 400, rpcErr(null, -32700, 'Parse error'));
      }
      const out = Array.isArray(msg) ? (await Promise.all(msg.map(handle))).filter(Boolean) : await handle(msg);
      if (out == null || (Array.isArray(out) && !out.length)) return send(res, 202, null);
      send(res, 200, out);
    });
  });
  server.on('error', e => console.error('MCP server: ' + e.message));
  server.listen(s.port, '127.0.0.1');
  return server;
}

/* ---- the SD card ---- */
function diskutilInfo(vol) {
  if (process.platform !== 'darwin') return null;
  try {
    const xml = execFileSync('/usr/sbin/diskutil', ['info', '-plist', vol], { encoding: 'utf8', timeout: 10000 });
    return JSON.parse(execFileSync('/usr/bin/plutil', ['-convert', 'json', '-o', '-', '-'], { input: xml, encoding: 'utf8', timeout: 10000 }));
  } catch (e) {
    return null;
  }
}
const devOf = p => {
  try {
    return fs.statSync(p).dev;
  } catch (e) {
    return null;
  }
};
const isDir = p => {
  try {
    return fs.statSync(p).isDirectory();
  } catch (e) {
    return false;
  }
};
function removable(info) {
  if (!info) return { ok: false, why: 'macOS could not say what kind of drive this is' };
  if (info.BusProtocol === 'Secure Digital') return { ok: true, why: 'in an SD card slot' };
  if (info.RemovableMedia === true) return { ok: true, why: 'removable media (' + (info.BusProtocol || 'unknown bus') + ')' };
  return { ok: false, why: 'not removable media (' + [info.BusProtocol, info.Internal ? 'internal' : 'external'].filter(Boolean).join(', ') + ')' };
}
/**
 * Which drive is the MC-707's card. o: {named (mcp.json "card"), avoid: paths whose drives are never the card,
 * roots, probe} (roots and probe replaceable for tests). Returns {card, status, lines, seen}.
 */
function chooseCard(o) {
  const avoid = new Set((o.avoid || []).map(devOf).filter(d => d != null));
  const roots = o.roots || (process.platform === 'darwin' ? ['/Volumes'] : []),
    probe = o.probe || diskutilInfo;
  const seen = [],
    lines = [];
  for (const root of roots) {
    let names = [];
    try {
      names = fs.readdirSync(root);
    } catch (e) {
      continue;
    }
    for (const n of names.sort()) {
      if (n.startsWith('.')) continue;
      const vol = path.join(root, n);
      if (avoid.has(devOf(vol))) {
        seen.push({ path: vol, ok: false, why: 'the drive the Toolbox or its Projects folder is on' });
        continue;
      }
      if (!isDir(path.join(vol, 'ROLAND'))) continue;
      const r = removable(probe(vol));
      seen.push({ path: vol, ok: r.ok, why: r.why });
    }
  }
  if (o.named) {
    const vol = path.resolve(o.named);
    const bad = !fs.existsSync(vol) ? 'it is not mounted' : avoid.has(devOf(vol)) ? 'it is the drive the Toolbox or its Projects folder is on' : !isDir(path.join(vol, 'ROLAND')) ? 'it has no ROLAND folder' : null;
    if (bad) return { card: null, status: 'named-bad', lines: ['mcp.json names ' + vol + ' as the card, but ' + bad + '.'], seen };
    return { card: vol, status: 'named', lines: ['MC-707 card (named in mcp.json): ' + vol], seen };
  }
  const ok = seen.filter(x => x.ok);
  for (const x of seen.filter(x => !x.ok)) lines.push('Not the card: ' + x.path + ' (' + x.why + ').');
  if (ok.length === 1) return { card: ok[0].path, status: 'found', lines: [...lines, 'MC-707 card: ' + ok[0].path + ' (' + ok[0].why + ').'], seen };
  if (ok.length > 1)
    return {
      card: null,
      status: 'several',
      lines: [...lines, 'More than one drive could be the MC-707 card: ' + ok.map(x => x.path).join(', ') + '. Name one in ' + settingsName() + ', for example "card": "' + ok[0].path + '".'],
      seen
    };
  return {
    card: null,
    status: 'none',
    lines: [...lines, 'No MC-707 SD card found. Put the card in this computer, or on the MC-707 hold SHIFT, press KNOB ASSIGN, pick STORAGE MODE and connect USB.'],
    seen
  };
}

/* ---- writing the project ---- */
const fileName = n => (String(n || '').replace(/[^A-Za-z0-9 _-]/g, '-').trim().slice(0, 16) || 'Toolbox song');
function writeWhole(p, data) {
  const tmp = p + '.tmp';
  fs.writeFileSync(tmp, data);
  fs.renameSync(tmp, p);
}
/**
 * Save {name, bytes, to: 'card'|'folder', overwrite, songText}: the .mpj on the card (ROLAND/GROOVEBOX/PROJECT)
 * or in the Projects folder, and the Toolbox song file (.json) in the Projects folder. {to, mpj, song} or {error}.
 */
function saveProject(a, projectsDir, cardOpts) {
  const name = fileName(a.name),
    bytes = Buffer.from(a.bytes || []);
  if (bytes.length < 1024) return { error: 'no project data' };
  let dir;
  if (a.to === 'folder') dir = projectsDir;
  else {
    const c = chooseCard(cardOpts);
    if (!c.card) return { error: c.lines.join(' '), card: c };
    dir = path.join(c.card, 'ROLAND', 'GROOVEBOX', 'PROJECT');
  }
  fs.mkdirSync(dir, { recursive: true });
  const mpj = path.join(dir, name + '.mpj');
  if (fs.existsSync(mpj) && !a.overwrite) return { error: mpj + ' is already there: give another name, or overwrite true to replace it' };
  writeWhole(mpj, bytes);
  let song = null,
    songKept = null;
  if (typeof a.songText === 'string') {
    const p = path.join(projectsDir, name + '.json');
    if (!fs.existsSync(p) || a.overwrite) (writeWhole(p, a.songText), (song = p));
    else songKept = p;
  }
  return { to: a.to === 'folder' ? 'folder' : 'card', mpj, song, songKept };
}

/** Start the server (main.js, once the app is ready). getWin: the main window; folderFor: main.js's. */
function start(win, folderFor) {
  const { app, ipcMain } = electron();
  getWin = win;
  const s = settings();
  const cardOpts = () => ({ named: settings().card || null, avoid: [app.getAppPath(), folderFor('projects')] });
  ipcMain.on('mcp-ready', e => {
    readyIn = e.sender.id;
    readyWaiters.splice(0).forEach(f => f());
  });
  ipcMain.on('mcp-reply', (_e, id, r) => {
    const f = waiting.get(id);
    if (f) (waiting.delete(id), f(r || {}));
  });
  ipcMain.handle('mcp-card', () => {
    const c = chooseCard(cardOpts());
    return { found: c.card, status: c.status, lines: c.lines };
  });
  ipcMain.handle('mcp-save', (_e, a) => {
    try {
      return saveProject(a || {}, folderFor('projects'), cardOpts());
    } catch (e) {
      return { error: String((e && e.message) || e) };
    }
  });
  if (!s.enabled) return null;
  return serve(s, makeHandle(askPage, app.getVersion()));
}

module.exports = { start, serve, makeHandle, chooseCard, removable, saveProject, fileName, settingsPath };
