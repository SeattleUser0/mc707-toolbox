# MCP server: specification

Version 0.1.0 (2026-11-20). Fork only (SeattleUser0/mc707-toolbox), not upstream.
Status of the work: `docs/MCP-BUILD.md`.

## 1. What it is for

You tell an AI (Claude, or ChatGPT through a song file) to write a whole song for the MC-707. The AI
writes the song into the Toolbox, you can play it through the MC-707 over USB and change it in the app,
and the Toolbox saves it as an MC-707 project (`.mpj`) on the SD card, ready for PROJECT > LOAD.

The Toolbox does all the MC-707 work with its own code: Scene Mode holds the song, `scene/save-mpj.js`
writes the project, factory tones and kits come from the Sound library. The MCP server only gives an
AI a way to drive those parts.

## 2. How the pieces fit

```
Claude Desktop / Claude Code / any MCP client
   |  stdio (Claude Desktop)            |  HTTP (Claude Code, other clients)
   v                                    |
mcp/toolbox-mcp-bridge.cjs  --HTTP-->   +--> Electron main process (main-mcp.cjs)
                                              127.0.0.1:8717/mcp, token, Origin check
                                              SD card detection, file writes
                                                  |  IPC (mcp-call / mcp-reply)
                                                  v
                                           Renderer: src/ui/mcp-tools.js
                                              the tools, using the app's own modules
                                              (song state S, Scene Mode, composer,
                                               Sound library, transport, save-mpj)
```

- The server runs only while the Toolbox app (Electron) is open. The web version has no server.
- The tool list and every tool live in the renderer (`src/ui/mcp-tools.js`), so they use the same code
  as the menus. The main process only speaks the protocol, checks the caller and writes files.
- ChatGPT cannot reach a server on the Mac (it only connects to public HTTPS servers). It writes the
  same song file (section 4) and you open it with File > Open. No tunnel.

## 3. Protocol and security

- MCP over Streamable HTTP, JSON responses only (no event stream): `POST /mcp` with one JSON-RPC
  message or a batch. `GET /mcp` and `DELETE /mcp` answer 405. Notifications answer 202.
- Methods: `initialize`, `notifications/initialized`, `ping`, `tools/list`, `tools/call`.
  Anything else: JSON-RPC error -32601.
- Protocol versions accepted: 2025-06-18, 2025-03-26, 2024-11-05. The server answers with the
  client's version when it is one of these, otherwise 2025-06-18.
- Bound to 127.0.0.1 only. Never to another address.
- Every request needs `Authorization: Bearer <token>`. The token is made on first start (32 random
  bytes, hex) and kept in `mcp.json` in the app's data folder
  (macOS: `~/Library/Application Support/MC-707 Toolbox/mcp.json`). Wrong or missing token: 401.
- A request with an `Origin` header that is not `http://127.0.0.1:<port>` or `http://localhost:<port>`
  is refused (403). This stops a web page from calling the server.
- Request bodies over 4 MB: 413.
- `mcp.json`: `{ "enabled": true, "port": 8717, "token": "..." }`. `enabled: false` turns the server
  off at the next start. The port can be changed there.
- A tool call waits up to 120 seconds for the renderer. If the app's window is not ready yet, the call
  waits for it (up to the same limit).

### The stdio bridge (Claude Desktop)

`mcp/toolbox-mcp-bridge.cjs`: plain Node, no packages. Reads one JSON-RPC message per line on stdin,
posts it to the server with the token from `mcp.json`, writes the answer as one line on stdout.
If the server does not answer (the app is closed), on macOS it opens the app
(`open -b local.mc707.toolbox`) and retries for up to 30 seconds, then returns an error that says
to open the Toolbox. It can run with the app's own Electron binary (`ELECTRON_RUN_AS_NODE=1`), so Node
need not be installed. Setup is in `docs/MCP-SETUP.md`.

## 4. The song file: `mc707-song` version 1

One JSON object. Claude sends it to `load_song`; ChatGPT writes it as a `.json` file; File > Open in the
Toolbox reads it. The Toolbox turns it into its own song (Scene Mode clips and scenes, the same song
laid out in Song Mode with a marker per scene).

