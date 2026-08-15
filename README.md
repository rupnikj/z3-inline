# z3-inline

z3-inline packages a single-threaded Emscripten build of Z3 into a single self-contained HTML file: the WASM is gzipped, base64-inlined, and instantiated from bytes at load — no fetch, no workers, no SharedArrayBuffer, no hosting. It runs wherever HTML renders, including sandboxed iframes with restrictive CSPs that block all of the above (tested inside claude.ai's artifact sandbox). CI builds Z3 from source with a pinned emsdk and publishes both the reusable z3-st.{js,wasm} component and the assembled artifact. Sibling of dafny-verify-browser, which runs the full Dafny verifier in-browser where threads are available.

## Layout

- `scripts/build-z3.sh` — builds Z3 (pinned tag, `Z3_SINGLE_THREADED=ON`, `Z3_POLLING_TIMER=ON`, MinSizeRel/-Oz, JS exception catching) into `dist/z3-st.{js,wasm}`. Gates: glue is thread-free, defines global `createZ3`, gzipped wasm ≤ 14MB.
- `test/node-check.mjs` — acceptance gates: loads the glue with `fetch` sabotaged (any network probe fails the run), checks unsat / sat+model / arithmetic answers, reports whether `callMain` is reusable within one instance.
- `tools/make-artifact.mjs` + `tools/artifact-template.html` — gzip+base64 the wasm, inline glue and payload into `dist/z3-artifact.html` (fails > 20MB).
- `.github/workflows/build.yml` — build → test → assemble; tags `v*` publish a GitHub release with all three outputs; pushes to main deploy the demo to GitHub Pages: <https://rupnikj.github.io/z3-inline/> — the artifact page plus an auto-running verification suite of baked-in problems (unsat/sat/model/eight-queens plus the pigeonhole soft-timeout case), with the plain `z3-artifact.html` served alongside for download.

## Pinned versions

Z3 `4.16.0` (tag `z3-4.16.0`), emsdk `4.0.23` (both in the workflow `env` block and overridable via `Z3_VERSION` for the build script).

Why 4.16.0 rather than the newer 5.0.0: Dafny bundles and defaults to Z3 4.16.0 on master/nightly (dafny-lang/dafny#6477), so this pin matches the solver the consuming Dafny build is tested against — and Dafny verification outcomes are famously Z3-version-sensitive (dafny-lang/dafny#6481). Z3 5.0.0 has no presence in the Dafny ecosystem (no solver-builds artifact, no upstream validation). The build detects which exception ABI the pinned source requires — Z3 4.x links libz3 with the legacy JS-based EH, 5.x with native wasm EH — and compiles to match, so either pin builds correctly; the choice is recorded as `exceptionAbi` in `build-info.json`.

## Local build

```sh
source /path/to/emsdk/emsdk_env.sh
bash scripts/build-z3.sh          # ~30-60 min cold
node test/node-check.mjs
node tools/make-artifact.mjs      # -> dist/z3-artifact.html
```

## Using the component directly

```js
const z3 = await createZ3({ wasmBinary, print: console.log, printErr: console.error, noInitialRun: true });
z3.FS.writeFile("/in.smt2", "(declare-const x Int)(assert (> x 5))(check-sat)");
z3.callMain(["-smt2", "-t:30000", "/in.smt2"]);
```

## Incremental sessions via the C API

The same binary exports the C API for incremental solving (state persists across calls — no re-parsing/re-solving of an accumulated script):

```js
const z3 = await createZ3({ wasmBinary, noInitialRun: true });
const cw = (n, r, a) => z3.cwrap(n, r, a);
const cfg = cw("Z3_mk_config", "number", [])();
cw("Z3_set_param_value", null, ["number", "string", "string"])(cfg, "timeout", "30000"); // API equivalent of -t
const ctx = cw("Z3_mk_context", "number", ["number"])(cfg);
cw("Z3_del_config", null, ["number"])(cfg);
cw("Z3_set_error_handler", null, ["number", "number"])(ctx, 0); // else errors exit(1) -> thrown ExitStatus
const evalSmt2 = cw("Z3_eval_smtlib2_string", "string", ["number", "string"]);
evalSmt2(ctx, "(declare-const x Int)");
evalSmt2(ctx, "(assert (> x 5))");
evalSmt2(ctx, "(check-sat)"); // "sat" — state persisted across calls
cw("Z3_del_context", null, ["number"])(ctx);
```

Notes: `cwrap`'s `"string"` return type copies the Z3-owned result immediately (it is only valid until the next call). With the NULL error handler installed, errors set `Z3_get_error_code` (readable via `Z3_get_error_msg`) and appear as `(error ...)` in the returned string; the context stays usable. Detect API availability with `typeof z3._Z3_eval_smtlib2_string === "function"` (older z3-st assets only have the CLI). Measured: 400 incremental exchanges ≈ 24ms in one context vs ~46s replaying a growing script through `callMain`.

Timeouts: use Z3's cooperative soft timeout `-t:<milliseconds>` — the solver checks it at internal checkpoints and answers `unknown` (queries stuck deep in big-number arithmetic can overrun it). The hard timeout `-T` needs an alarm thread this build doesn't have and throws `WebAssembly.Exception` immediately. One instance serves one `callMain`: re-entry keeps the previous input file in Z3's global argv state and can answer for the stale file, so create a fresh instance per query (~1s). The solver runs on the calling thread by design (sandboxes that allow workers don't need this package).

## Scope

SMT-LIB 2 in, sat/unsat/model out. This is not Dafny-in-browser — Boogie/Dafny (.NET) stay outside; see dafny-verify-browser for the threaded, hosted variant.
