# z3-inline

z3-inline packages a single-threaded Emscripten build of Z3 into a single self-contained HTML file: the WASM is gzipped, base64-inlined, and instantiated from bytes at load — no fetch, no workers, no SharedArrayBuffer, no hosting. It runs wherever HTML renders, including sandboxed iframes with restrictive CSPs that block all of the above (tested inside claude.ai's artifact sandbox). CI builds Z3 from source with a pinned emsdk and publishes both the reusable z3-st.{js,wasm} component and the assembled artifact. Sibling of dafny-verify-browser, which runs the full Dafny verifier in-browser where threads are available.

## Layout

- `scripts/build-z3.sh` — builds Z3 (pinned tag, `Z3_SINGLE_THREADED=ON`, `Z3_POLLING_TIMER=ON`, MinSizeRel/-Oz, JS exception catching) into `dist/z3-st.{js,wasm}`. Gates: glue is thread-free, defines global `createZ3`, gzipped wasm ≤ 14MB.
- `test/node-check.mjs` — acceptance gates: loads the glue with `fetch` sabotaged (any network probe fails the run), checks unsat / sat+model / arithmetic answers, reports whether `callMain` is reusable within one instance.
- `tools/make-artifact.mjs` + `tools/artifact-template.html` — gzip+base64 the wasm, inline glue and payload into `dist/z3-artifact.html` (fails > 20MB).
- `.github/workflows/build.yml` — build → test → assemble; tags `v*` publish a GitHub release with all three outputs; pushes to main also deploy the page to GitHub Pages (enable Settings → Pages → Source: GitHub Actions).

## Pinned versions

Z3 `5.0.0` (tag `z3-5.0.0`), emsdk `4.0.23` (both in the workflow `env` block and overridable via `Z3_VERSION` for the build script).

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

Timeouts: use Z3's cooperative soft timeout `-t:<milliseconds>` — the solver checks it at internal checkpoints and answers `unknown` (queries stuck deep in big-number arithmetic can overrun it). The hard timeout `-T` needs an alarm thread this build doesn't have and throws `WebAssembly.Exception` immediately. One instance serves one `callMain`: re-entry keeps the previous input file in Z3's global argv state and can answer for the stale file, so create a fresh instance per query (~1s). The solver runs on the calling thread by design (sandboxes that allow workers don't need this package).

## Scope

SMT-LIB 2 in, sat/unsat/model out. This is not Dafny-in-browser — Boogie/Dafny (.NET) stay outside; see dafny-verify-browser for the threaded, hosted variant.
