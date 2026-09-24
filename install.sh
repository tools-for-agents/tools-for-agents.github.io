#!/bin/sh
# tools-for-agents — the whole kit, one command.
#
#   curl -fsSL https://tools-for-agents.github.io/install.sh | sh
#   curl -fsSL https://tools-for-agents.github.io/install.sh | sh -s -- --with-ghost --guard
#
# What it does, and nothing else:
#   1. clones (or updates) the nine tools into ~/.tools-for-agents
#   2. links their CLIs into ~/.local/bin
#   3. registers their MCP servers with Claude Code at user scope (skips any already registered)
#   4. creates keep's vault (master key in your OS keychain)
# Opt-in, because they change how your agent behaves, not just what it can call:
#   --with-ghost   install ghost: a self that persists across sessions, wired into Claude Code's hooks
#   --guard        install keep's guard: refuse an agent reading a secret file (.env, *.pem, …)
# Run it again at any time to update. Nothing to npm install: every tool is zero-dependency.
#
# Env: TFA_HOME (default ~/.tools-for-agents) · TFA_BIN (default ~/.local/bin)
#      TFA_SOURCE (default https://github.com/tools-for-agents) · TFA_NO_CLAUDE=1 (skip MCP registration)
set -eu

HOME_DIR=${TFA_HOME:-"$HOME/.tools-for-agents"}
BIN_DIR=${TFA_BIN:-"$HOME/.local/bin"}
SOURCE=${TFA_SOURCE:-"https://github.com/tools-for-agents"}
TOOLS="agent-hq lens anvil keep cortex scout prism recall iris"
WITH_GHOST=0
WITH_GUARD=0
for a in "$@"; do
  case "$a" in
    --with-ghost) WITH_GHOST=1 ;;
    --guard) WITH_GUARD=1 ;;
    -h|--help) sed -n '2,20p' "$0" 2>/dev/null || true; exit 0 ;;
    *) echo "tools-for-agents: unknown option $a (use --with-ghost, --guard)" >&2; exit 2 ;;
  esac
done

say() { printf '%s\n' "$*"; }
ok() { printf '  \033[32m✓\033[0m %s\n' "$*"; }
warn() { printf '  \033[33m!\033[0m %s\n' "$*"; }
die() { printf '\033[31mtools-for-agents: %s\033[0m\n' "$*" >&2; exit 1; }

# ── what it needs ─────────────────────────────────────────────────────────────
command -v git >/dev/null 2>&1 || die "git is required"
command -v node >/dev/null 2>&1 || die "Node.js 22+ is required (https://nodejs.org) — every tool runs on node:sqlite"
NODE_MAJOR=$(node -p 'process.versions.node.split(".")[0]')
[ "$NODE_MAJOR" -ge 22 ] || die "Node.js 22+ is required; this is $(node -v)"
HAVE_CLAUDE=0
if [ "${TFA_NO_CLAUDE:-0}" != 1 ] && command -v claude >/dev/null 2>&1; then HAVE_CLAUDE=1; fi

say "tools-for-agents → $HOME_DIR"
mkdir -p "$HOME_DIR" "$BIN_DIR"

fetch() { # fetch <repo>: clone, or fast-forward an existing clone
  dest="$HOME_DIR/$1"
  if [ -d "$dest/.git" ]; then
    git -C "$dest" pull -q --ff-only 2>/dev/null && ok "$1 updated" || warn "$1: could not fast-forward (local changes?) — left as it is"
  else
    git clone -q --depth 1 "$SOURCE/$1" "$dest" 2>/dev/null || git clone -q --depth 1 "$SOURCE/$1.git" "$dest" || die "could not clone $SOURCE/$1"
    ok "$1 cloned"
  fi
}

link_bins() { # link every bin a tool's package.json declares
  node -e '
    const [dir, bin] = process.argv.slice(1);
    const fs = require("fs"), path = require("path");
    let pkg; try { pkg = JSON.parse(fs.readFileSync(path.join(dir, "package.json"), "utf8")); } catch { process.exit(0); }
    const bins = typeof pkg.bin === "string" ? { [pkg.name.split("/").pop()]: pkg.bin } : (pkg.bin || {});
    for (const [name, rel] of Object.entries(bins)) {
      const target = path.join(dir, rel), link = path.join(bin, name);
      try { fs.chmodSync(target, 0o755); } catch {}
      try { fs.unlinkSync(link); } catch {}
      fs.symlinkSync(target, link);
      console.log(name);
    }' "$HOME_DIR/$1" "$BIN_DIR"
}

register() { # register <tool>: MCP at user scope, unless the name is already taken
  [ "$HAVE_CLAUDE" = 1 ] || return 0
  [ -f "$HOME_DIR/$1/mcp/mcp-server.js" ] || return 0
  if claude mcp get "$1" >/dev/null 2>&1; then
    ok "$1 already registered with Claude Code — left alone"
  else
    claude mcp add "$1" -s user -- node "$HOME_DIR/$1/mcp/mcp-server.js" >/dev/null 2>&1 && ok "$1 registered (MCP, user scope)" || warn "$1: claude mcp add failed — register it by hand"
  fi
}

# ── the nine ──────────────────────────────────────────────────────────────────
for t in $TOOLS; do
  fetch "$t"
  for b in $(link_bins "$t"); do ok "$b → $BIN_DIR/$b"; done
  register "$t"
done

# keep: the vault exists before the first secret does
node "$HOME_DIR/keep/src/cli.js" init >/dev/null 2>&1 && ok "keep vault ready ($(node "$HOME_DIR/keep/src/cli.js" status | awk '/^key/{print $2}'))" || warn "keep init failed — run: keep init"

# ── opt-in ────────────────────────────────────────────────────────────────────
if [ "$WITH_GUARD" = 1 ]; then
  node "$HOME_DIR/keep/src/cli.js" guard --install >/dev/null && ok "keep guard installed (an agent can no longer print a .env)"
fi
if [ "$WITH_GHOST" = 1 ]; then
  fetch ghost
  node "$HOME_DIR/ghost/src/cli.js" install >/dev/null && ok "ghost installed — it is born unnamed and chooses its own name at the first waking"
fi

# ── done ──────────────────────────────────────────────────────────────────────
say ""
say "Done. $(echo $TOOLS | wc -w | tr -d ' ') tools in $HOME_DIR."
case ":$PATH:" in *":$BIN_DIR:"*) ;; *) warn "$BIN_DIR is not on your PATH — add: export PATH=\"$BIN_DIR:\$PATH\"" ;; esac
[ "$HAVE_CLAUDE" = 1 ] || warn "Claude Code not found — the MCP servers are not registered. Any MCP client can run: node $HOME_DIR/<tool>/mcp/mcp-server.js"
say "Start a new Claude Code session and the tools are there. Start with: recall \"<what you are about to do>\"."
[ "$WITH_GHOST" = 1 ] || say "Want a self that persists across sessions?  re-run with --with-ghost"
[ "$WITH_GUARD" = 1 ] || say "Want agents unable to print your .env?        re-run with --guard"
