#!/usr/bin/env bash
# Run a regression in a private bus/config/session, never replacing the live desktop.
#
# Usage: test-headless.sh [script.js | all]
#   script.js  one file from scripts/ (default: test-maximized-layout.js)
#   all        every scripts/test-*.js, each in its own isolated session
set -euo pipefail
ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
TARGET="${1:-test-maximized-layout.js}"

if ! command -v gnome-shell-test-tool >/dev/null 2>&1; then
    echo "Missing gnome-shell-test-tool (provided by GNOME Shell 50)" >&2
    exit 1
fi

# Enumerated rather than listed by hand: naming three files in CI left five regressions,
# including the constrained-layout and monitor-sized admission cases, with no runner at all.
#
# Filtered on the automation entry point, because scripts/ also holds the pure-node unit tests
# (test-layout-solver.js and friends). Those run under `npm run test:unit`; handing one to
# gnome-shell-test-tool would fail or hang for want of a run() to call.
is_headless_regression() {
    grep -q 'export async function run' "$1"
}

# A regression may declare an external binary it needs (`export const requiresBinary = 'x'`).
# Those are skipped with a notice instead of failing, so `all` stays green on a machine that
# does not have every browser installed, and the file still runs where it is available.
missing_binary_for() {
    local declared
    declared="$(sed -n "s/.*export const requiresBinary = '\([^']*\)'.*/\1/p" "$1" | head -1)"
    [[ -n "$declared" ]] || return 1
    command -v "$declared" >/dev/null 2>&1 && return 1
    echo "$declared"
    return 0
}

if [[ "$TARGET" == "all" ]]; then
    SCRIPTS=()
    for candidate in "$ROOT_DIR"/scripts/test-*.js; do
        [[ -e "$candidate" ]] || break
        is_headless_regression "$candidate" || continue
        SCRIPTS+=("$(basename "$candidate")")
    done
    if [[ ${#SCRIPTS[@]} -eq 0 ]]; then
        echo "No headless regressions found in $ROOT_DIR/scripts" >&2
        exit 1
    fi
else
    if [[ ! -f "$ROOT_DIR/scripts/$TARGET" ]]; then
        echo "No such regression: scripts/$TARGET" >&2
        exit 1
    fi
    SCRIPTS=("$TARGET")
fi

# Fails on the script's own error, and reports the tail of its output so a CI failure is
# diagnosable without downloading the whole log.
run_one() {
    local test_script="$1"
    local test_dir
    test_dir="$(mktemp -d "${TMPDIR:-/tmp}/mosaic-test.XXXXXX")"
    local log="$test_dir/output.log"
    local status=0

    # The whole body runs inside a "cleanup always runs" wrapper: a failure while staging the
    # tree (mkdir/cp/glib-compile-schemas) would otherwise abort the script under set -e and
    # leave a full extension copy behind.
    if ! (
        set -e
        mkdir -p "$test_dir/extension" "$test_dir/scripts" "$test_dir/config" "$test_dir/data" "$test_dir/runtime"
        cp -r "$ROOT_DIR/extension/." "$test_dir/extension/"
        cp "$ROOT_DIR/scripts/$test_script" "$test_dir/scripts/"
        glib-compile-schemas "$test_dir/extension/schemas"
    ); then
        echo "FAILED to stage $test_script" >&2
        rm -rf "$test_dir"
        return 1
    fi

    echo "=== $test_script ==="
    # Eliminate session-bus and display inheritance from the user's active desktop.
    env -u DBUS_SESSION_BUS_ADDRESS -u DISPLAY -u WAYLAND_DISPLAY \
        MOSAIC_TEST_EXTENSION_DIR="$test_dir/extension" \
        GSETTINGS_SCHEMA_DIR="$test_dir/extension/schemas" \
        XDG_CONFIG_HOME="$test_dir/config" \
        XDG_DATA_HOME="$test_dir/data" \
        XDG_RUNTIME_DIR="$test_dir/runtime" \
        GSETTINGS_BACKEND=memory \
        bash -c 'chmod 700 "$XDG_RUNTIME_DIR"; dbus-run-session -- gnome-shell-test-tool --headless "$1"' \
        _ "$test_dir/scripts/$test_script" > "$log" 2>&1 || status=$?

    if [[ $status -ne 0 ]]; then
        echo "--- last 40 lines of $test_script ---" >&2
        tail -40 "$log" >&2
    fi

    rm -rf "$test_dir"
    return $status
}

status=0
skipped=0
ran=0
for script in "${SCRIPTS[@]}"; do
    # A named target always runs: an explicit request that cannot be honoured should fail
    # loudly rather than report a skip as a pass.
    if [[ "$TARGET" == "all" ]]; then
        missing="$(missing_binary_for "$ROOT_DIR/scripts/$script" || true)"
        if [[ -n "$missing" ]]; then
            # Skipping quietly is how a regression stops running without anyone noticing. A
            # job that is meant to cover everything says so and gets a failure instead.
            if [[ -n "${HEADLESS_REQUIRE_ALL:-}" ]]; then
                echo "FAILED: $script needs '$missing', which is not installed, and HEADLESS_REQUIRE_ALL is set" >&2
                status=1
            else
                echo "SKIPPED: $script (needs '$missing', not installed)"
                skipped=$((skipped + 1))
            fi
            continue
        fi
    fi

    # Not fatal: one broken regression must not hide the verdict for the rest.
    ran=$((ran + 1))
    if ! run_one "$script"; then
        echo "FAILED: $script" >&2
        status=1
    fi
done

if [[ $status -eq 0 ]]; then
    echo "Headless regressions passed: $ran run, $skipped skipped"
fi
exit "$status"
