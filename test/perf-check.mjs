// Solver-level performance gate. Run: node test/perf-check.mjs
//
// Runs a FIXED, committed SMT-LIB workload (test/perf-suite.smt2, 600 check-sat
// blocks across LIA/BV/arrays/UF/pigeonhole) and fails if it is more than
// thresholdPct slower than the committed baseline for this environment.
//
// Why this exists: the 5.0.0 -> 4.16.0 re-pin cost 25-68% of verification speed
// and CI did not notice, because every other gate is a correctness gate.
//
// Measurement notes:
//   - min-of-N, not mean: noise on shared CI runners only ever ADDS time, so the
//     minimum is the stable statistic and survives a 15% threshold.
//   - baselines are per environment (hardware differs wildly); PERF_ENV picks
//     the entry, defaulting to `${platform}-${arch}`.
//   - the baseline records the workload's SHA-256. Editing perf-suite.smt2
//     invalidates every baseline and the gate fails loudly rather than
//     silently comparing against a different workload.
import { createRequire } from "node:module";
import { readFileSync, writeFileSync, mkdirSync } from "node:fs";
import { createHash } from "node:crypto";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const here = dirname(fileURLToPath(import.meta.url));
const root = join(here, "..");
// Z3_DIST_DIR points the gate at another build (a release download, an
// experiment) to A/B it against the committed baseline.
const dist = process.env.Z3_DIST_DIR || join(root, "dist");
const REPS = Number(process.env.PERF_REPS || 3);
const env = process.env.PERF_ENV || `${process.platform}-${process.arch}`;

const suite = readFileSync(join(here, "perf-suite.smt2"), "utf8");
const suiteHash = createHash("sha256").update(suite).digest("hex").slice(0, 16);
const baseline = JSON.parse(readFileSync(join(here, "perf-baseline.json"), "utf8"));
const buildInfo = JSON.parse(readFileSync(join(dist, "build-info.json"), "utf8"));

const require = createRequire(import.meta.url);
const createZ3 = require(join(dist, "z3-st.js"));
const wasmBinary = readFileSync(join(dist, "z3-st.wasm"));

const newInstance = (sink) => createZ3({
  wasmBinary, noInitialRun: true,
  print: (s) => sink.push(s), printErr: (s) => sink.push(s),
});

// Entry point 1: the CLI path (parse + solve the whole script).
async function runCli() {
  const out = [];
  const z3 = await newInstance(out);
  z3.FS.writeFile("/perf.smt2", suite);
  const t0 = performance.now();
  z3.callMain(["-smt2", "/perf.smt2"]);
  const ms = performance.now() - t0;
  return { ms, verdicts: tally(out) };
}

// Entry point 2: the C API path Part B drives (same work, no CLI/FS overhead).
async function runApi() {
  const out = [];
  const z3 = await newInstance(out);
  const cw = (n, r, a) => z3.cwrap(n, r, a);
  const cfg = cw("Z3_mk_config", "number", [])();
  const ctx = cw("Z3_mk_context", "number", ["number"])(cfg);
  cw("Z3_del_config", null, ["number"])(cfg);
  cw("Z3_set_error_handler", null, ["number", "number"])(ctx, 0);
  const t0 = performance.now();
  const res = cw("Z3_eval_smtlib2_string", "string", ["number", "string"])(ctx, suite);
  const ms = performance.now() - t0;
  cw("Z3_del_context", null, ["number"])(ctx);
  return { ms, verdicts: tally(res.split("\n")) };
}

function tally(lines) {
  const c = { sat: 0, unsat: 0, unknown: 0 };
  for (const l of lines) {
    const t = l.trim();
    if (t === "sat" || t === "unsat" || t === "unknown") c[t]++;
  }
  return c;
}

const results = {};
for (const [name, fn] of [["cli", runCli], ["api", runApi]]) {
  const times = [];
  let verdicts = null;
  for (let i = 0; i < REPS; i++) {
    const r = await fn();
    times.push(r.ms);
    verdicts ??= r.verdicts;
  }
  results[name] = { minMs: Math.round(Math.min(...times)), verdicts,
    allMs: times.map((t) => Math.round(t)) };
}

// The workload must produce the expected verdict mix, or we are timing the
// wrong thing (e.g. a solver erroring out early would look blazing fast).
const expected = baseline.expectedVerdicts;
let failures = 0;
for (const name of ["cli", "api"]) {
  const v = results[name].verdicts;
  const ok = v.sat === expected.sat && v.unsat === expected.unsat && v.unknown === expected.unknown;
  if (!ok) {
    failures++;
    console.log(`FAIL ${name} verdict mix ${JSON.stringify(v)} != expected ${JSON.stringify(expected)}`);
  }
}

const record = {
  env, z3Version: buildInfo.z3Version, exceptionAbi: buildInfo.exceptionAbi,
  suiteHash, reps: REPS,
  cliMs: results.cli.minMs, apiMs: results.api.minMs,
  cliAllMs: results.cli.allMs, apiAllMs: results.api.allMs,
};
mkdirSync(dist, { recursive: true });
writeFileSync(join(dist, "perf-result.json"), JSON.stringify(record, null, 2) + "\n");

console.log(`perf env=${env} z3=${buildInfo.z3Version} abi=${buildInfo.exceptionAbi} suite=${suiteHash}`);
console.log(`  cli min ${record.cliMs}ms of ${JSON.stringify(results.cli.allMs)}`);
console.log(`  api min ${record.apiMs}ms of ${JSON.stringify(results.api.allMs)}`);

const base = baseline.environments[env];
if (!base) {
  console.log(`\nBASELINE MISSING for env "${env}".`);
  console.log(`Record it in test/perf-baseline.json as:`);
  console.log(`  "${env}": { "cliMs": ${record.cliMs}, "apiMs": ${record.apiMs}, ` +
    `"z3Version": "${buildInfo.z3Version}", "suiteHash": "${suiteHash}" }`);
  console.log("Gate cannot run without a baseline; not failing the build.");
  process.exit(failures ? 1 : 0);
}
if (base.suiteHash !== suiteHash) {
  console.log(`\nFAIL baseline for "${env}" was recorded against workload ${base.suiteHash}, ` +
    `this run used ${suiteHash}. perf-suite.smt2 changed — re-record every baseline.`);
  process.exit(1);
}

const limit = 1 + baseline.thresholdPct / 100;
for (const key of ["cli", "api"]) {
  const got = record[`${key}Ms`], want = base[`${key}Ms`];
  const ratio = got / want;
  const ok = ratio <= limit;
  if (!ok) failures++;
  console.log(`${ok ? "PASS" : "FAIL"} ${key} ${got}ms vs baseline ${want}ms ` +
    `(${((ratio - 1) * 100).toFixed(1)}%, budget +${baseline.thresholdPct}%)`);
}

if (failures) {
  console.log("\nIf the change is a deliberate, accepted cost, re-record the baseline " +
    "in test/perf-baseline.json and say so in the commit message.");
}
process.exit(failures ? 1 : 0);
