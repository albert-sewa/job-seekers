#!/bin/bash
# Double-click this file to start Job Seek. It installs what it needs on the
# first run, starts the local server, and opens the app in your browser.
cd "$(dirname "$0")" || exit 1

echo ""
echo "  Job Seek — starting up…"
echo ""

# ---- Find Node.js (system PATH, nvm, Homebrew, official installer) ----------
find_node() {
  command -v node >/dev/null 2>&1 && return 0
  export NVM_DIR="${NVM_DIR:-$HOME/.nvm}"
  if [ -s "$NVM_DIR/nvm.sh" ]; then
    # shellcheck disable=SC1091
    . "$NVM_DIR/nvm.sh" >/dev/null 2>&1
    command -v node >/dev/null 2>&1 && return 0
  fi
  for p in /opt/homebrew/bin /usr/local/bin "$HOME/.volta/bin" "$HOME/.local/bin"; do
    if [ -x "$p/node" ]; then export PATH="$p:$PATH"; return 0; fi
  done
  return 1
}

if ! find_node; then
  echo "  Node.js isn't installed on this Mac."
  echo "  Opening the download page — install the LTS version, then run this file again."
  echo ""
  open "https://nodejs.org/en/download"
  read -r -p "  Press Enter to close this window."
  exit 1
fi

NODE_MAJOR="$(node -v | sed 's/^v//' | cut -d. -f1)"
if [ "$NODE_MAJOR" -lt 18 ]; then
  echo "  Node.js $(node -v) is too old — please install Node 18 or newer from https://nodejs.org"
  read -r -p "  Press Enter to close this window."
  exit 1
fi

# ---- Install dependencies on first run --------------------------------------
if [ ! -d node_modules ]; then
  echo "  First run: installing dependencies (about a minute)…"
  echo ""
  npm install --no-fund --no-audit || { echo "  npm install failed."; read -r -p "  Press Enter to close."; exit 1; }
  echo ""
fi

# ---- Start ------------------------------------------------------------------
echo "  Leave this window open while you use Job Seek."
echo "  Close it (or press Ctrl+C) to stop the app."
echo ""
node server/index.js
