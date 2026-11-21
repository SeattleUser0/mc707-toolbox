#!/bin/bash
# Build Toolbox App.command
# Double-click on the Mac. Builds the MC-707 Toolbox from the fork (SeattleUser0/mc707-toolbox, branch
# mcp-server), puts it in Applications in place of the one there (the old one is kept as a backup, outside
# Applications), opens it once so it makes its MCP settings, adds the "mc707-toolbox" server to Claude
# Desktop's config (a backup of the config is kept), and checks that the server answers.
#
# Needs: Node 18 or later (nvm, Homebrew or nodejs.org) and git (Xcode or its command line tools).
# Everything it downloads and builds goes in "toolbox-build" next to this file.
# Run it again any time to update to the newest commit on the branch.
#
# Revision history
#   0.1.0  2026-11-21  First version.

set -u
REPO="https://github.com/SeattleUser0/mc707-toolbox"
BRANCH="mcp-server"
APP_NAME="MC707-101 Toolbox"
APP="/Applications/$APP_NAME.app"
HERE="$(cd "$(dirname "$0")" && pwd)"
WORK="$HERE/toolbox-build"
SRC="$WORK/mc707-toolbox"
STAMP="$(date +%Y%m%d-%H%M%S)"
LOG="$WORK/build-$STAMP.log"
SETTINGS="$HOME/Library/Application Support/MC-707 Toolbox/mcp.json"
CLAUDE_CFG="$HOME/Library/Application Support/Claude/claude_desktop_config.json"

mkdir -p "$WORK"
exec > >(tee -a "$LOG") 2>&1

say() { printf '\n== %s\n' "$*"; }
finish() {
  echo
  echo "Log: $LOG"
  echo "Press Enter to close this window."
  read -r _
  exit "$1"
}
fail() {
  echo
  echo "STOPPED: $*"
  echo "Nothing in Applications or Claude Desktop was changed after this point."
  finish 1
}

# ---- Node and git -------------------------------------------------------------------------------
say "Finding Node and git"
export NVM_DIR="$HOME/.nvm"
[ -s "$NVM_DIR/nvm.sh" ] && . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
export PATH="$PATH:/opt/homebrew/bin:/usr/local/bin"
NODE="$(command -v node || true)"
[ -n "$NODE" ] || fail "Node is not installed. Install it from nodejs.org (LTS), then run this again."
NODE_MAJOR="$("$NODE" -p 'process.versions.node.split(".")[0]')"
[ "$NODE_MAJOR" -ge 18 ] || fail "Node $("$NODE" -v) is too old. Node 18 or later is needed."
command -v git >/dev/null || fail "git is missing. Run: xcode-select --install"
echo "Node $("$NODE" -v) at $NODE"
echo "$(git --version)"

# ---- the source ---------------------------------------------------------------------------------
say "Getting $BRANCH from $REPO"
if [ -d "$SRC/.git" ]; then
  git -C "$SRC" fetch --depth 1 origin "$BRANCH" || fail "could not download the branch (network?)"
  git -C "$SRC" reset --hard FETCH_HEAD || fail "could not update the source in $SRC"
else
  rm -rf "$SRC"
  git clone --depth 1 --branch "$BRANCH" "$REPO" "$SRC" || fail "could not download the branch (network?)"
fi
COMMIT="$(git -C "$SRC" log -1 --format='%h %s')"
echo "Commit: $COMMIT"
[ -f "$SRC/main-mcp.cjs" ] || fail "this commit has no MCP server (main-mcp.cjs missing)"

# ---- build --------------------------------------------------------------------------------------
say "Installing build tools (first time: a few minutes)"
cd "$SRC" || fail "no source folder"
npm ci --no-audit --no-fund || fail "npm could not install the build tools"

say "Building the app (Apple Silicon)"
rm -rf "$SRC/dist"
npx electron-builder --mac dir --arm64 --publish never || fail "the build failed (see the log)"
NEW="$SRC/dist/mac-arm64/$APP_NAME.app"
[ -d "$NEW" ] || fail "the build made no app at $NEW"
codesign --verify --deep "$NEW" 2>/dev/null || fail "the built app is not signed (build/after-pack.cjs did not run)"
VERSION="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$NEW/Contents/Info.plist")"
echo "Built $APP_NAME $VERSION"

# ---- swap it into Applications ------------------------------------------------------------------
say "Putting it in Applications"
# by path: macOS cuts process names at 16 characters, and "MC707-101 Toolbox" is 17
running() { pgrep -f "$APP_NAME.app/Contents/MacOS/" >/dev/null; }
if running; then
  echo "Quitting the running Toolbox"
  osascript -e "tell application \"$APP_NAME\" to quit" >/dev/null 2>&1
  for _ in $(seq 1 20); do running || break; sleep 0.5; done
  running && fail "the Toolbox is still open. Quit it (save your song first), then run this again."
