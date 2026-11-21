// The song file an AI writes (format "mc707-song", docs/MCP-SPEC.md section 4) in the app: its sounds found
// in the Sound library, the song made by core/song-spec.js, the notes an MC-707 clip cannot hold found with
// the same encoder Save as MC-707 project uses, and the song put in the app (one Undo step). Used by the MCP
// server's load_song (ui/mcp-tools.js) and by File > Open (ui/projects.js), so Claude over MCP and a file
// written by ChatGPT go in the same way.
//
// Revision history
//   0.1.0  2026-11-20  First version (fork, MCP server work).
//
// Reads: S, PROJ, DEV, ZS.
import { PROJ, S, UI, fixState, newState, pushUndo, replaceState } from '../core/state.js';
import { DEV } from '../core/device.js';
import { specToSong, songToSpec, SPEC_BARS } from '../core/song-spec.js';
import { stopAll } from '../services/transport.js';
import { ZS, hashOf, soundsLoad } from '../zen/zc-sounds.js';
import { encodePattern, lostText } from '../zen/zc-seq.js';
import { songToRows } from '../scene/convert.js';
import { afterReplaceKeepUndo } from './controls.js';

/** A name as the lookup compares it: lower case, single spaces, no spaces at the ends. */
const norm = n =>
  String(n || '')
    .toLowerCase()
    .replace(/\s+/g, ' ')
    .trim();

/**
 * The Sound library's lookup for core/song-spec.js: a name and kind give {key, tone} (the Scene Mode tone, as
 * scene/compose.js makes them) or null. Factory sounds come first; a kit must be a factory kit with its bytes,
 * since only those go into a project file.
 */
export async function soundFinder() {
  await soundsLoad();
  const idx = { tone: new Map(), kit: new Map() };
  const put = e => {
    const k = norm(e.name);
    if (e.kind === 'kit' && !e.mpj) return;
    if (!idx[e.kind] || idx[e.kind].has(k)) return;
    idx[e.kind].set(k, e);
  };
  ZS.list.filter(e => e.src === 'factory').forEach(put);
  ZS.list.filter(e => e.src !== 'factory').forEach(put);
  return (name, kind) => {
    const e = idx[kind] && idx[kind].get(norm(name));
    if (!e) return null;
    const tone = { name: e.name.slice(0, 16), kind: e.kind, d: e.d };
    if (e.mpj) tone.mpj = e.mpj;
    return { key: hashOf(e.kind, e.d) + (e.mpj ? ':kit' : ''), tone };
  };
}

/* notes an MC-707 clip cannot hold, by clip, from the encoder Save as MC-707 project uses */
function clipLosses(song) {
  const out = [];
  if (!song.scn) return out;
  for (let t = 0; t < 8; t++)
    song.scn.clips[t].forEach((c, k) => {
      const p = c && song.patterns[c.pat];
      if (!p) return;
      const enc = encodePattern(p, p.type);
      if (enc.error) out.push('track ' + (t + 1) + ' clip ' + (k + 1) + ': ' + enc.error);
      else if (enc.skipped) out.push('track ' + (t + 1) + ' clip ' + (k + 1) + ': ' + lostText(enc));
    });
  return out;
}

/**
 * Read a song file and, unless dryRun, put it in the app in place of the song (one Undo step).
 * @param {object} spec
 * @param {{dryRun?: boolean}} o
 * @returns {Promise<{ok: boolean, applied: boolean, name: string, errors: string[], warnings: string[], summary: object|null}>}
 */
export async function loadSongFile(spec, o = {}) {
  if (DEV !== '707')
    return {
      ok: false,
      applied: false,
      name: '',
      errors: ['the Toolbox is set to the MC-101: switch Settings > Device to MC-707 first'],
      warnings: [],
      summary: null
    };
  const r = specToSong(spec, { base: newState(), findSound: await soundFinder() });
  if (!r.song) return { ok: false, applied: false, name: '', errors: r.errors, warnings: r.warnings, summary: null };
  const warnings = [...r.warnings, ...clipLosses(r.song).map(x => 'not on the MC-707: ' + x)];
  if (o.dryRun) return { ok: true, applied: false, name: r.name, errors: [], warnings, summary: r.summary };
  stopAll();
  pushUndo();
  const out = S.midiOut,
    outIn = S.midiIn;
  replaceState(fixState(r.song));
  /* the MIDI ports chosen are this computer's, not the file's */
  S.midiOut = out;
  S.midiIn = outIn;
  UI.sel = null;
  afterReplaceKeepUndo();
  PROJ.name = r.name || PROJ.name;
  PROJ.path = '';
  PROJ.dirty = true;
  return { ok: true, applied: true, name: r.name, errors: [], warnings, summary: r.summary };
}

/** The app's song now as a song file, with warnings for what the format cannot say. */
export function songFileNow() {
  const own = !!(S.scn && S.scn.rows.length),
    made = own ? S.scn : { ...songToRows(), tones: {} };
  const spec = songToSpec(S, made, PROJ.name || 'Toolbox song');
  const warnings = [];
  if (!own)
    warnings.push(
      'Scene Mode has no scenes: these were made from Song Mode, as Save as MC-707 project would make them'
    );
  for (const c of spec.clips)
    if (!SPEC_BARS.includes(c.bars))
      warnings.push(c.id + ': ' + c.bars + ' bars; load_song takes ' + SPEC_BARS.join(', '));
  if (made.over) warnings.push(made.over + ' patterns left out (a track holds 16 clips)');
  return { song: spec, warnings };
}
