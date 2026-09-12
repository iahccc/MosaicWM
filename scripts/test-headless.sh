#!/usr/bin/env bash
# Run one regression in a private bus/config/session, never replacing the live desktop.
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TEST_SCRIPT="${1:-test-maximized-layout.js}"
TEST_DIR="$(mktemp -d "${TMPDIR:-/tmp}/mosaic-test.XXXXXX")"
trap 'rm -rf "$TEST_DIR"' EXIT
mkdir -p "$TEST_DIR/extension" "$TEST_DIR/scripts" "$TEST_DIR/config" "$TEST_DIR/data" "$TEST_DIR/runtime"
cp -r "$ROOT_DIR/extension/." "$TEST_DIR/extension/"
cp "$ROOT_DIR/scripts/$TEST_SCRIPT" "$TEST_DIR/scripts/"
glib-compile-schemas "$TEST_DIR/extension/schemas"
export MOSAIC_TEST_EXTENSION_DIR="$TEST_DIR/extension"
export GSETTINGS_SCHEMA_DIR="$TEST_DIR/extension/schemas"
export XDG_CONFIG_HOME="$TEST_DIR/config"
export XDG_DATA_HOME="$TEST_DIR/data"
export XDG_RUNTIME_DIR="$TEST_DIR/runtime"
export GSETTINGS_BACKEND=memory
chmod 700 "$XDG_RUNTIME_DIR"

if ! command -v gnome-shell-test-tool >/dev/null 2>&1; then
    echo "Missing gnome-shell-test-tool (provided by GNOME Shell 50)" >&2
    exit 1
fi

# Eliminate session-bus and display inheritance from the user's active desktop.
unset DBUS_SESSION_BUS_ADDRESS DISPLAY WAYLAND_DISPLAY
dbus-run-session -- gnome-shell-test-tool --headless "$TEST_DIR/scripts/$TEST_SCRIPT"
