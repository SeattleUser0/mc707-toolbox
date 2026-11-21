// The song file an AI writes (format "mc707-song", version 1, docs/MCP-SPEC.md section 4), to and from the
// Toolbox's own song. From it: the track setup, one pattern per MC-707 clip, Scene Mode's clips and scene
// chain (S.scn, the shape core/scene-model.js describes) with each clip's sound, and the same song laid out
// in Song Mode (a timeline clip per run of the same clip, a marker per scene). Back to it: the Scene Mode
// clips and scenes of a song, so an AI can read the song, change it and load it again.
//
// Plain functions only: no page, no app state. The caller gives the empty song to fill (newState()) and a
// way to find a sound by name (the Sound library lives in zen/, which core may not import). So the whole
// conversion runs in Node for tests (tests/song-spec.node.mjs).
//
// Revision history
//   0.1.0  2026-11-20  First version (fork SeattleUser0/mc707-toolbox, MCP server work).
//
// Reads: nothing (works on what it is given).
import { LANES, NOTE_NAMES, SCALES } from './theory.js';

export const SPEC_FORMAT = 'mc707-song',
  SPEC_V = 1;
/** Clip lengths an MC-707 clip can hold from the Toolbox (zen/zc-seq.js: up to 128 steps of 1/8). */
export const SPEC_BARS = [1, 2, 4, 8, 16];
const CLIPS_PER_TRACK = 16,
  SCENES_MAX = 128,
  SCENE_BARS_MAX = 127,
  SONG_BARS_MAX = 512;
/** [role, type] for every role, and the default role of tracks 1 to 8 (core/tracks.js has the same lists). */
const ROLE_TYPE = {
  kit: 'drum',
  hats: 'drum',
  perc: 'drum',
  bass: 'tone',
  chords: 'tone',
  pad: 'tone',
  lead: 'tone',
  pluck: 'tone',
  acid: 'tone'
};
const DEF_ROLES = ['kit', 'hats', 'perc', 'bass', 'chords', 'pad', 'lead', 'pluck'];
/** Drum lane names an AI may use, by lane 0-11 (theory.js LANES order). The first name is the one written back. */
export const LANE_NAMES = [
  ['kick', 'bd', 'k'],
  ['rim', 'rimshot', 'rs'],
  ['snare', 'sd', 's'],
  ['clap', 'cp', 'c'],
  ['hat', 'chh', 'closed hat', 'closedhat', 'hh', 'h'],
  ['ohat', 'ohh', 'open hat', 'openhat', 'oh'],
  ['ltom', 'low tom', 'lowtom', 'lt'],
  ['mtom', 'mid tom', 'midtom', 'mt'],
  ['htom', 'high tom', 'hightom', 'ht'],
  ['crash', 'cr', 'cy'],
  ['ride', 'rd'],
  ['perc', 'pc', 'cowbell', 'shaker', 'tamb']
];
const LANE_OF = new Map(LANE_NAMES.flatMap((names, i) => names.map(n => [n, i])));
const GM_LANE = new Map(LANES.map(([, midi], i) => [midi, i]));
const KEY_OF = {
  C: 0,
  'C#': 1,
  DB: 1,
  D: 2,
  'D#': 3,
  EB: 3,
  E: 4,
  F: 5,
  'F#': 6,
  GB: 6,
  G: 7,
  'G#': 8,
  AB: 8,
  A: 9,
  'A#': 10,
  BB: 10,
  B: 11
};
/** A key root name (C, C#, Db ... B) as 0-11; null when it is none. */
export const specKey = k => (k == null ? null : (KEY_OF[String(k).trim().toUpperCase()] ?? null));
const ID_RE = /^[A-Za-z0-9_-]{1,40}$/;

/** A project name the MC-707 and the file system both take: 16 characters of letters, digits, space, - and _. */
export const specName = n =>
  String(n || '')
    .replace(/[^A-Za-z0-9 _-]/g, '-')
    .replace(/\s+/g, ' ')
    .trim()
    .slice(0, 16);

