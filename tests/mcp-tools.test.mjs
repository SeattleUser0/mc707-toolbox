// The MCP server's tools as they run in the app's page (src/ui/mcp-tools.js), called the way the desktop
// app's main process calls them (window.__app.mcp is mcpHandle): the song file in and out, the composer,
// playback to the MC-707 over MIDI, the project file the song makes, and File > Open on a song file.
// The protocol, the token and the SD card are tested without a browser (tests/mcp-server.test.mjs).
//
// Revision history
//   0.1.0  2026-11-20  First version (fork, MCP server work).
import { test, after } from 'node:test';
import assert from 'node:assert/strict';
import fs from 'node:fs';
import os from 'node:os';
import path from 'node:path';
import { openApp, closeBrowser } from './helpers.mjs';

after(closeBrowser);

/* call a tool; the JSON in its text comes back parsed (or the text, when it is not JSON) */
const tool = (page, name, args = {}) =>
  page.evaluate(
    async ([name, args]) => {
      const r = await window.__app.mcp('tools/call', { name, arguments: args });
      let out;
      try {
        out = JSON.parse(r.content[0].text);
      } catch (e) {
        out = r.content[0].text;
      }
      return { isError: !!r.isError, out };
    },
    [name, args]
  );
/* two factory sounds in the Sound library: a bass tone and a kit with its bytes (as Grab from > Factory gives them) */
const addSounds = page =>
  page.evaluate(() => {
    const A = window.__app,
      { ZS } = A.zen;
    ZS.ready = true;
    ZS.list.push({
      id: 'fB113',
      src: 'factory',
      bank: 'B',
      no: 113,
      name: 'Round Bass',
      kind: 'tone',
      type: 'bass',
      tags: [],
      d: { 'CMN.NAME': 'Round Bass' }
    });
    const rec = new Uint8Array(0xd00);
    [...'Test Kit'.padEnd(16)].forEach((c, i) => (rec[i] = c.charCodeAt(0)));
    const inst = n => btoa(String.fromCharCode(...[...(n.padEnd(16) + ' '.repeat(200))].map(c => c.charCodeAt(0))));
    const b64 = u => btoa(String.fromCharCode(...u));
    ZS.list.push({
      id: 'fk1',
      src: 'factory',
      name: 'Test Kit',
      kind: 'kit',
      type: 'drums',
      tags: [],
      d: { 'KCMN.NAME': 'Test Kit' },
      mpj: { rec: b64(rec), inst: { 0: inst('Off'), 1: inst('Test Kick') } }
    });
  });

test('tools/list: every tool, with schemas; read-only tools say so', async () => {
  const { page, errors } = await openApp();
  const r = await page.evaluate(() => window.__app.mcp('tools/list', {}));
  const names = r.tools.map(t => t.name);
  assert.deepEqual(names, [
    'status',
    'song_format',
    'list_sounds',
    'list_styles',
    'compose_song',
    'load_song',
    'get_song',
    'play',
    'stop',
    'save_project'
  ]);
  for (const t of r.tools) assert.equal(t.inputSchema.type, 'object', t.name);
  assert.deepEqual(
    r.tools.filter(t => t.annotations && t.annotations.readOnlyHint).map(t => t.name),
    ['status', 'song_format', 'list_sounds', 'list_styles', 'get_song']
  );
  const st = await tool(page, 'status');
  assert.equal(st.out.device, 'MC-707');
  assert.equal(st.out.card, null, 'no desktop app: no card');
  const bad = await tool(page, 'no_such_tool');
  assert.equal(bad.isError, true);
  assert.deepEqual(errors, []);
});

test('load_song: the example from song_format goes in as Scene Mode clips and scenes, with sounds, and makes a project file', async () => {
  const { page, errors } = await openApp();
  await addSounds(page);
  const fmt = await tool(page, 'song_format');
  assert.match(fmt.out.guide, /mc707-song/);
  const song = fmt.out.example;
  song.tracks[0].sound = 'Test Kit';
  song.tracks[1].sound = 'round bass';
  const dry = await tool(page, 'load_song', { song, dry_run: true });
  assert.equal(dry.isError, false);
  assert.equal(dry.out.applied, false);
  assert.deepEqual(dry.out.warnings, []);
  assert.equal(await page.evaluate(() => !!window.__app.S.scn), false, 'a dry run changes nothing');
  const r = await tool(page, 'load_song', { song });
  assert.equal(r.out.applied, true);
  assert.equal(r.out.summary.scenes, 5);
  const got = await page.evaluate(async () => {
    const A = window.__app,
      S = A.S,
      q = S.scn;
    const { bytes, song } = await A.mpj.bytes('EXAMPLE');
    const back = A.mpj.read(bytes);
    return {
      bpm: S.bpm,
      rows: q.rows.map(r => [r.name, r.bars, r.pick.join()]),
      tones: q.clips.map(l =>
        l
          .filter(Boolean)
          .map(c => (c.tone ? q.tones[c.tone].name : '-'))
          .join()
      ),
      markers: S.markers.map(m => m.bar + ' ' + m.name),
      timeline: S.clips.length,
      undo: !document.querySelector('#bUndo').disabled,
      file: {
        name: back.name,
        bpm: back.bpm,
        scenes: song.scenes.length,
        clips: song.clips.length,
        lost: song.lost,
        sounds: song.tones.length
      }
    };
  });
  assert.equal(got.bpm, 122);
  assert.deepEqual(got.rows[0], ['Intro', 8, '2,-1,-1,-1,0,-1,-1,-1']);
  assert.deepEqual(got.rows[3], ['Hook', 16, '0,-1,-1,0,0,-1,0,-1']);
  assert.equal(got.tones[0], 'Test Kit,Test Kit,Test Kit');
  assert.equal(got.tones[3], 'Round Bass');
  assert.deepEqual(got.markers, ['0 Intro', '8 Groove', '23 Fill', '24 Hook', '40 Outro']);
  assert.ok(got.timeline > 0);
  assert.equal(got.undo, true);
  assert.equal(got.file.name.trim(), 'EXAMPLE');
  assert.equal(got.file.bpm, 122);
  assert.equal(got.file.scenes, 5);
  assert.equal(got.file.clips, 6);
  assert.deepEqual(got.file.lost, []);
  assert.equal(got.file.sounds, 4);
  assert.deepEqual(errors, []);
});

