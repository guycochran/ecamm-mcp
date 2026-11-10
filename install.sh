#!/bin/bash
# ecamm-mcp installer for macOS. Safe to run again any time to update.
#
#   curl -fsSL https://raw.githubusercontent.com/guycochran/ecamm-mcp/main/install.sh | bash
#
# What it does, in order:
#   1. Uses the Node.js you already have (20 or newer). If you have none, it downloads the
#      official Node.js into ~/.ecamm-mcp/node. Nothing is installed system-wide, no sudo.
#   2. Downloads the ecamm-mcp server (one file) into ~/.ecamm-mcp.
#   3. Runs "ecamm-mcp setup": adds Ecamm to Claude desktop (your config is backed up first)
#      and gets Ecamm Live to show its "Wants To Control Ecamm" dialog so you can click Allow.
#
# Options (environment variables):
#   ECAMM_MCP_DIR=path     install somewhere other than ~/.ecamm-mcp
#   ECAMM_MCP_REF=name     build a branch, tag or commit from source instead of the latest release
#   ECAMM_MCP_OWN_NODE=1   ignore any Node.js on this Mac and use a private copy
# Anything after "bash -s --" is passed to setup, e.g. "... | bash -s -- --no-claude".
set -euo pipefail

REPO="guycochran/ecamm-mcp"
DIR="${ECAMM_MCP_DIR:-$HOME/.ecamm-mcp}"
REF="${ECAMM_MCP_REF:-}"
NODE_MAJOR=22

say() { printf '%s\n' "$*"; }
die() { printf '\nInstall failed: %s\nHelp: https://github.com/%s/issues\n' "$*" "$REPO" >&2; exit 1; }

OS="$(uname -s | tr '[:upper:]' '[:lower:]')"
if [ "$OS" != "darwin" ] && [ -z "${ECAMM_MCP_FORCE:-}" ]; then
  die "Ecamm Live only runs on a Mac, so this installer does too."
fi
command -v curl >/dev/null 2>&1 || die "curl is missing."

mkdir -p "$DIR"
TMP="$(mktemp -d "${TMPDIR:-/tmp}/ecamm-mcp.XXXXXX")"
trap 'rm -rf "$TMP"' EXIT

sha256() {
  if command -v shasum >/dev/null 2>&1; then shasum -a 256 "$1" | awk '{print $1}'
  else sha256sum "$1" | awk '{print $1}'; fi
}

node_ok() {
  [ -x "$1" ] && "$1" -e 'process.exit(Number(process.versions.node.split(".")[0]) >= 20 ? 0 : 1)' >/dev/null 2>&1
}

install_node() {
  local arch base line file want got
  case "$(uname -m)" in
    arm64 | aarch64) arch=arm64 ;;
    x86_64) arch=x64 ;;
    *) die "Unsupported processor: $(uname -m)" ;;
  esac
  base="https://nodejs.org/dist/latest-v${NODE_MAJOR}.x"
  say "No Node.js 20+ found. Downloading a private copy from nodejs.org (about 45 MB)..."
  curl -fsSL "$base/SHASUMS256.txt" -o "$TMP/sums" || die "Could not reach nodejs.org."
  line="$(grep " node-v.*-${OS}-${arch}\.tar\.gz\$" "$TMP/sums" | head -n 1 || true)"
  [ -n "$line" ] || die "nodejs.org has no Node.js ${NODE_MAJOR} build for ${OS}-${arch}."
  want="${line%% *}"
  file="${line##* }"
  curl -fL --progress-bar "$base/$file" -o "$TMP/$file" || die "Node.js download failed."
  got="$(sha256 "$TMP/$file")"
  [ "$got" = "$want" ] || die "Node.js download did not match its checksum. Try again."
  mkdir -p "$TMP/node"
  tar -xzf "$TMP/$file" -C "$TMP/node" --strip-components 1
  node_ok "$TMP/node/bin/node" || die "The downloaded Node.js does not run on this Mac."
  if [ -e "$DIR/node" ]; then mv "$DIR/node" "$TMP/node.old"; fi
  mv "$TMP/node" "$DIR/node"
}

# 1. Node.js
NODE=""
if [ -z "${ECAMM_MCP_OWN_NODE:-}" ] && command -v node >/dev/null 2>&1 && node_ok "$(command -v node)"; then
  NODE="$(command -v node)"
elif node_ok "$DIR/node/bin/node"; then
  NODE="$DIR/node/bin/node"
else
  install_node
  NODE="$DIR/node/bin/node"
fi
say "Node.js: $("$NODE" --version) ($NODE)"

# 2. The server (one file)
NEW="$TMP/ecamm-mcp.cjs"
if [ -n "$REF" ]; then
  say "Building ecamm-mcp from source ($REF)..."
  mkdir -p "$TMP/src"
  curl -fsSL "https://github.com/$REPO/archive/$REF.tar.gz" | tar -xz -C "$TMP/src" --strip-components 1 ||
    die "Could not download $REF from GitHub."
  (
    cd "$TMP/src"
    export PATH="$(dirname "$NODE"):$PATH"
    npm ci --no-audit --no-fund --loglevel=error
    npm run --silent package >/dev/null
  ) || die "Build from source failed."
  cp "$TMP/src/release/ecamm-mcp.cjs" "$NEW"
else
  say "Downloading ecamm-mcp..."
  curl -fsSL "https://github.com/$REPO/releases/latest/download/ecamm-mcp.cjs" -o "$NEW" ||
    die "Could not download ecamm-mcp from GitHub. Check your internet connection and try again."
fi
VERSION="$("$NODE" "$NEW" --version 2>/dev/null)" || die "The download looks broken. Try again."
mv -f "$NEW" "$DIR/ecamm-mcp.cjs"

# A small command so "doctor" and "setup" are easy to run later.
cat >"$DIR/ecamm-mcp" <<WRAPPER
#!/bin/bash
exec "$NODE" "$DIR/ecamm-mcp.cjs" "\$@"
WRAPPER
chmod +x "$DIR/ecamm-mcp"
say "Installed ecamm-mcp $VERSION in $DIR"
say

# 3. Connect Claude desktop and get the Allow dialog up in Ecamm Live
rm -rf "$TMP"
trap - EXIT
exec "$NODE" "$DIR/ecamm-mcp.cjs" setup "$@"
