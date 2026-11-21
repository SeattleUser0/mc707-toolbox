// What the MCP server's song_format tool gives an AI before it writes a song: the song file format
// (docs/MCP-SPEC.md section 4, in short), how the MC-707 plays a song, and one complete example. Text and
// data only. docs/MCP-SONG-FORMAT.md is the same text for a person to give ChatGPT.
//
// Revision history
//   0.1.0  2026-11-20  First version (fork, MCP server work).
//
// Reads: nothing.
import { LANE_NAMES, SPEC_BARS } from '../core/song-spec.js';
import { SCALES } from '../core/theory.js';

export const SONG_GUIDE = `MC-707 song file ("mc707-song", version 1)

How the MC-707 plays a song
- 8 tracks. Each track holds 16 clips; one clip plays on a track at a time.
- A scene picks one clip (or none) for each track and lasts so many bars. The scene chain plays the
  scenes in order and stops after the last one. Clips shorter than the scene loop.
- So: write each part's variations as separate clips (verse bass, chorus bass, fill beat), then the
  arrangement as scenes that switch between them. Silence on a track = leave it out of the scene.
- Drum tracks play a kit: notes are drum lanes. Tone tracks play one tone: notes are pitches.

Top level: format "mc707-song", v 1, name (16 chars), bpm 40-240, swing 50-75 (optional),
key C..B (optional), scale (optional), tracks (optional), clips, scenes.

tracks: [{track 1-8, role, name?, sound?}]
  roles: kit, hats, perc (drum tracks); bass, chords, pad, lead, pluck, acid (tone tracks).
  Default roles of tracks 1-8: kit, hats, perc, bass, chords, pad, lead, pluck.
  sound: a tone name (tone track) or factory kit name (drum track) from list_sounds; every clip on the
  track gets it unless the clip names its own.

clips: [{id, track 1-8, bars, name?, sound?, transpose?, notes}]
  bars: ${SPEC_BARS.join(', ')}. A track's clips are numbered 1-16 in the order listed.
  note: [start, length, note, velocity]
    start and length in 16th steps (a bar is 16), start from 0 to bars*16, fractions allowed (triplets 2/3).
    tone tracks: note name (C4 = MIDI 60, F#2, Bb1) or MIDI number.
    drum tracks: lane ${LANE_NAMES.map(n => n[0]).join(', ')} (or 0-11).
    velocity 1-127, default 100. Length default 1.

scenes: [{name, bars 1-127, play: [clip ids, at most one per track]}], 1 to 128 scenes, in play order.

scales: ${Object.keys(SCALES).join(', ')}.

Tips
- Sounds: use names from the Toolbox Sound library (the MCP tool list_sounds lists them). Without that
  list, leave sound out: the clip keeps the project's default sound, and it can be changed on the MC-707.
- Keep the bass in octaves 1-2, chords and pads 3-4, leads 4-5.
- With the MCP server: load_song with dry_run true checks a song without changing anything;
  compose_song writes one with the Toolbox's own composer and get_song returns it in this format to
  edit; save_project writes the .mpj to the SD card (ROLAND/GROOVEBOX/PROJECT).`;

/** One complete, valid song: 4 tracks, 6 clips, 5 scenes. */
export const SONG_EXAMPLE = {
  format: 'mc707-song',
  v: 1,
  name: 'EXAMPLE',
  bpm: 122,
  swing: 54,
  key: 'A',
  scale: 'minor',
  tracks: [
    { track: 1, role: 'kit', name: 'Drums' },
    { track: 4, role: 'bass', name: 'Bass' },
    { track: 5, role: 'chords', name: 'Chords' },
    { track: 7, role: 'lead', name: 'Lead' }
  ],
  clips: [
    {
      id: 'beat',
      track: 1,
      bars: 1,
      notes: [
        [0, 1, 'kick', 120],
        [4, 1, 'kick', 115],
        [8, 1, 'kick', 120],
        [12, 1, 'kick', 115],
        [4, 1, 'clap', 100],
        [12, 1, 'clap', 100],
        [2, 1, 'hat', 70],
        [6, 1, 'hat', 80],
        [10, 1, 'hat', 70],
        [14, 1, 'ohat', 85]
      ]
    },
    {
      id: 'beat_fill',
      track: 1,
      bars: 1,
      notes: [
        [0, 1, 'kick', 120],
        [4, 1, 'clap', 100],
        [8, 1, 'kick', 120],
        [12, 1, 'snare', 90],
        [13, 1, 'snare', 95],
        [14, 1, 'snare', 105],
        [15, 1, 'snare', 115]
      ]
    },
    {
      id: 'kick_only',
      track: 1,
      bars: 1,
      notes: [
        [0, 1, 'kick', 110],
        [4, 1, 'kick', 105],
        [8, 1, 'kick', 110],
        [12, 1, 'kick', 105]
      ]
    },
    {
      id: 'bass',
      track: 4,
      bars: 2,
      notes: [
        [0, 2, 'A1', 110],
        [3, 1, 'A2', 90],
        [6, 2, 'A1', 105],
        [10, 2, 'C2', 100],
        [16, 2, 'F1', 110],
        [19, 1, 'F2', 90],
        [22, 2, 'G1', 105],
        [26, 2, 'G2', 95]
      ]
    },
    {
      id: 'chords',
      track: 5,
      bars: 2,
      notes: [
        [0, 14, 'A3', 85],
        [0, 14, 'C4', 85],
        [0, 14, 'E4', 85],
        [16, 6, 'F3', 85],
        [16, 6, 'A3', 85],
        [16, 6, 'C4', 85],
        [24, 6, 'G3', 85],
        [24, 6, 'B3', 85],
        [24, 6, 'D4', 85]
      ]
    },
    {
      id: 'hook',
      track: 7,
      bars: 2,
      notes: [
        [0, 2, 'E5', 100],
        [3, 1, 'D5', 90],
        [4, 2, 'C5', 95],
        [8, 4, 'A4', 100],
        [16, 2, 'C5', 100],
        [19, 1, 'B4', 90],
        [20, 2, 'G4', 95],
        [24, 6, 'A4', 100]
      ]
    }
  ],
  scenes: [
    { name: 'Intro', bars: 8, play: ['kick_only', 'chords'] },
    { name: 'Groove', bars: 15, play: ['beat', 'bass', 'chords'] },
    { name: 'Fill', bars: 1, play: ['beat_fill', 'bass', 'chords'] },
    { name: 'Hook', bars: 16, play: ['beat', 'bass', 'chords', 'hook'] },
    { name: 'Outro', bars: 8, play: ['kick_only', 'chords'] }
  ]
};
