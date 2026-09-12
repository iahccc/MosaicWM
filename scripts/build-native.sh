#!/usr/bin/env bash
# Build the GNOME 50 bridge that lets Mosaic constrain a maximized window
# without clearing Mutter's native maximized state.

set -euo pipefail

ROOT_DIR="$(cd "$(dirname "${BASH_SOURCE[0]}")/.." && pwd)"
SOURCE_DIR="$ROOT_DIR/native"
OUTPUT_DIR="$ROOT_DIR/extension/native"
BUILD_DIR="$ROOT_DIR/build/native"
MUTTER_PKG="libmutter-18"
NAMESPACE="MosaicWMNative"
VERSION="1.0"

for tool in cc pkg-config g-ir-scanner g-ir-compiler; do
    if ! command -v "$tool" >/dev/null 2>&1; then
        echo "Missing native build tool: $tool" >&2
        exit 1
    fi
done

if ! pkg-config --exists "$MUTTER_PKG"; then
    echo "Missing $MUTTER_PKG development files (required only for the GNOME 50 native bridge)" >&2
    exit 1
fi

mkdir -p "$OUTPUT_DIR" "$BUILD_DIR"

LIBRARY="$OUTPUT_DIR/libmosaicwm-native.so"
GIR="$BUILD_DIR/$NAMESPACE-$VERSION.gir"
TYPELIB="$OUTPUT_DIR/$NAMESPACE-$VERSION.typelib"
MUTTER_GIR_DIR="$(pkg-config --variable=girdir "$MUTTER_PKG")"
MUTTER_LIB_DIR="$(pkg-config --variable=libdir "$MUTTER_PKG")"

read -r -a MUTTER_CFLAGS <<< "$(pkg-config --cflags "$MUTTER_PKG")"
read -r -a GOBJECT_LIBS <<< "$(pkg-config --libs gobject-2.0)"

cc \
    -std=c11 \
    -fPIC \
    -shared \
    -Wall \
    -Wextra \
    -Werror \
    "${MUTTER_CFLAGS[@]}" \
    "$SOURCE_DIR/mosaic-dominant-constraint.c" \
    "${GOBJECT_LIBS[@]}" \
    -o "$LIBRARY"

# The bridge intentionally does not DT_NEEDED libmutter: it is loaded inside
# gnome-shell, where the matching Mutter is already present. Preload Mutter only
# while generating introspection data so the scanner can resolve the interface.
LD_PRELOAD="$MUTTER_LIB_DIR/libmutter-18.so.0${LD_PRELOAD:+:$LD_PRELOAD}" \
g-ir-scanner \
    --quiet \
    --warn-all \
    --no-libtool \
    --namespace="$NAMESPACE" \
    --nsversion="$VERSION" \
    --identifier-prefix=Mosaic \
    --symbol-prefix=mosaic \
    --include=GObject-2.0 \
    --include=Meta-18 \
    --add-include-path="$MUTTER_GIR_DIR" \
    --library=mosaicwm-native \
    --library-path="$OUTPUT_DIR" \
    --pkg=gobject-2.0 \
    --pkg="$MUTTER_PKG" \
    --output="$GIR" \
    "$SOURCE_DIR/mosaic-dominant-constraint.h" \
    "$SOURCE_DIR/mosaic-dominant-constraint.c"

# Nix's compiler wrapper can make the scanner record its ephemeral build-env
# path. The typelib must instead resolve the library from the extension-private
# library path registered by dominantGeometryConstraint.js.
sed 's#shared-library="[^"]*libmosaicwm-native\.so"#shared-library="libmosaicwm-native.so"#' \
    "$GIR" > "$GIR.tmp"
mv "$GIR.tmp" "$GIR"

g-ir-compiler \
    --includedir="$MUTTER_GIR_DIR" \
    "$GIR" \
    -o "$TYPELIB"

echo "Built GNOME 50 native bridge in $OUTPUT_DIR"