test('load_song: errors change nothing; get_song gives back a song that loads again', async () => {
  const { page, errors } = await openApp();
  const fmt = await tool(page, 'song_format');
  await tool(page, 'load_song', { song: fmt.out.example });
  const bad = JSON.parse(JSON.stringify(fmt.out.example));
  bad.scenes[0].play.push('missing');
  bad.clips[0].notes.push([99, 1, 'kick']);
  const r = await tool(page, 'load_song', { song: bad });
  assert.equal(r.isError, true);
  assert.ok(r.out.errors.some(e => e.startsWith('clips[0].notes[10]: start 99')));
  assert.equal(await page.evaluate(() => window.__app.S.scn.rows.length), 5, 'the song from before is still there');
  const g = await tool(page, 'get_song');
  assert.equal(g.out.song.format, 'mc707-song');
  assert.equal(g.out.song.scenes.length, 5);
  assert.equal(g.out.song.clips.length, 6);
  assert.deepEqual(g.out.song.scenes[1].play, ['t1c1', 't4c1', 't5c1']);
  const again = await tool(page, 'load_song', { song: g.out.song, dry_run: true });
  assert.equal(again.isError, false);
  assert.deepEqual(errors, []);
});

test('compose_song: the composer writes a song with scenes; get_song reads it', async () => {
  const { page, errors } = await openApp();
  const styles = await tool(page, 'list_styles');
  assert.ok(styles.out.styles.some(s => s.id === 'liquid'));
  const c = await tool(page, 'compose_song', {
    style: 'liquid',
    key: 'D',
    bpm: 174,
    minutes: 2,
    seed: 3,
    sounds: false
  });
  assert.equal(c.isError, false, JSON.stringify(c.out));
  assert.ok(c.out.sections > 2);
  assert.equal(c.out.scenes, true);
  const g = await tool(page, 'get_song');
  assert.equal(g.out.song.bpm, 174);
  assert.equal(g.out.song.key, 'D');
  assert.ok(g.out.song.scenes.length > 2);
  const none = await tool(page, 'compose_song', { style: 'polka' });
  assert.equal(none.isError, true);
  assert.deepEqual(errors, []);
});

test('play sends the scenes to the MC-707 over MIDI; stop stops; save_project needs the desktop app', async () => {
  const { page, errors } = await openApp();
  const fmt = await tool(page, 'song_format');
  await tool(page, 'load_song', { song: fmt.out.example });
  await page.evaluate(async () => {
    window.__app.ensureAudio();
    await window.__app.connectMidi();
  });
  const p = await tool(page, 'play', { scene: 2 });
  assert.equal(p.isError, false);
  assert.equal(p.out.from_scene, 2);
  await page.waitForTimeout(600);
  const on = await page.evaluate(() => ({
    playing: window.__app.TR.playing,
    notes: (window.__out || []).filter(b => (b[0] & 0xf0) === 0x90 && b[2] > 0).length
  }));
  assert.equal(on.playing, true);
  assert.ok(on.notes > 0, 'note-ons went out');
  await tool(page, 'stop');
  assert.equal(await page.evaluate(() => window.__app.TR.playing), false);
  const s = await tool(page, 'save_project', {});
  assert.equal(s.isError, true);
  assert.match(s.out, /desktop app/);
  assert.deepEqual(errors, []);
});

test('File > Open takes a song file (as ChatGPT would write it)', async () => {
  const { page, errors } = await openApp();
  const fmt = await tool(page, 'song_format');
  const file = path.join(fs.mkdtempSync(path.join(os.tmpdir(), 'songfile-')), 'chatgpt-song.json');
  fs.writeFileSync(file, JSON.stringify({ ...fmt.out.example, name: 'FROM GPT' }));
  await page.setInputFiles('#fileIn', file);
  await page.waitForFunction(() => window.__app.S.scn && window.__app.S.scn.rows.length === 5);
  const toast = await page
    .locator('.toast, #toast')
    .last()
    .textContent()
    .catch(() => '');
  assert.match(toast || 'Opened the song file', /Opened the song file/);
  const bad = path.join(path.dirname(file), 'bad.json');
  fs.writeFileSync(bad, JSON.stringify({ format: 'mc707-song', v: 1, bpm: 500, clips: [], scenes: [] }));
  await page.setInputFiles('#fileIn', bad);
  await page.waitForTimeout(300);
  assert.equal(await page.evaluate(() => window.__app.S.scn.rows.length), 5, 'a bad song file changes nothing');
  assert.deepEqual(errors, []);
});
