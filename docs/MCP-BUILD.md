# MCP server: build document

Tracks what is done, left to build and left to test. Update with every change. The contract is
`docs/MCP-SPEC.md`.

## Version history

| Version | Date | Change |
|---|---|---|
| 0.1.0 | 2026-11-20 | First version. Song file format `mc707-song` v1 (`src/core/song-spec.js`), its use in the app (`src/ui/song-file.js`) and in File > Open, the ten tools (`src/ui/mcp-tools.js`, `src/ui/mcp-guide.js`), the server in the main process (`main-mcp.cjs`: Streamable HTTP on 127.0.0.1, token, Origin check, SD card, project writes), preload calls, the stdio bridge (`mcp/toolbox-mcp-bridge.cjs`), the ChatGPT page (`docs/MCP-SONG-FORMAT.md`, generated). No change to how the app works without it |

## Files

| File | What |
|---|---|
| `src/core/song-spec.js` | Song file to Toolbox song and back. Plain functions, tested in Node |
| `src/ui/song-file.js` | Sounds by name from the Sound library, notes the MC-707 cannot hold, putting the song in the app (one Undo step) |
| `src/ui/mcp-tools.js` | The tools: list, schemas, what each does |
| `src/ui/mcp-guide.js` | The `song_format` text and the example |
| `src/ui/projects.js` | File > Open takes a song file too |
| `src/main.js` | `initMcp()` once the page is drawn; `window.__app.mcp` for the tests |
| `main-mcp.cjs` | The server, the SD card, the writes (main process) |
| `main.js`, `preload.js`, `package.json` | Start the server; IPC calls; the two new files in the app build; `npm run test:mcp` |
| `mcp/toolbox-mcp-bridge.cjs` | stdio to HTTP, for Claude Desktop; opens the app if closed (macOS) |
| `scripts/mcp-song-format.mjs` | Writes `docs/MCP-SONG-FORMAT.md` |
| `tests/song-spec.test.mjs` | Format: notes, lanes, errors, warnings, limits, round trip, the example, the ChatGPT page current (Node) |
| `tests/mcp-server.test.mjs` | Protocol, token, Origin, sizes, the bridge both ways, card rules, writes (Node) |
| `tests/mcp-tools.test.mjs` | The tools in the page: list, load, errors, get, compose, play over MIDI, File > Open (Playwright) |

## Done

- [x] Song file format v1 with errors by place and warnings
- [x] Sounds by name: factory first, kits only with their bytes
- [x] Scene Mode clips, scenes and tones; the same song in Song Mode with markers
- [x] get_song gives back a file that loads again (round trip tested)
- [x] Composer through compose_song
- [x] play and stop through Scene Mode's playback
- [x] save_project through Save as MC-707 project's own code; card or Projects folder; the song file too
- [x] Never replaces a file unless overwrite
- [x] SD card rules from mc707-svz (ROLAND folder, not the app's or Projects drive, removable, exactly one or named)
- [x] Server: 127.0.0.1 only, token, Origin check, 4 MB limit, JSON responses, batches, notifications
- [x] A new window must report ready before calls go to it
- [x] stdio bridge with app launch and clear errors (closed app, refused token)
- [x] File > Open on a song file (ChatGPT route)
- [x] ChatGPT page generated from the same text the tool gives

## Tested (software)

- [x] Node: 19 tests pass (`npm run test:mcp`)
- [x] Playwright: 6 tests pass (`tests/mcp-tools.test.mjs`) on the built `index.html`
- [x] Existing Save as MC-707 project tests still pass (`tests/mpj-write.test.mjs`)
- [x] End to end in the real Electron app (Linux, Xvfb, 2026-11-20): bridge > server > page; initialize, tools/list,
      status, song_format, load_song (the example), save_project to the Projects folder, the second save refused,
      to the card refused with no card, to a named card on another drive written to `ROLAND/GROOVEBOX/PROJECT/`,
      a named card on the app's own drive refused. The written `.mpj` read back with the Toolbox's reader: name,
      tempo 122, chain on, clips on tracks 1, 4, 5 and 7, scenes 8, 15, 1, 16 bars and OFF
- [x] `npm run check` and Prettier

## Left to test

- [ ] On the Mac: the fork's app starts the server; Claude Desktop sees the ten tools through the bridge
- [ ] The bridge run with the app's own binary (`ELECTRON_RUN_AS_NODE=1`, script inside `app.asar`)
- [ ] The bridge opening the app when it is closed (`open -b local.mc707.toolbox`)
- [ ] Card detection on the Mac with the real card (storage mode and in a reader)
- [ ] A song from load_song, saved to the card, loaded on the MC-707 (PROJECT > LOAD): plays the scene chain with
      the right clips, lengths and factory sounds
- [ ] play through the MC-707 over USB from Claude
- [ ] A ChatGPT-written file through File > Open

## Left to build (not started)

- [ ] Motion, pump and CC automation in the song file (the Toolbox's project file does not carry motion yet)
- [ ] Tone settings in the song file (cutoff, envelope) instead of only a sound by name
- [ ] Writing the song to the MC-707 over USB from a tool (Scene Mode's Write)
- [ ] A menu switch for the server (today: `enabled` in `mcp.json`)
- [ ] Windows and Linux card detection (today: only a card named in `mcp.json`)
