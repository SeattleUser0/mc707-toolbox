#!/usr/bin/env node
// The MC-707 Toolbox MCP server over stdio, for Claude Desktop (docs/MCP-SPEC.md section 3, setup in
// docs/MCP-SETUP.md). Claude Desktop starts this; it passes each JSON-RPC line from stdin to the Toolbox
// app's server (http://127.0.0.1:<port>/mcp, with the token from mcp.json) and writes the answer to stdout.
// The tools themselves run in the app. If the app is not open, on macOS this opens it and waits.
//
// Plain Node, no packages. Runs with any Node 18 or later, or with the app's own binary:
//   ELECTRON_RUN_AS_NODE=1 "/Applications/MC707-101 Toolbox.app/Contents/MacOS/MC707-101 Toolbox" <this file>
// Logs go to stderr (Claude Desktop keeps them in its MCP log); stdout carries only JSON-RPC.
//
// Revision history
//   0.1.0  2026-11-20  First version (fork, MCP server work).
'use strict';
const fs = require('fs');
const os = require('os');
const path = require('path');
const http = require('http');
const { execFile } = require('child_process');

const APP_ID = 'local.mc707.toolbox',
  WAIT_MS = 30000;

/* mcp.json in the app's data folder (main.js sets it to "MC-707 Toolbox"); MC707_MCP_SETTINGS overrides */
function settingsFile() {
  if (process.env.MC707_MCP_SETTINGS) return process.env.MC707_MCP_SETTINGS;
  const home = os.homedir();
  const base =
    process.platform === 'darwin'
      ? path.join(home, 'Library', 'Application Support')
      : process.platform === 'win32'
        ? process.env.APPDATA || path.join(home, 'AppData', 'Roaming')
        : process.env.XDG_CONFIG_HOME || path.join(home, '.config');
  return path.join(base, 'MC-707 Toolbox', 'mcp.json');
}
function readSettings() {
  try {
    return JSON.parse(fs.readFileSync(settingsFile(), 'utf8'));
  } catch (e) {
    return null;
  }
}
const log = m => process.stderr.write('[mc707-toolbox bridge] ' + m + '\n');

/* one POST to the server: resolves {status, body} or rejects when nothing listens */
function post(s, text) {
  return new Promise((res, rej) => {
    const req = http.request(
      {
        host: '127.0.0.1',
        port: s.port,
        path: '/mcp',
        method: 'POST',
        headers: {
          'Content-Type': 'application/json',
          Accept: 'application/json, text/event-stream',
          Authorization: 'Bearer ' + s.token,
          'Content-Length': Buffer.byteLength(text)
        },
        timeout: 130000
      },
      r => {
        const parts = [];
        r.on('data', c => parts.push(c));
        r.on('end', () => res({ status: r.statusCode, body: Buffer.concat(parts).toString('utf8') }));
      }
    );
    req.on('timeout', () => req.destroy(new Error('the Toolbox did not answer in time')));
    req.on('error', rej);
    req.end(text);
  });
}
const sleep = ms => new Promise(r => setTimeout(r, ms));
let opened = false;
/* post, opening the app (macOS) and retrying while it starts */
async function postWithApp(text) {
  const until = Date.now() + WAIT_MS;
  for (;;) {
    const s = readSettings();
    if (s && s.token && s.port) {
      try {
        return await post(s, text);
      } catch (e) {
        if (e.code !== 'ECONNREFUSED' && e.code !== 'ECONNRESET') throw e;
      }
    }
    if (!opened && process.platform === 'darwin') {
      opened = true;
      log('the Toolbox is not running: opening it');
      execFile('/usr/bin/open', ['-b', APP_ID], err => err && log('could not open the app: ' + err.message));
    }
    if (Date.now() > until)
      throw new Error(
        s ? 'the MC-707 Toolbox app is not running (open it, then try again)' : 'no ' + settingsFile() + ': open the MC-707 Toolbox app once so it makes one'
      );
    await sleep(700);
  }
}

const out = o => process.stdout.write(JSON.stringify(o) + '\n');
async function onLine(line) {
  if (!line.trim()) return;
  let msg;
  try {
    msg = JSON.parse(line);
  } catch (e) {
    return out({ jsonrpc: '2.0', id: null, error: { code: -32700, message: 'Parse error' } });
  }
  const ids = (Array.isArray(msg) ? msg : [msg]).filter(m => m && m.id !== undefined).map(m => m.id);
  try {
    const r = await postWithApp(line);
    if (r.status === 202 || !r.body) return;
    if (r.status === 401) throw new Error('the token in ' + settingsFile() + ' was refused (restart the Toolbox app)');
    if (r.status !== 200) throw new Error('the Toolbox answered HTTP ' + r.status);
    process.stdout.write(r.body.trim() + '\n');
  } catch (e) {
    for (const id of ids) out({ jsonrpc: '2.0', id, error: { code: -32603, message: e.message } });
    log(e.message);
  }
}

/* stdin: one message per line. Each is sent as it comes (a long tool call does not hold up a ping); every
   answer is written as one whole line. On end of input, wait for the answers still coming. */
let buf = '';
const pending = new Set();
process.stdin.setEncoding('utf8');
process.stdin.on('data', d => {
  buf += d;
  let i;
  while ((i = buf.indexOf('\n')) >= 0) {
    const line = buf.slice(0, i);
    buf = buf.slice(i + 1);
    const p = onLine(line).finally(() => pending.delete(p));
    pending.add(p);
  }
});
process.stdin.on('end', async () => {
  if (buf.trim()) await onLine(buf);
  await Promise.all([...pending]);
  process.exit(0);
});
