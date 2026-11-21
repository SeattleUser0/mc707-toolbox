// The MCP server's tools (docs/MCP-SPEC.md section 5), run in the app's page. The desktop app's main process
// (main-mcp.cjs) speaks MCP to Claude and passes each tools/list and tools/call here over IPC; this answers
// with the app's own code: the song file (ui/song-file.js), the composer (scene/compose.js), Scene Mode's
// playback (scene/screen.js) and Save as MC-707 project (scene/save-mpj.js). The main process writes the
// files and finds the SD card. In the web version (no desktop app) none of this starts.
//
// Revision history
//   0.1.0  2026-11-20  First version (fork, MCP server work).
//
// Reads: S, PROJ, HOST, DEV, MIDI, TR, ZS.
import { toast } from '../core/dom.js';
import { HOST, PROJ, S } from '../core/state.js';
import { DEV } from '../core/device.js';
import { specKey, specName } from '../core/song-spec.js';
import { MIDI } from '../services/midi.js';
import { TR, stopAll } from '../services/transport.js';
import { STYLES } from '../library/styles.js';
import { ZS, soundsLoad } from '../zen/zc-sounds.js';
import { composeNow } from '../scene/compose.js';
import { scenePlay } from '../scene/screen.js';
import { mpjBytes } from '../scene/save-mpj.js';
import { SONG_EXAMPLE, SONG_GUIDE } from './mcp-guide.js';
import { loadSongFile, songFileNow } from './song-file.js';
import { projTitle } from './projects.js';

const RO = { readOnlyHint: true },
  NONE = { type: 'object', properties: {}, additionalProperties: false };
/** The tools as tools/list gives them: name, description, input schema, annotations. */
export const MCP_TOOLS = [
  {
    name: 'status',
    description:
      'What the MC-707 Toolbox has now: the device (must be MC-707), the MIDI out, how many factory sounds are in the Sound library, whether the MC-707 SD card is found, and the song (tempo, scenes, clips, bars).',
    inputSchema: NONE,
    annotations: RO
  },
  {
    name: 'song_format',
    description:
      'The song file format (mc707-song v1) with one complete example. Read this before writing a song for load_song.',
    inputSchema: NONE,
    annotations: RO
  },
  {
    name: 'list_sounds',
    description:
      'Tones and drum kits in the Toolbox Sound library, by name, for the sound fields of a song. Factory sounds appear once imported from the MC-707 update file (Sound browser > Grab from > Factory tones and kits).',
    inputSchema: {
      type: 'object',
      properties: {
        kind: { type: 'string', enum: ['tone', 'kit'], description: 'tone (tone tracks) or kit (drum tracks)' },
        type: {
          type: 'string',
          description:
            'instrument type: keys, organ, bell, guitar, bass, strings, brass, vox, lead, pad, pluck, fx, drums, other'
        },
        search: { type: 'string', description: 'words in the name' },
        limit: { type: 'integer', minimum: 1, maximum: 400, default: 60 }
      },
      additionalProperties: false
    },
    annotations: RO
  },
  {
    name: 'list_styles',
    description: 'The styles the Toolbox composer can write a song in (for compose_song).',
    inputSchema: NONE,
    annotations: RO
  },
  {
    name: 'compose_song',
    description:
      'The Toolbox composer writes a whole song in a style (every part from one chord progression, with sections, fills and builds) and gives each clip a factory sound. Replaces the song in the app (Undo brings it back). get_song then returns it to edit.',
    inputSchema: {
      type: 'object',
      properties: {
        style: { type: 'string', description: 'a style id from list_styles' },
        key: { type: 'string', description: 'key root C ... B (default: the style picks)' },
        bpm: { type: 'number', minimum: 40, maximum: 240 },
        minutes: { type: 'number', minimum: 1, maximum: 10, default: 4 },
        seed: { type: 'integer', description: 'another number gives another take', default: 1 },
        sounds: { type: 'boolean', default: true, description: 'give each clip a factory tone or kit' }
      },
      required: ['style'],
      additionalProperties: false
    }
  },
  {
    name: 'load_song',
    description:
      'Check a song file (format mc707-song, see song_format) and put it in the app in place of the song (one Undo step). With dry_run, only check. Returns errors (nothing changed), warnings and a summary.',
    inputSchema: {
      type: 'object',
      properties: {
        song: { type: 'object', description: 'the song file' },
        dry_run: { type: 'boolean', default: false }
      },
      required: ['song'],
      additionalProperties: false
    }
  },
  {
    name: 'get_song',
    description: 'The song in the app now, as a song file (mc707-song), to read, change and load again.',
    inputSchema: NONE,
    annotations: RO
  },
  {
    name: 'play',
    description: 'Play the scene chain through the MC-707 over USB MIDI, from a scene (1 = the first).',
    inputSchema: {
      type: 'object',
      properties: { scene: { type: 'integer', minimum: 1, default: 1 }, loop: { type: 'boolean', default: false } },
      additionalProperties: false
    }
  },
  { name: 'stop', description: 'Stop playback.', inputSchema: NONE },
  {
    name: 'save_project',
    description:
      'Write the song as an MC-707 project (.mpj): to the SD card (ROLAND/GROOVEBOX/PROJECT) or to the Toolbox Projects folder. Also saves the Toolbox song file there. Never replaces a file unless overwrite is true. Returns the paths, anything left out, and the steps on the MC-707.',
    inputSchema: {
      type: 'object',
      properties: {
        name: { type: 'string', description: 'project name, 16 characters (default: the song name)' },
        to: { type: 'string', enum: ['card', 'folder'], default: 'card' },
        overwrite: { type: 'boolean', default: false }
      },
      additionalProperties: false
    }
  }
];

