#!/usr/bin/env bash
# Idempotent: installs the system prerequisites of the isolated runtime (bubblewrap) and verifies them for real.
set -eu
if ! command -v bwrap >/dev/null 2>&1; then
  SUDO=""; [ "$(id -u)" -eq 0 ] || SUDO="sudo"
  $SUDO apt-get update -qq && $SUDO apt-get install -y -qq bubblewrap
fi
command -v claude >/dev/null 2>&1 || echo "WARN: the 'claude' CLI is not on PATH (npm i -g @anthropic-ai/claude-code, then authenticate)"
node "$(dirname "$0")/doctor.js"