/** A note name (C4 = 60, sharps or flats) or a MIDI number, as a MIDI number; null when it is neither. */
export function specNote(x) {
  if (typeof x === 'number') return Number.isInteger(x) && x >= 0 && x <= 127 ? x : null;
  const m = /^\s*([A-Ga-g])([#b]?)(-?\d{1,2})\s*$/.exec(String(x));
  if (!m) return null;
  const n =
    (+m[3] + 1) * 12 +
    { C: 0, D: 2, E: 4, F: 5, G: 7, A: 9, B: 11 }[m[1].toUpperCase()] +
    (m[2] === '#' ? 1 : m[2] === 'b' ? -1 : 0);
  return n >= 0 && n <= 127 ? n : null;
}
/** A drum note (lane name, lane 0-11 or a lane's General MIDI note) as a lane 0-11; null when it is none of them. */
export function specLane(x) {
  if (typeof x === 'number')
    return Number.isInteger(x) && x >= 0 && x < 12 ? x : GM_LANE.has(x) ? GM_LANE.get(x) : null;
  const k = String(x).trim().toLowerCase();
  return LANE_OF.has(k) ? LANE_OF.get(k) : null;
}

/* a note as [s, l, n, v] or {s, l, n, v}, read loosely; the checks come after */
const noteParts = x =>
  Array.isArray(x) ? { s: x[0], l: x[1], n: x[2], v: x[3] } : x && typeof x === 'object' ? x : null;

/**
 * Check one clip's notes and turn them into Toolbox notes ({s, l, n, v}; n a lane on drum tracks).
 * Errors go into errs with their place; returns the notes.
 */
function readNotes(c, at, type, errs) {
  const end = c.bars * 16,
    out = [];
  if (c.notes != null && !Array.isArray(c.notes)) return (errs.push(at + '.notes: must be a list'), out);
  (c.notes || []).forEach((x, j) => {
    const w = at + '.notes[' + j + ']',
      p = noteParts(x);
    if (!p) return errs.push(w + ': a note is [start, length, note, velocity]');
    const s = +p.s,
      l = p.l == null ? 1 : +p.l,
      v = p.v == null ? 100 : +p.v;
    if (!Number.isFinite(s) || s < 0) return errs.push(w + ': start must be a number of 16th steps from 0');
    if (s >= end)
      return errs.push(w + ': start ' + s + ' is past the end of a ' + c.bars + '-bar clip (' + end + ' steps)');
    if (!Number.isFinite(l) || l <= 0) return errs.push(w + ': length must be above 0 (16th steps)');
    if (!Number.isFinite(v) || v < 1 || v > 127) return errs.push(w + ': velocity must be 1 to 127');
    const n = type === 'drum' ? specLane(p.n) : specNote(p.n);
    if (n == null)
      return errs.push(
        w +
          (type === 'drum'
            ? ': ' +
              JSON.stringify(p.n) +
              ' is not a drum lane (kick, rim, snare, clap, hat, ohat, ltom, mtom, htom, crash, ride, perc)'
            : ': ' + JSON.stringify(p.n) + ' is not a note (C4 = 60, or 0 to 127)')
      );
    out.push({ s: Math.round(s * 1e4) / 1e4, l: Math.round(l * 1e4) / 1e4, n, v: Math.round(v) });
  });
  return out.sort((a, b) => a.s - b.s || a.n - b.n);
}

/* the track setup: for each of the 8 tracks its role, type, name and default sound; errors for bad entries */
function readTracks(spec, base, errs, warns) {
  const tr = base.tracks.map((t, i) => ({
    role: DEF_ROLES[i],
    type: ROLE_TYPE[DEF_ROLES[i]],
    name: t.name,
    sound: null
  }));
  if (spec.tracks != null && !Array.isArray(spec.tracks)) return (errs.push('tracks: must be a list'), tr);
  const seen = new Set();
  (spec.tracks || []).forEach((x, i) => {
    const at = 'tracks[' + i + ']',
      t = x && +x.track;
    if (!Number.isInteger(t) || t < 1 || t > 8) return errs.push(at + '.track: must be 1 to 8');
    if (seen.has(t)) return errs.push(at + '.track: track ' + t + ' is listed twice');
    seen.add(t);
    const o = tr[t - 1];
    if (x.role != null) {
      if (!ROLE_TYPE[x.role])
        return errs.push(
          at + '.role: ' + JSON.stringify(x.role) + ' is not one of ' + Object.keys(ROLE_TYPE).join(', ')
        );
      o.role = x.role;
      o.type = ROLE_TYPE[x.role];
      if (x.name == null && x.role !== DEF_ROLES[t - 1]) o.name = x.role[0].toUpperCase() + x.role.slice(1);
    }
    if (x.name != null) {
      o.name = String(x.name).slice(0, 16);
      if (String(x.name).length > 16) warns.push(at + '.name: cut to 16 characters (' + o.name + ')');
    }
    if (x.sound != null) o.sound = String(x.sound);
  });
  return tr;
}

/**
 * Read a song file into a new Toolbox song.
 * @param {object} spec   the song file (docs/MCP-SPEC.md section 4)
 * @param {{base: object, findSound?: (name: string, kind: 'tone'|'kit') => ({key: string, tone: object}|null)}} o
 *   base: an empty song to fill (newState()); findSound: the Sound library's lookup (none: every sound is reported missing)
 * @returns {{song: object|null, name: string, errors: string[], warnings: string[], summary: object|null}}
 */
export function specToSong(spec, o) {
  const errs = [],
    warns = [];
  const fail = () => ({ song: null, name: '', errors: errs, warnings: warns, summary: null });
  if (!spec || typeof spec !== 'object' || Array.isArray(spec))
    return (errs.push('the song must be a JSON object'), fail());
  if (spec.format !== SPEC_FORMAT) errs.push('format: must be "' + SPEC_FORMAT + '"');
  if (spec.v !== SPEC_V) errs.push('v: must be ' + SPEC_V);
  const bpm = +spec.bpm;
  if (!Number.isFinite(bpm) || bpm < 40 || bpm > 240) errs.push('bpm: must be 40 to 240');
  const swing = spec.swing == null ? 50 : +spec.swing;
  if (!Number.isFinite(swing) || swing < 50 || swing > 75) errs.push('swing: must be 50 (straight) to 75');
  const key = spec.key == null ? 0 : specKey(spec.key);
  if (key == null) errs.push('key: ' + JSON.stringify(spec.key) + ' is not a key (C, C#, Db ... B)');
  const scale = spec.scale == null ? 'minor' : String(spec.scale);
  if (!SCALES[scale]) errs.push('scale: must be one of ' + Object.keys(SCALES).join(', '));
  const tracks = readTracks(spec, o.base, errs, warns);
  if (errs.length) return fail();
  const clips = readClips(spec, tracks, errs, warns);
  const scenes = clips ? readScenes(spec, clips, errs, warns) : null;
  if (errs.length || !clips || !scenes) return fail();
  const song = build(o.base, { bpm, swing, key, scale, tracks, clips, scenes }, o.findSound, warns);
  if (!song) return (errs.push('the song is longer than the ' + SONG_BARS_MAX + ' bars the Toolbox holds'), fail());
  const name = specName(spec.name);
  if (spec.name != null && name !== String(spec.name))
    warns.push('name: written as "' + name + '" (16 characters: letters, digits, space, - and _)');
  return {
    song,
    name,
    errors: [],
    warnings: warns,
    summary: {
      scenes: scenes.length,
      clips: clips.length,
      bars: scenes.reduce((a, r) => a + r.bars, 0),
      bpm,
      tracks: tracks.map((t, i) => ({
        track: i + 1,
        role: t.role,
        name: t.name,
        clips: clips.filter(c => c.t === i).length
      }))
    }
  };
}

/* the clips: checked, with their track (0-7), place on the track (0-15) and Toolbox notes */
function readClips(spec, tracks, errs, warns) {
  if (!Array.isArray(spec.clips) || !spec.clips.length)
    return (errs.push('clips: must be a list with at least one clip'), null);
  const ids = new Set(),
    perTrack = Array(8).fill(0),
    out = [];
  spec.clips.forEach((c, i) => {
    const at = 'clips[' + i + ']';
    if (!c || typeof c !== 'object') return errs.push(at + ': must be an object');
    if (typeof c.id !== 'string' || !ID_RE.test(c.id))
      return errs.push(at + '.id: letters, digits, _ and - only (up to 40)');
    if (ids.has(c.id)) return errs.push(at + '.id: "' + c.id + '" is used twice');
    ids.add(c.id);
    const t = +c.track;
    if (!Number.isInteger(t) || t < 1 || t > 8) return errs.push(at + '.track: must be 1 to 8');
    if (!SPEC_BARS.includes(+c.bars)) return errs.push(at + '.bars: must be one of ' + SPEC_BARS.join(', '));
    if (perTrack[t - 1] >= CLIPS_PER_TRACK)
      return errs.push(at + ': track ' + t + ' already has 16 clips (the MC-707 holds 16 a track)');
    const type = tracks[t - 1].type;
    const tr = c.transpose == null ? 0 : +c.transpose;
    if (!Number.isInteger(tr) || tr < -48 || tr > 48) return errs.push(at + '.transpose: a whole number -48 to 48');
    if (tr && type === 'drum') warns.push(at + '.transpose: ignored on a drum track');
    const name = c.name == null ? c.id : String(c.name);
    if (name.length > 16) warns.push(at + '.name: cut to 16 characters');
    const notes = readNotes({ ...c, bars: +c.bars }, at, type, errs);
    out.push({
      id: c.id,
      t: t - 1,
      k: perTrack[t - 1]++,
      bars: +c.bars,
      name: name.slice(0, 16),
      sound: c.sound == null ? null : String(c.sound),
      tr: type === 'tone' ? tr : 0,
      type,
      notes,
      at
    });
  });
  return out;
}

/* the scenes: checked, each with its length and the clip (0-15) each track plays, or -1 */
function readScenes(spec, clips, errs, warns) {
  if (!Array.isArray(spec.scenes) || !spec.scenes.length)
    return (errs.push('scenes: must be a list with at least one scene'), null);
  if (spec.scenes.length > SCENES_MAX)
    return (errs.push('scenes: ' + spec.scenes.length + ' scenes; the MC-707 holds ' + SCENES_MAX), null);
  const byId = new Map(clips.map(c => [c.id, c]));
  return spec.scenes.map((r, i) => {
    const at = 'scenes[' + i + ']',
      pick = Array(8).fill(-1);
    const bars = r && +r.bars;
    if (!Number.isInteger(bars) || bars < 1 || bars > SCENE_BARS_MAX)
      errs.push(at + '.bars: a whole number 1 to ' + SCENE_BARS_MAX);
    const name = String((r && r.name) || 'Scene ' + (i + 1));
    if (name.length > 16) warns.push(at + '.name: cut to 16 characters');
    const play = r && r.play;
    if (!Array.isArray(play)) errs.push(at + '.play: a list of clip ids');
    else
      play.forEach((id, j) => {
        const c = byId.get(id);
        if (!c) return errs.push(at + '.play[' + j + ']: no clip has the id ' + JSON.stringify(id));
        if (pick[c.t] >= 0)
          return errs.push(at + '.play[' + j + ']: track ' + (c.t + 1) + ' already plays another clip in this scene');
        pick[c.t] = c.k;
      });
    return { name: name.slice(0, 16), bars, pick };
  });
}

/* the Toolbox song: tracks, patterns, Scene Mode's clips, scenes and sounds, and the Song Mode layout */
function build(base, d, findSound, warns) {
  const s = JSON.parse(JSON.stringify(base));
  const total = d.scenes.reduce((a, r) => a + r.bars, 0);
  if (total > SONG_BARS_MAX) return null;
  let id = Math.max(1, +s.nextId || 1);
  Object.assign(s, {
    bpm: Math.round(d.bpm * 100) / 100,
    swing: d.swing,
    key: d.key,
    scale: d.scale,
    patterns: {},
    clips: [],
    markers: [],
    clipMarks: [],
    cursor: 0
  });
  s.loop = { on: false, start: 0, end: 8 };
  s.tracks = s.tracks.map((t, i) => {
    const x = { ...t, name: d.tracks[i].name, type: d.tracks[i].type };
    if (d.tracks[i].role === DEF_ROLES[i]) delete x.role;
    else x.role = d.tracks[i].role;
    return x;
  });
  const q = {
    v: 2,
    first: 0,
    clips: Array.from({ length: 8 }, () => Array(16).fill(null)),
    rows: [],
    tones: {},
    done: { c: {}, s: {}, p: {} }
  };
  const missing = new Set();
  for (const c of d.clips) {
    const pid = 'p' + id++;
    s.patterns[pid] = {
      id: pid,
      name: c.name,
      type: c.type,
      bars: c.bars,
      notes: c.notes,
      mod: false,
      key: c.type === 'tone' ? { root: d.key, scale: d.scale } : null
    };
    const cell = { pat: pid };
    if (c.tr) cell.tr = c.tr;
    const want = c.sound || d.tracks[c.t].sound;
    if (want) {
      const kind = c.type === 'drum' ? 'kit' : 'tone',
        f = findSound ? findSound(want, kind) : null;
      if (f && f.tone && f.tone.kind === kind) {
        q.tones[f.key] = f.tone;
        cell.tone = f.key;
      } else if (!missing.has(want + kind)) {
        missing.add(want + kind);
        warns.push(
          c.at +
            ': no ' +
            (kind === 'kit' ? 'factory kit' : 'tone') +
            ' named "' +
            want +
            '" in the Sound library; the clip keeps the template’s sound (list_sounds lists them)'
        );
      }
    }
    q.clips[c.t][c.k] = cell;
  }
  q.rows = d.scenes.map(r => ({ id: 'r' + id++, name: r.name, bars: r.bars, pick: r.pick }));
  s.scn = q;
  layOut(s, q, () => 'c' + id++);
  s.bars = Math.min(SONG_BARS_MAX, Math.max(8, Math.ceil((total + 4) / 8) * 8));
  s.nextId = id;
  return s;
}

/* Song Mode: the scenes one after another, a timeline clip per run of the same clip, a marker per scene
   (as scene/convert.js scenesToSong does it) */
function layOut(s, q, nextClipId) {
  let at = 0;
  const open = Array(8).fill(null);
  const shut = t => open[t] && (s.clips.push(open[t].clip), (open[t] = null));
  for (const r of q.rows) {
    s.markers.push({ bar: at, name: r.name });
    for (let t = 0; t < 8; t++) {
      const k = r.pick[t],
        c = k >= 0 ? q.clips[t][k] : null;
      if (open[t] && open[t].k === k) open[t].clip.len += r.bars;
      else {
        shut(t);
        if (c) {
          const clip = { id: nextClipId(), t, start: at, len: r.bars, off: 0, pat: c.pat };
          if (c.tr) clip.tr = c.tr;
          open[t] = { k, clip };
        }
      }
    }
    at += r.bars;
  }
  for (let t = 0; t < 8; t++) shut(t);
}

/**
 * A Toolbox song's Scene Mode clips and scenes as a song file. Scenes and clips come from `made` (S.scn,
 * or what scene/convert.js songToRows makes from Song Mode when there is no S.scn).
 * @param {object} s      the song (S)
 * @param {{rows: object[], clips: object[][], tones?: object}} made
 * @param {string} name   the project name
 * @returns {object} the song file
 */
export function songToSpec(s, made, name) {
  const tones = made.tones || {},
    tracks = [],
    clips = [];
  const idOf = (t, k) => 't' + (t + 1) + 'c' + (k + 1);
  for (let t = 0; t < 8; t++) {
    const tr = s.tracks[t],
      role = tr.role || DEF_ROLES[t];
    tracks.push({
      track: t + 1,
      role: ROLE_TYPE[role] === tr.type ? role : tr.type === 'drum' ? 'kit' : 'lead',
      name: tr.name
    });
    for (let k = 0; k < 16; k++) {
      const c = made.clips[t] && made.clips[t][k],
        p = c && s.patterns[c.pat];
      if (!p) continue;
      const drum = p.type === 'drum';
      const o = {
        id: idOf(t, k),
        track: t + 1,
        bars: p.bars,
        name: String(p.name || '').slice(0, 16),
        notes: p.notes.map(n => [n.s, n.l, drum ? (LANE_NAMES[n.n] ? LANE_NAMES[n.n][0] : n.n) : noteName(n.n), n.v])
      };
      if (c.tr) o.transpose = c.tr;
      if (c.tone && tones[c.tone]) o.sound = tones[c.tone].name;
      clips.push(o);
    }
  }
  return {
    format: SPEC_FORMAT,
    v: SPEC_V,
    name: specName(name),
    bpm: s.bpm,
    swing: s.swing,
    key: NOTE_NAMES[s.key] || 'C',
    scale: s.scale,
    tracks,
    clips,
    scenes: made.rows.map(r => ({
      name: r.name,
      bars: r.bars,
      play: r.pick
        .map((k, t) =>
          k >= 0 && made.clips[t] && made.clips[t][k] && s.patterns[made.clips[t][k].pat] ? idOf(t, k) : null
        )
        .filter(Boolean)
    }))
  };
}
const noteName = n => NOTE_NAMES[((n % 12) + 12) % 12] + (Math.floor(n / 12) - 1);