/* ---- the tools ---- */
const songNow = () => ({
  name: PROJ.name || '',
  bpm: S.bpm,
  scenes: S.scn ? S.scn.rows.length : 0,
  clips: S.scn ? S.scn.clips.flat().filter(Boolean).length : 0,
  bars: S.scn ? S.scn.rows.reduce((a, r) => a + r.bars, 0) : 0
});
async function status() {
  await soundsLoad();
  const n = (src, kind) => ZS.list.filter(e => (src ? e.src === src : e.src !== 'factory') && e.kind === kind).length;
  const card = HOST && HOST.mcpCard ? await HOST.mcpCard() : null;
  return {
    device: DEV === '707' ? 'MC-707' : 'MC-101 (switch Settings > Device to MC-707 to make MC-707 projects)',
    midi_out: MIDI.out ? MIDI.out.name : null,
    playing: !!TR.playing,
    sounds: {
      factory_tones: n('factory', 'tone'),
      factory_kits: ZS.list.filter(e => e.src === 'factory' && e.kind === 'kit' && e.mpj).length,
      other_tones: n(null, 'tone'),
      other_kits: n(null, 'kit'),
      note:
        n('factory', 'tone') === 0
          ? 'No factory sounds yet: in the Toolbox, Sound browser > Grab from > Factory tones and kits, with the MC-707 update file (MC707_UPA_up.bin).'
          : undefined
    },
    card,
    song: songNow()
  };
}
async function listSounds(a) {
  await soundsLoad();
  const words = String(a.search || '')
    .toLowerCase()
    .split(/\s+/)
    .filter(Boolean);
  const list = ZS.list
    .filter(e => (!a.kind || e.kind === a.kind) && (!a.type || e.type === a.type))
    .filter(e => e.kind !== 'kit' || e.mpj || e.src !== 'factory')
    .filter(e => words.every(w => e.name.toLowerCase().includes(w)))
    .sort((x, y) => (y.src === 'factory') - (x.src === 'factory') || x.name.localeCompare(y.name));
  const lim = Math.max(1, Math.min(400, +a.limit || 60));
  return {
    total: list.length,
    sounds: list.slice(0, lim).map(e => ({
      name: e.name,
      kind: e.kind,
      type: e.type,
      from: e.src === 'factory' ? 'factory' + (e.bank ? ' ' + e.bank + (e.no ? '-' + e.no : '') : '') : e.src,
      ...(e.kind === 'kit' && !e.mpj ? { note: 'not a factory kit: stays out of a project file' } : {})
    }))
  };
}
const listStyles = () => ({
  styles: STYLES.map(s => ({
    id: s.id,
    name: s.name,
    family: s.fam,
    bpm: s.bpm ? { low: s.bpm[0], high: s.bpm[1], usual: s.bpm[2] } : null,
    keys: (s.keys || []).map(k => k[1]),
    vibe: s.vibe
  }))
});
function compose(a) {
  if (DEV !== '707') throw new Error('switch Settings > Device to MC-707 first');
  const st = STYLES.find(s => s.id === a.style);
  if (!st) throw new Error('no style ' + JSON.stringify(a.style) + '; list_styles gives them');
  const key = a.key == null ? (st.keys && st.keys[0] ? st.keys[0][0] : 0) : specKey(a.key);
  if (key == null) throw new Error('key: C, C#, Db ... B');
  const r = composeNow(st.id, {
    key,
    bpm: a.bpm || (st.bpm ? st.bpm[2] : 120),
    minutes: a.minutes || 4,
    seed: a.seed || 1,
    sounds: a.sounds !== false
  });
  PROJ.name = PROJ.name || specName(st.name);
  PROJ.dirty = true;
  projTitle();
  return { ...r, song: songNow() };
}
function play(a) {
  if (!S.scn || !S.scn.rows.length) throw new Error('the song has no scenes yet');
  const i = Math.max(1, Math.min(S.scn.rows.length, +a.scene || 1));
  scenePlay(i - 1, !!a.loop);
  return {
    playing: true,
    from_scene: i,
    loop: !!a.loop,
    midi_out: MIDI.out ? MIDI.out.name : null,
    note: MIDI.out ? undefined : 'No MIDI out chosen: only the app’s preview sound plays. Connect the MC-707 over USB.'
  };
}
async function saveProject(a) {
  if (!HOST || !HOST.mcpSave) throw new Error('saving needs the desktop app');
  const name = specName(a.name || PROJ.name || 'Toolbox song') || 'Toolbox song';
  const made = await mpjBytes(name);
  if (made.error) throw new Error(made.error);
  const r = await HOST.mcpSave({
    name,
    bytes: made.bytes,
    to: a.to === 'folder' ? 'folder' : 'card',
    overwrite: !!a.overwrite,
    songText: JSON.stringify(S, null, 1)
  });
  if (r.error) return { saved: false, error: r.error, card: r.card };
  PROJ.name = name;
  PROJ.path = r.song || PROJ.path;
  PROJ.dirty = !r.song;
  projTitle();
  toast('Saved ' + name + '.mpj' + (r.to === 'card' ? ' on the MC-707 card' : ''));
  return {
    saved: true,
    mpj: r.mpj,
    song_file: r.song,
    ...(r.songKept ? { note: r.songKept + ' is already there and was kept (overwrite true replaces it)' } : {}),
    clips: made.song.clips.length,
    scenes: made.song.scenes.length,
    left_out: made.song.lost,
    on_the_mc707:
      r.to === 'card'
        ? [
            'Eject the card (or leave storage mode).',
            'PROJECT > LOAD, pick ' + name + ', ENTER.',
            'Press PLAY: the scene chain is on.'
          ]
        : [
            'Copy ' + name + '.mpj to the card, into ROLAND/GROOVEBOX/PROJECT.',
            'PROJECT > LOAD, pick ' + name + ', ENTER.',
            'Press PLAY: the scene chain is on.'
          ]
  };
}

