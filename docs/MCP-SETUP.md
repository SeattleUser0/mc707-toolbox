# Setting up the MCP server (fork)

The MCP server lets Claude write a song in the Toolbox and save it to the MC-707's SD card. It runs
inside the desktop app, so the Toolbox has to be this fork's build, not the one from Mendo's releases.
How it works: `docs/MCP-SPEC.md`.

## 1. Run this fork's app

The easy way: double-click `mcp/Build Toolbox App.command` (copy it anywhere first; it works in the folder
it sits in). It downloads this branch, builds the Mac app, puts it in Applications in place of the old one
(the old one is kept in `toolbox-build/backup`, outside Applications, because both builds use the same app
id, `local.mc707.toolbox`), opens it once, checks that the MCP server answers, and adds the Claude Desktop
entry of section 2 to `claude_desktop_config.json` (a backup of that file is kept). Then quit and reopen
Claude Desktop. Run it again any time to update. Needs Node 18 or later and git.

By hand:

```
npm install
npx electron-builder --mac --arm64 --publish never
```

then replace the Toolbox in Applications with `dist/MC-707-Toolbox-mac-arm64.dmg` (keep only one copy in
Applications), or run it from the repo folder with `npm install` then `npm start`.
(`index.html` in the repo is already built. After changing anything in `src/`, run `npm run tools` once
and `npm run build` before building the app.)

Open it once. It makes `~/Library/Application Support/MC-707 Toolbox/mcp.json` with a port (8717) and a
token. The server is on from then on, while the app is open.

## 2. Claude Desktop

Add this to `~/Library/Application Support/Claude/claude_desktop_config.json`, inside `mcpServers`, then
quit and reopen Claude Desktop.

Using the installed app (no Node needed):

```json
{
  "mcpServers": {
    "mc707-toolbox": {
      "command": "/Applications/MC707-101 Toolbox.app/Contents/MacOS/MC707-101 Toolbox",
      "args": ["/Applications/MC707-101 Toolbox.app/Contents/Resources/app.asar/mcp/toolbox-mcp-bridge.cjs"],
      "env": { "ELECTRON_RUN_AS_NODE": "1" }
    }
  }
}
```

Running from the repo folder instead (any Node 18 or later; give its full path, Claude Desktop does not
see your shell's PATH):

```json
{
  "mcpServers": {
    "mc707-toolbox": {
      "command": "/full/path/to/node",
      "args": ["/full/path/to/mc707-toolbox/mcp/toolbox-mcp-bridge.cjs"]
    }
  }
}
```

If the Toolbox is closed when Claude calls a tool, the bridge opens it and waits up to 30 seconds.

## 3. Claude Code

```
claude mcp add --transport http mc707-toolbox http://127.0.0.1:8717/mcp \
  --header "Authorization: Bearer <token from mcp.json>"
```

## 4. ChatGPT

ChatGPT cannot reach a server on your Mac. Give it `docs/MCP-SONG-FORMAT.md`, ask for a song, save the
JSON it writes as a `.json` file and open it in the Toolbox with File > Open. Then File > Save as MC-707
project, or ask Claude to save it to the card.

## 5. Before the first song

- Settings > Device: MC-707.
- Sound browser > Grab from > Factory tones and kits, with `MC707_UPA_up.bin` (the MC-707 system update
  file). Without it a song still loads and saves, but every clip keeps the project template's sound.
- To hear it before saving: connect the MC-707 over USB and pick it as MIDI out.

## 6. Then

Ask, for example: "Write me a 3-minute deep house song for the MC-707 in A minor, play it, then save it
to the SD card." Claude reads `song_format` and `list_sounds`, writes the song with `load_song`, plays it
with `play`, and saves it with `save_project`.

For the card: put the SD card in the Mac, or on the MC-707 hold SHIFT, press KNOB ASSIGN, pick STORAGE
MODE and connect USB. The server writes only to a removable drive with a ROLAND folder that is not the
drive the Toolbox or its Projects folder is on, and only when there is exactly one. If two drives qualify,
name one in `mcp.json`: `"card": "/Volumes/MC-707"`. It never replaces a project already on the card
unless asked to.

On the MC-707: eject the card (or leave storage mode), PROJECT > LOAD, pick the song, PLAY.

## `mcp.json`

```json
{ "enabled": true, "port": 8717, "token": "...", "card": "/Volumes/MC-707" }
```

- `enabled: false` turns the server off at the next start.
- `port`: change it if 8717 is taken (then restart the app; the bridge reads the new port by itself).
- `token`: delete the line and restart the app for a new one (Claude Code then needs the new one too).
- `card`: optional, only when more than one drive could be the card.
