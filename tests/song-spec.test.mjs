// The song file an AI writes (core/song-spec.js, docs/MCP-SPEC.md section 4): read into a Toolbox song and
// written back. Plain Node, no browser: core/song-spec.js imports only core/theory.js.
//
// Revision history
//   0.1.0  2026-11-20  First version (fork, MCP server work).
import { test } from 'node:test';
import assert from 'node:assert/strict';
import { specToSong, songToSpec, specNote, specLane, specName } from '../src/core/song-spec.js';
import { SONG_EXAMPLE } from '../src/ui/mcp-guide.js';
import fs from 'node:fs';
import { FILE, songFormatDoc } from '../scripts/mcp-song-format.mjs';

/* an empty song shaped like core/state.js newState() (that module needs a page, so the shape is copied) */
const NAMES = ['Drums 1', 'Drums 2', 'Drums 3', 'Bass', 'Chords', 'Pad', 'Lead', 'Pluck'];
const base = () => ({
  v: 1,
  bpm: 120,
  swing: 50,
  bars: 32,
  key: 5,
  scale: 'minor',
  tracks: NAMES.map((name, i) => ({
    name,
    type: i < 3 ? 'drum' : 'tone',
    ch: i + 1,
    mute: false,
    solo: false,
    vol: 100
  })),
  patterns: {},
  clips: [],
  markers: [],
  nextId: 1
});
const TONES = {
  'saw bass 1': { key: 'h1', tone: { name: 'Saw Bass 1', kind: 'tone', d: { a: 1 } } },
  'tr-909 kit': { key: 'h2:kit', tone: { name: 'TR-909 Kit', kind: 'kit', d: { b: 2 }, mpj: { rec: 'x', inst: {} } } }
};
const findSound = (name, kind) => {
  const f = TONES[name.toLowerCase()];
  return f && f.tone.kind === kind ? f : null;
};
const good = () => ({
  format: 'mc707-song',
  v: 1,
  name: 'NIGHT BUS',
  bpm: 124,
  swing: 54,
  key: 'F',
  scale: 'minor',
  tracks: [
    { track: 1, role: 'kit', name: 'Drums', sound: 'TR-909 Kit' },
    { track: 4, role: 'bass', sound: 'Saw Bass 1' }
  ],
  clips: [
    {
      id: 'beat',
      track: 1,
      bars: 1,
      notes: [
        [0, 1, 'kick', 120],
        [4, 1, 'clap'],
        [8, 1, 36, 110],
        [12, 1, 3]
      ]
    },
    { id: 'beat_b', track: 1, bars: 2, notes: [{ s: 0, l: 1, n: 'kick', v: 100 }] },
    {
      id: 'bass_a',
      track: 4,
      bars: 2,
      transpose: -12,
      notes: [
        [0, 2, 'F1', 110],
        [3, 1, 'F2']
      ]
    }
  ],
  scenes: [
    { name: 'Intro', bars: 8, play: ['beat'] },
    { name: 'Drop', bars: 16, play: ['beat', 'bass_a'] },
    { name: 'Drop 2', bars: 8, play: ['beat', 'bass_a'] },
    { name: 'Break', bars: 4, play: ['beat_b'] }
  ]
});

test('note names, lanes and project names', () => {
  assert.equal(specNote('C4'), 60);
  assert.equal(specNote('F#2'), 42);
  assert.equal(specNote('Bb1'), 34);
  assert.equal(specNote('C-1'), 0);
  assert.equal(specNote(127), 127);
  assert.equal(specNote('H2'), null);
  assert.equal(specNote(128), null);
  assert.equal(specLane('kick'), 0);
  assert.equal(specLane('Open Hat'), 5);
  assert.equal(specLane(11), 11);
  assert.equal(specLane(42), 4);
  assert.equal(specLane(60), null);
  assert.equal(specLane('cowbell'), 11);
  assert.equal(specName('Night/Bus: the long one'), 'Night-Bus- the l');
});