const RUN = {
  status,
  song_format: () => ({ guide: SONG_GUIDE, example: SONG_EXAMPLE }),
  list_sounds: listSounds,
  list_styles: listStyles,
  compose_song: compose,
  load_song: async a => {
    const r = await loadSongFile(typeof a.song === 'string' ? JSON.parse(a.song) : a.song, { dryRun: !!a.dry_run });
    if (r.applied) projTitle();
    return r;
  },
  get_song: songFileNow,
  play,
  stop: () => (stopAll(), { playing: false }),
  save_project: saveProject
};

/**
 * One MCP request from the main process: tools/list or tools/call. Returns the MCP result. A tool that
 * fails gives isError with the reason, as MCP asks (not a protocol error).
 */
export async function mcpHandle(method, params) {
  if (method === 'tools/list') return { tools: MCP_TOOLS };
  if (method !== 'tools/call') throw new Error('unknown method ' + method);
  const name = params && params.name,
    run = RUN[name];
  if (!run) return { content: [{ type: 'text', text: 'No tool named ' + name }], isError: true };
  try {
    const out = await run((params && params.arguments) || {});
    const bad = out && (out.ok === false || out.saved === false);
    return { content: [{ type: 'text', text: JSON.stringify(out, null, 1) }], ...(bad ? { isError: true } : {}) };
  } catch (e) {
    return { content: [{ type: 'text', text: String((e && e.message) || e) }], isError: true };
  }
}

/** Start answering the main process (desktop app only). */
export function initMcp() {
  if (!HOST || !HOST.mcpOnCall) return;
  HOST.mcpOnCall(async (id, method, params) => {
    let reply;
    try {
      reply = { result: await mcpHandle(method, params) };
    } catch (e) {
      reply = { error: String((e && e.message) || e) };
    }
    HOST.mcpReply(id, reply);
  });
  HOST.mcpReady();
}