fi
if [ -d "$APP" ]; then
  OLD_V="$(/usr/libexec/PlistBuddy -c 'Print CFBundleShortVersionString' "$APP/Contents/Info.plist" 2>/dev/null || echo old)"
  BACKUP="$WORK/backup/$APP_NAME $OLD_V $STAMP.app"
  mkdir -p "$WORK/backup"
  # outside Applications on purpose: two apps with the same id there could make macOS open the wrong one
  mv "$APP" "$BACKUP" || fail "could not move the old app out of Applications"
  echo "Old app ($OLD_V) kept at: $BACKUP"
fi
ditto "$NEW" "$APP" || fail "could not copy the new app into Applications"
/System/Library/Frameworks/CoreServices.framework/Frameworks/LaunchServices.framework/Support/lsregister -f "$APP" >/dev/null 2>&1
echo "Installed: $APP ($VERSION, $COMMIT)"

# ---- first start: the app makes mcp.json --------------------------------------------------------
say "Opening the Toolbox once"
open "$APP"
for _ in $(seq 1 60); do [ -s "$SETTINGS" ] && break; sleep 0.5; done
[ -s "$SETTINGS" ] || fail "the Toolbox did not make $SETTINGS (did it open?)"
echo "MCP settings: $SETTINGS"

# ---- check the server through the bridge, with the app's own binary --------------------------------
say "Checking the MCP server"
BIN="$APP/Contents/MacOS/$APP_NAME"
BRIDGE="$APP/Contents/Resources/app.asar/mcp/toolbox-mcp-bridge.cjs"
probe() {
  printf '%s\n%s\n' \
    '{"jsonrpc":"2.0","id":1,"method":"initialize","params":{"protocolVersion":"2025-06-18","capabilities":{},"clientInfo":{"name":"build-check","version":"1"}}}' \
    '{"jsonrpc":"2.0","id":2,"method":"tools/list"}' | "$@" 2>/dev/null
}
OUT="$(ELECTRON_RUN_AS_NODE=1 probe "$BIN" "$BRIDGE")"
COUNT="$(printf '%s' "$OUT" | "$NODE" -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{const l=t.trim().split("\n").map(JSON.parse);const r=l.find(x=>x.id===2);console.log(r&&r.result?r.result.tools.length:0)}catch(e){console.log(0)}})')"
MODE="app"
if [ "$COUNT" -lt 1 ]; then
  echo "The app's own binary could not run the bridge; trying with Node instead"
  cp "$SRC/mcp/toolbox-mcp-bridge.cjs" "$WORK/toolbox-mcp-bridge.cjs"
  OUT="$(probe "$NODE" "$WORK/toolbox-mcp-bridge.cjs")"
  COUNT="$(printf '%s' "$OUT" | "$NODE" -e 'let t="";process.stdin.on("data",d=>t+=d).on("end",()=>{try{const l=t.trim().split("\n").map(JSON.parse);const r=l.find(x=>x.id===2);console.log(r&&r.result?r.result.tools.length:0)}catch(e){console.log(0)}})')"
  MODE="node"
fi
[ "$COUNT" -ge 1 ] || fail "the MCP server did not answer. Output was: $OUT"
echo "The server answers: $COUNT tools"

# ---- Claude Desktop ---------------------------------------------------------------------------
say "Adding the server to Claude Desktop"
mkdir -p "$(dirname "$CLAUDE_CFG")"
[ -f "$CLAUDE_CFG" ] && cp "$CLAUDE_CFG" "$CLAUDE_CFG.before-mc707-$STAMP" && echo "Config backup: $CLAUDE_CFG.before-mc707-$STAMP"
MODE="$MODE" BIN="$BIN" BRIDGE="$BRIDGE" NODE_BIN="$NODE" NODE_BRIDGE="$WORK/toolbox-mcp-bridge.cjs" CFG="$CLAUDE_CFG" "$NODE" -e '
  const fs = require("fs");
  const f = process.env.CFG;
  let c = {};
  if (fs.existsSync(f)) {
    try { c = JSON.parse(fs.readFileSync(f, "utf8")); }
    catch (e) { console.error("STOP: " + f + " is not valid JSON, so it was left alone: " + e.message); process.exit(2); }
  }
  c.mcpServers = c.mcpServers || {};
  c.mcpServers["mc707-toolbox"] = process.env.MODE === "app"
    ? { command: process.env.BIN, args: [process.env.BRIDGE], env: { ELECTRON_RUN_AS_NODE: "1" } }
    : { command: process.env.NODE_BIN, args: [process.env.NODE_BRIDGE] };
  fs.writeFileSync(f, JSON.stringify(c, null, 2) + "\n");
  console.log("Servers in the config: " + Object.keys(c.mcpServers).join(", "));
' || fail "Claude Desktop's config was not changed"

say "Done"
echo "Toolbox $VERSION from $BRANCH ($COMMIT) is in Applications and its MCP server answers."
echo "Last step: quit Claude Desktop (Cmd-Q) and open it again, so it starts the mc707-toolbox server."
finish 0