test('a good song becomes Scene Mode clips, scenes, sounds and a Song Mode layout', () => {
  const r = specToSong(good(), { base: base(), findSound });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  const s = r.song;
  assert.equal(r.name, 'NIGHT BUS');
  assert.equal(s.bpm, 124);
  assert.equal(s.swing, 54);
  assert.equal(s.key, 5);
  assert.equal(s.tracks[0].name, 'Drums');
  assert.equal(s.tracks[0].role, undefined, 'a default role is left out, as the Toolbox saves it');
  /* the clips: track 1 has two, in the order listed; track 4 one */
  const q = s.scn;
  assert.equal(q.clips[0].filter(Boolean).length, 2);
  assert.equal(q.clips[3].filter(Boolean).length, 1);
  const beat = s.patterns[q.clips[0][0].pat];
  assert.equal(beat.type, 'drum');
  assert.deepEqual(
    beat.notes.map(n => [n.s, n.n, n.v]),
    [
      [0, 0, 120],
      [4, 3, 100],
      [8, 0, 110],
      [12, 3, 100]
    ]
  );
  assert.equal(q.clips[3][0].tr, -12);
  assert.deepEqual(
    s.patterns[q.clips[3][0].pat].notes.map(n => n.n),
    [29, 41]
  );
  /* sounds: a track's sound goes on its clips */
  assert.equal(q.clips[0][0].tone, 'h2:kit');
  assert.equal(q.clips[0][1].tone, 'h2:kit');
  assert.equal(q.clips[3][0].tone, 'h1');
  assert.equal(q.tones.h1.name, 'Saw Bass 1');
  /* scenes */
  assert.deepEqual(
    q.rows.map(r => [r.name, r.bars, r.pick[0], r.pick[3]]),
    [
      ['Intro', 8, 0, -1],
      ['Drop', 16, 0, 0],
      ['Drop 2', 8, 0, 0],
      ['Break', 4, 1, -1]
    ]
  );
  /* Song Mode: a marker per scene, one clip per run of the same clip */
  assert.deepEqual(
    s.markers.map(m => [m.bar, m.name]),
    [
      [0, 'Intro'],
      [8, 'Drop'],
      [24, 'Drop 2'],
      [32, 'Break']
    ]
  );
  const t1 = s.clips.filter(c => c.t === 0).map(c => [c.start, c.len]);
  assert.deepEqual(t1, [
    [0, 32],
    [32, 4]
  ]);
  const t4 = s.clips.filter(c => c.t === 3).map(c => [c.start, c.len, c.tr]);
  assert.deepEqual(t4, [[8, 24, -12]]);
  assert.ok(s.bars >= 36);
  /* ids: unique and below nextId */
  const ids = [...Object.keys(s.patterns), ...s.clips.map(c => c.id), ...q.rows.map(r => r.id)];
  assert.equal(new Set(ids).size, ids.length);
  assert.ok(ids.every(id => +id.replace(/\D/g, '') < s.nextId));
  assert.equal(r.summary.scenes, 4);
  assert.equal(r.summary.bars, 36);
});

test('a role that changes the track type', () => {
  const g = good();
  g.tracks.push({ track: 2, role: 'bass' }, { track: 8, role: 'perc' });
  g.clips.push(
    { id: 'b2', track: 2, bars: 1, notes: [[0, 1, 'C2']] },
    { id: 'p8', track: 8, bars: 1, notes: [[0, 1, 'ride']] }
  );
  g.scenes[0].play.push('b2', 'p8');
  const r = specToSong(g, { base: base(), findSound });
  assert.deepEqual(r.errors, []);
  assert.equal(r.song.tracks[1].type, 'tone');
  assert.equal(r.song.tracks[1].role, 'bass');
  assert.equal(r.song.tracks[1].name, 'Bass');
  assert.equal(r.song.tracks[7].type, 'drum');
  assert.equal(r.song.patterns[r.song.scn.clips[7][0].pat].notes[0].n, 10);
});

test('errors name their place and nothing is made', () => {
  const g = good();
  g.clips[0].notes.push([16, 1, 'kick']);
  g.clips[2].notes.push([0, 1, 'kick']);
  g.clips[1].bars = 3;
  g.scenes[1].play.push('nope');
  g.scenes[2].play.push('beat_b');
  const r = specToSong(g, { base: base(), findSound });
  assert.equal(r.song, null);
  assert.ok(r.errors.some(e => e.startsWith('clips[0].notes[4]: start 16 is past the end of a 1-bar clip')));
  assert.ok(r.errors.some(e => e.startsWith('clips[2].notes[2]: "kick" is not a note')));
  assert.ok(r.errors.some(e => e.startsWith('clips[1].bars: must be one of 1, 2, 4, 8, 16')));
  /* scenes are checked only once the clips are good */
  const g2 = good();
  g2.scenes[1].play.push('nope');
  g2.scenes[2].play.push('beat_b');
  const r2 = specToSong(g2, { base: base(), findSound });
  assert.ok(r2.errors.some(e => e === 'scenes[1].play[2]: no clip has the id "nope"'));
  assert.ok(r2.errors.some(e => e.startsWith('scenes[2].play[2]: track 1 already plays another clip')));
});