```json
{
  "format": "mc707-song",
  "v": 1,
  "name": "NIGHT BUS",
  "bpm": 124,
  "swing": 54,
  "key": "F",
  "scale": "minor",
  "tracks": [
    { "track": 1, "role": "kit", "name": "Drums", "sound": "TR-909 Kit 1" },
    { "track": 4, "role": "bass", "name": "Bass", "sound": "Saw Bass 1" }
  ],
  "clips": [
    { "id": "beat", "track": 1, "bars": 1,
      "notes": [[0,1,"kick",120],[4,1,"kick",120],[8,1,"kick",120],[12,1,"kick",120],
                [4,1,"clap",100],[12,1,"clap",100],[2,1,"hat",80],[6,1,"hat",80]] },
    { "id": "bass_a", "track": 4, "bars": 2, "notes": [[0,2,"F1",110],[3,1,"F2",90]] }
  ],
  "scenes": [
    { "name": "Intro", "bars": 8, "play": ["beat"] },
    { "name": "Drop", "bars": 16, "play": ["beat", "bass_a"] }
  ]
}
```

### Top level

| Field | Required | Meaning | Rule |
|---|---|---|---|
| `format` | yes | `"mc707-song"` | exactly this |
| `v` | yes | `1` | exactly this |
| `name` | no | project name | up to 16 characters; letters, digits, space, `-`, `_` (others become `-`) |
| `bpm` | yes | tempo | 40 to 240 |
| `swing` | no | 50 straight to 75 | default 50. Kept in the Toolbox song; the .mpj does not carry swing (UNVERIFIED either way) |
| `key` | no | key root | `C` `C#` `Db` ... `B`; default `C` |
| `scale` | no | scale | `minor`, `major`, `dorian`, `phrygian`, `mixolydian`, `lydian`, `harmonic minor`, `minor pent`, `major pent`, `blues`, `chromatic`; default `minor` |
| `tracks` | no | track setup | see below; tracks not listed keep their default role |
| `clips` | yes | the MC-707 clips | at least one |
| `scenes` | yes | the scene chain, in play order | 1 to 128 |

### Tracks

| Field | Meaning | Rule |
|---|---|---|
| `track` | MC-707 track | 1 to 8, each at most once |
| `role` | what the track is for | `kit`, `hats`, `perc` (drum tracks) or `bass`, `chords`, `pad`, `lead`, `pluck`, `acid` (tone tracks). Default for tracks 1 to 8: kit, hats, perc, bass, chords, pad, lead, pluck |
| `name` | track name | up to 16 characters |
| `sound` | sound for every clip on this track | a tone name (tone tracks) or a factory kit name (drum tracks), as `list_sounds` gives them |

The role sets the track type: kit, hats and perc make a drum track, the rest a tone track.

### Clips

| Field | Meaning | Rule |
|---|---|---|
| `id` | name used by scenes | letters, digits, `_`, `-`; unique |
| `track` | MC-707 track | 1 to 8 |
| `bars` | clip length | 1, 2, 4, 8 or 16 |
| `name` | clip name | optional, up to 16 characters |
| `sound` | sound for this clip | optional; overrides the track's `sound` |
| `transpose` | semitones | tone tracks only, -48 to 48 |
| `notes` | the notes | list, may be empty |

A track holds 16 clips. They are numbered 1 to 16 on the MC-707 in the order they are listed.

A note is `[start, length, note, velocity]` or `{"s":..., "l":..., "n":..., "v":...}`:

- `start`: in 16th steps from the clip's start, 0 up to (bars x 16), fractions allowed (triplets:
  steps of 2/3 or 4/3).
- `length`: in 16th steps, above 0. Default 1.
- `note`, tone tracks: a name such as `C4`, `F#2`, `Bb1` (C4 = MIDI 60, middle C), or a MIDI number 0 to 127.
- `note`, drum tracks: a lane name: `kick`, `rim`, `snare`, `clap`, `hat` (closed), `ohat` (open),
  `ltom`, `mtom`, `htom`, `crash`, `ride`, `perc`; or a lane number 0 to 11; or the General MIDI
  note of a lane (36 kick, 37 rim, 38 snare, 39 clap, 42 hat, 46 open hat, 41, 45, 48 toms, 49 crash,
  51 ride, 56 perc).
- `velocity`: 1 to 127. Default 100.

### Scenes

| Field | Meaning | Rule |
|---|---|---|
| `name` | scene name | up to 16 characters |
| `bars` | how long the scene plays before the chain moves on | 1 to 127. A clip shorter than the scene loops |
| `play` | the clips this scene plays | clip ids, at most one per track. Tracks not named are silent |

