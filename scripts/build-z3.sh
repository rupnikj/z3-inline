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

Z3_VERSION="${Z3_VERSION:-4.16.0}"
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

# Z3 needs real C++ exception catching (parser/solver errors are exceptions), and
# our objects must use the same exception ABI that Z3's own Emscripten block
# links libz3 with: >= 5.0.0 forces native wasm EH, 4.x forces the legacy
# JS-based EH. Mixing the two fails the link outright ("DISABLE_EXCEPTION_
# CATCHING=0 is not compatible with -fwasm-exceptions"), so detect it from the
# source tree instead of hardcoding it per pin.
if grep -q '"-fwasm-exceptions"' "$SRC/CMakeLists.txt"; then
  EH_ABI="wasm"
  EH_CXX="-fwasm-exceptions"
  EH_LD="-fwasm-exceptions -sSUPPORT_LONGJMP=wasm"
else
  EH_ABI="js"
  EH_CXX="-fexceptions"
  EH_LD="-fexceptions -sDISABLE_EXCEPTION_CATCHING=0"
fi
echo "== Exception ABI: $EH_ABI (from Z3 $Z3_VERSION sources)"

CXXFLAGS="$EH_CXX -Oz"
LDFLAGS="-Oz $EH_LD \
 -sMODULARIZE=1 -sEXPORT_NAME=createZ3 -sEXPORT_ES6=0 \
 -sALLOW_MEMORY_GROWTH=1 -sINITIAL_MEMORY=67108864 -sSTACK_SIZE=20971520 \
 -sINVOKE_RUN=0 -sEXIT_RUNTIME=0 \
 -sFORCE_FILESYSTEM=1 \
 -sEXPORTED_FUNCTIONS=_Z3_mk_config,_Z3_set_param_value,_Z3_mk_context,_Z3_del_context,_Z3_del_config,_Z3_eval_smtlib2_string,_Z3_get_error_code,_Z3_get_error_msg,_Z3_set_error_handler,_malloc,_free,_main \
 -sEXPORTED_RUNTIME_METHODS=FS,callMain,ccall,cwrap,UTF8ToString,stringToUTF8,lengthBytesUTF8 \
 -sENVIRONMENT=web,node"

echo "== Configuring (single-threaded, polling timer, MinSizeRel)"
# TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY: configure checks compile without
# linking. Otherwise the EXPORTED_FUNCTIONS in CMAKE_EXE_LINKER_FLAGS poison
# every try_compile (test programs lack the Z3 symbols): FindThreads fails
# (no Threads::Threads target -> generate error) and all -Werror support
# checks silently report unsupported. Only bites on a cold CMake cache.
emcmake cmake -S "$SRC" -B "$BUILD" \
  -DCMAKE_BUILD_TYPE=MinSizeRel \
  -DCMAKE_TRY_COMPILE_TARGET_TYPE=STATIC_LIBRARY \
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
if ! grep -q "Z3_eval_smtlib2_string" "$DIST/z3-st.js"; then
  echo "ERROR: glue does not export Z3_eval_smtlib2_string - C API exports missing"
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
  "exceptionAbi": "$EH_ABI",
  "apiExports": ["Z3_mk_config", "Z3_set_param_value", "Z3_mk_context", "Z3_del_context", "Z3_del_config", "Z3_eval_smtlib2_string", "Z3_get_error_code", "Z3_get_error_msg", "Z3_set_error_handler"],
  "wasmBytes": $(wc -c < "$DIST/z3-st.wasm" | tr -d ' '),
  "wasmGzipBytes": $GZ_BYTES,
  "glueBytes": $(wc -c < "$DIST/z3-st.js" | tr -d ' '),
  "wasmSha256": "$(shasum -a 256 "$DIST/z3-st.wasm" 2>/dev/null | cut -d' ' -f1 || sha256sum "$DIST/z3-st.wasm" | cut -d' ' -f1)"
}
EOF
echo "== Done"
cat "$DIST/build-info.json"