test('top-level errors', () => {
  const r = specToSong(
    { format: 'x', v: 2, bpm: 10, key: 'H', scale: 'weird', clips: [], scenes: [] },
    { base: base() }
  );
  assert.equal(r.song, null);
  for (const w of ['format', 'v', 'bpm', 'key', 'scale'])
    assert.ok(
      r.errors.some(e => e.startsWith(w + ':')),
      w
    );
});

test('limits: 16 clips a track, 128 scenes, 127 bars a scene', () => {
  const g = good();
  for (let i = 0; i < 15; i++) g.clips.push({ id: 'x' + i, track: 1, bars: 1, notes: [] });
  assert.ok(specToSong(g, { base: base() }).errors.some(e => e.includes('already has 16 clips')));
  const h = good();
  h.scenes = Array.from({ length: 129 }, () => ({ bars: 1, play: ['beat'] }));
  assert.ok(specToSong(h, { base: base() }).errors.some(e => e.includes('the MC-707 holds 128')));
  const k = good();
  k.scenes[0].bars = 128;
  assert.ok(specToSong(k, { base: base() }).errors.some(e => e.startsWith('scenes[0].bars')));
  const m = good();
  m.scenes = Array.from({ length: 5 }, () => ({ bars: 127, play: ['beat'] }));
  assert.ok(specToSong(m, { base: base() }).errors.some(e => e.includes('512 bars')));
});

test('warnings: missing sounds, long names, a kit on a tone track', () => {
  const g = good();
  g.name = 'A very long song name indeed';
  g.tracks[1].sound = 'No Such Tone';
  g.clips[2].sound = 'TR-909 Kit';
  g.scenes[0].name = 'An intro that goes on';
  const r = specToSong(g, { base: base(), findSound });
  assert.deepEqual(r.errors, []);
  assert.ok(r.warnings.some(w => w.startsWith('clips[2]: no tone named "TR-909 Kit"')));
  assert.ok(r.warnings.some(w => w.startsWith('name: written as "A very long song"')));
  assert.ok(r.warnings.some(w => w.startsWith('scenes[0].name: cut')));
  assert.equal(r.song.scn.clips[3][0].tone, undefined);
});

test('round trip: song file -> song -> song file -> song gives the same song', () => {
  const a = specToSong(good(), { base: base(), findSound });
  const spec = songToSpec(a.song, a.song.scn, a.name);
  assert.equal(spec.format, 'mc707-song');
  assert.equal(spec.key, 'F');
  assert.equal(spec.clips.find(c => c.id === 't1c1').sound, 'TR-909 Kit');
  assert.deepEqual(spec.clips.find(c => c.id === 't1c1').notes[1], [4, 1, 'clap', 100]);
  assert.deepEqual(spec.clips.find(c => c.id === 't4c1').notes[0], [0, 2, 'F1', 110]);
  const b = specToSong(spec, { base: base(), findSound });
  assert.deepEqual(b.errors, []);
  const strip = s =>
    JSON.stringify([
      s.tracks,
      Object.values(s.patterns).map(p => [p.type, p.bars, p.notes]),
      s.scn.rows.map(r => [r.name, r.bars, r.pick]),
      s.scn.tones,
      s.markers
    ]);
  assert.equal(strip(b.song), strip(a.song));
});

test('the example song_format gives is valid, and docs/MCP-SONG-FORMAT.md is current', () => {
  const r = specToSong(JSON.parse(JSON.stringify(SONG_EXAMPLE)), { base: base() });
  assert.deepEqual(r.errors, []);
  assert.deepEqual(r.warnings, []);
  assert.equal(r.summary.scenes, 5);
  assert.equal(fs.readFileSync(FILE, 'utf8'), songFormatDoc(), 'run node scripts/mcp-song-format.mjs');
});
