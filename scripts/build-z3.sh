#!/usr/bin/env bash
# Build a single-threaded, single-file-friendly Z3 with Emscripten.
#
# Requires an activated emsdk (emcc on PATH). Produces:
#   dist/z3-st.js     - MODULARIZE glue, defines global `createZ3`, never fetches
#   dist/z3-st.wasm   - single-threaded wasm
#   dist/build-info.json
#
# The output is meant to be driven as an executable:
#   const z3 = await createZ3({ wasmBinary, print, printErr });
#   z3.FS.writeFile("/in.smt2", "..."); z3.callMain(["-smt2", "/in.smt2"]);
set -euo pipefail

Z3_VERSION="${Z3_VERSION:-5.0.0}"
ROOT="$(cd "$(dirname "$0")/.." && pwd)"
WORK="$ROOT/build"
DIST="$ROOT/dist"
SRC="$WORK/z3-z3-$Z3_VERSION"
BUILD="$WORK/cmake-st"
JOBS="$(getconf _NPROCESSORS_ONLN 2>/dev/null || echo 4)"

command -v emcc >/dev/null || { echo "ERROR: emcc not on PATH (activate emsdk first)"; exit 1; }
mkdir -p "$WORK" "$DIST"

if [ ! -d "$SRC" ]; then
  echo "== Fetching Z3 $Z3_VERSION source tarball"
  curl -fsSL "https://github.com/Z3Prover/z3/archive/refs/tags/z3-$Z3_VERSION.tar.gz" | tar -xz -C "$WORK"
fi

# Z3 needs real C++ exception catching (parser/solver errors are exceptions).
# The JS-based catching (-fexceptions + DISABLE_EXCEPTION_CATCHING=0) is the
# battle-tested path used by the official z3-solver npm build.
CXXFLAGS="-fexceptions -Oz"
LDFLAGS="-Oz -fexceptions \
 -sDISABLE_EXCEPTION_CATCHING=0 \
 -sMODULARIZE=1 -sEXPORT_NAME=createZ3 -sEXPORT_ES6=0 \
 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=20971520 \
 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
 -sFORCE_FILESYSTEM=1 \
 -sEXPORTED_RUNTIME_METHODS=FS,callMain \
 -sENVIRONMENT=web,node"

echo "== Configuring (single-threaded, polling timer, MinSizeRel)"
emcmake cmake -S "$SRC" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DZ3_SINGLE_THREADED=ON \
  -DZ3_POLLING_TIMER=ON \
  -DZ3_BUILD_LIBZ3_SHARED=OFF \
  -DZ3_BUILD_PYTHON_BINDINGS=OFF \
  -DZ3_ENABLE_EXAMPLE_TARGETS=OFF \
  -DZ3_BUILD_DOCUMENTATION=OFF \
  -DZ3_INCLUDE_GIT_HASH=OFF \
  -DZ3_INCLUDE_GIT_DESCRIBE=OFF \
  ${CMAKE_EXTRA_ARGS:-} \
  -DCMAKE_CXX_FLAGS="$CXXFLAGS" \
  -DCMAKE_EXE_LINKER_FLAGS="$LDFLAGS"

echo "== Building z3 (target: shell) with -j$JOBS"
cmake --build "$BUILD" --target shell -j"$JOBS"

cp "$BUILD/z3.js" "$DIST/z3-st.js"
cp "$BUILD/z3.wasm" "$DIST/z3-st.wasm"

echo "== Gate: glue must be single-threaded and must not need the network"
if grep -q "ENVIRONMENT_IS_PTHREAD\|allocateUnusedWorker\|PThread\.init" "$DIST/z3-st.js"; then
  echo "ERROR: glue contains pthread machinery - this build is threaded and unusable in the sandbox"
  exit 1
fi
if ! grep -q "var createZ3" "$DIST/z3-st.js"; then
  echo "ERROR: glue does not declare 'var createZ3' - MODULARIZE/EXPORT_NAME output changed"
  exit 1
fi

GZ_BYTES=$(gzip -9 -c "$DIST/z3-st.wasm" | wc -c | tr -d ' ')
echo "== Sizes: wasm $(wc -c < "$DIST/z3-st.wasm" | tr -d ' ') bytes, gzipped $GZ_BYTES bytes, glue $(wc -c < "$DIST/z3-st.js" | tr -d ' ') bytes"
if [ "$GZ_BYTES" -gt 14680064 ]; then
  echo "ERROR: gzipped wasm exceeds 14MB budget"
  exit 1
fi

cat > "$DIST/build-info.json" <<EOF
{
  "z3Version": "$Z3_VERSION",
  "emcc": "$(emcc --version | head -1 | sed 's/"/\\"/g')",
  "wasmBytes": $(wc -c < "$DIST/z3-st.wasm" | tr -d ' '),
  "wasmGzipBytes": $GZ_BYTES,
  "glueBytes": $(wc -c < "$DIST/z3-st.js" | tr -d ' '),
  "wasmSha256": "$(shasum -a 256 "$DIST/z3-st.wasm" 2>/dev/null | cut -d' ' -f1 || sha256sum "$DIST/z3-st.wasm" | cut -d' ' -f1)"
}
EOF
echo "== Done"
cat "$DIST/build-info.json"