The last scene's length is written as OFF, so the MC-707's chain stops there (the Toolbox's rule).

### Errors and warnings

- An error rejects the whole file and nothing changes. Each error names its place, e.g.
  `clips[3].notes[12]: start 33 is past the end of a 2-bar clip (32 steps)`.
- A warning is applied and reported: a name cut to 16 characters, a sound not in the library (the
  clip keeps the template's sound), a kit that is not a factory kit, notes the MC-707 clip cannot hold
  (from the same check Save as MC-707 project uses).

### Sounds

Sounds are found by name, case and spaces ignored, in this order: factory tones or kits imported from
the MC-707's update file (Sound browser > Grab from > Factory tones and kits), then the rest of the
Sound library. A drum clip needs a factory kit (only those go into a project file). A tone clip takes
any tone in the library.

## 5. The tools

All tools return text content with a JSON object as the text. Read-only tools carry the
`readOnlyHint` annotation.

| Tool | Read only | Input | Does |
|---|---|---|---|
| `status` | yes | none | Device (must be MC-707), MIDI out, factory sounds in the library, the SD card found or not, the song now (scenes, clips, bars, tempo) |
| `song_format` | yes | none | The format in section 4 as text, the drum lanes, roles, scales, limits, and one complete example. An AI reads this before writing a song |
| `list_sounds` | yes | `kind` (tone, kit), `type` (bass, pad, lead, keys, ...), `search`, `limit` (default 60, at most 400) | Names in the Sound library with kind, type and where they came from |
| `list_styles` | yes | none | The composer's styles: id, name, family, tempo range, keys, a line on the vibe |
| `compose_song` | no | `style`, `key` (C...B), `bpm`, `minutes`, `seed`, `sounds` (default true) | The Toolbox's own composer writes a song (Song wizard > Compose it now). Replaces the song (Undo brings it back) |
| `load_song` | no | `song` (section 4), `dry_run` | Checks the song; unless `dry_run`, replaces the app's song with it (one Undo step). Returns errors, warnings and a summary |
| `get_song` | yes | none | The app's song now, in the format of section 4, so an AI can change it and load it again |
| `play` | no | `scene` (1-based, default 1), `loop` | Plays the scene chain from that scene through the MC-707 over MIDI |
| `stop` | no | none | Stops playback |
| `save_project` | no | `name`, `to` (`card` default, or `folder`), `overwrite` (default false) | Writes the song as an MC-707 project. `card`: `ROLAND/GROOVEBOX/PROJECT/<name>.mpj` on the SD card. `folder`: the Toolbox's Projects folder. Also saves the Toolbox song file (`<name>.json`) in the Projects folder. Returns paths, what was left out, and the steps on the MC-707 |

## 6. The SD card

Same rules as the mc707-svz launchers (`hardware/card.mjs` there, MIT, same author):

1. A drive is the MC-707's card only if it has a `ROLAND` folder at its top, it is not the drive the
   app runs from or the drive the Projects folder is on, and macOS calls it removable media or an SD
   card (`diskutil info`: RemovableMedia, or BusProtocol Secure Digital). A USB SSD is not a card.
2. Exactly one such drive: that is the card. None: `save_project` with `to: card` fails and says to
   put the card in (or use the MC-707's storage mode), and nothing is written. More than one: fails, and
   names them; the person picks one with `"card": "/Volumes/NAME"` in `mcp.json`. A named drive must
   still pass the ROLAND and not-the-app's-drive tests.
3. The project goes into `ROLAND/GROOVEBOX/PROJECT/` (made if missing). An existing file of that name is
   never replaced unless `overwrite` is true.
4. Not on macOS: no card is found automatically; only a card named in `mcp.json` is used.

## 7. What the Toolbox does not do yet (and so the server does not)

From `scene/save-mpj.js`: motion (pump, knob recording) is not in a project file; only factory kits go
into a project (other kits keep the template's). Swing and per-clip CC automation are not in a project
file. These are the Toolbox's limits, not new ones.

## 8. Rules the code follows

- The repo's own rules (`AGENTS.md`): never edit the built `index.html` by hand, imports only point
  down, small modules with headers, `pushUndo()` before changing the song, `replaceState()` to replace it.
- `src/core/song-spec.js` holds the format conversion as plain functions (no page, no app state), so
  it can be tested in Node without a browser.
- Nothing is written to the SD card except by `save_project`, and only as section 6 says.
- Every new file has a header with a revision history.
