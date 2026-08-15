// Acceptance gates for dist/z3-st.{js,wasm}. Run: node test/node-check.mjs
//
// Gates (any failure exits 1):
//   1. glue loads with wasmBinary and NEVER touches the network (fetch is sabotaged)
//   2. unsat / sat+model / arithmetic answers, each via the UI's EXACT invocation
//      (fresh instance, ["-smt2", "-t:<ms>", file]) — not bare callMain; the -T
//      regression lived at the invocation layer and solver-level tests missed it
//   3. soft timeout: a hostile query with -t:500 returns "unknown" without
//      throwing, in well under 10s
//   4. fresh-instance isolation: a different input file after a previous run
//      gets the correct answer (callMain re-entry in ONE instance keeps stale
//      argv — that mode is off in the UI and only reported here as INFO)
//   5. gzipped wasm <= 14MB (artifact payload budget)
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const wasmBinary = readFileSync(join(dist, "z3-st.wasm"));
const glue = readFileSync(join(dist, "z3-st.js"), "utf8");

// Gate 1: any network attempt by the glue must blow up loudly.
globalThis.fetch = () => { throw new Error("GATE FAILURE: glue called fetch()"); };
globalThis.XMLHttpRequest = function () { throw new Error("GATE FAILURE: glue used XHR"); };

const require = createRequire(import.meta.url);
const createZ3 = require(join(dist, "z3-st.js"));
if (typeof createZ3 !== "function") {
  console.error("FAIL: glue module.exports is not the createZ3 factory");
  process.exit(1);
}

let failures = 0;
const check = (name, ok, detail) => {
  console.log(`${ok ? "PASS" : "FAIL"} ${name}`);
  if (!ok) { failures++; if (detail) console.error(detail); }
};

async function freshInstance(out) {
  return createZ3({
    wasmBinary,
    print: (s) => out.push(s),
    printErr: (s) => out.push("E:" + s),
    noInitialRun: true,
  });
}

// KEEP IN SYNC with tools/artifact-template.html run(): fresh instance,
// -smt2, cooperative soft timeout -t in milliseconds (NEVER -T: the hard
// timeout needs an alarm thread and throws WebAssembly.Exception here).
const uiArgs = (timeoutSec) => ["-smt2", "-t:" + Math.round(timeoutSec * 1000)];
async function uiRun(smt2, timeoutSec = 30, file = "/in.smt2") {
  const out = [];
  const z3 = await freshInstance(out);
  z3.FS.writeFile(file, smt2);
  z3.callMain([...uiArgs(timeoutSec), file]);
  return out.join("\n");
}

// 12 pigeons / 11 holes: unsat, and the SAT-core search polls the timeout
// checkpoints constantly, so -t reliably interrupts it.
function pigeonhole(n) {
  const lines = [];
  for (let p = 0; p < n; p++) for (let h = 0; h < n - 1; h++) lines.push(`(declare-const p${p}h${h} Bool)`);
  for (let p = 0; p < n; p++) lines.push(`(assert (or ${Array.from({ length: n - 1 }, (_, h) => `p${p}h${h}`).join(" ")}))`);
  for (let h = 0; h < n - 1; h++)
    for (let a = 0; a < n; a++) for (let b = a + 1; b < n; b++)
      lines.push(`(assert (or (not p${a}h${h}) (not p${b}h${h})))`);
  lines.push("(check-sat)");
  return lines.join("\n");
}

const CASES = [
  {
    name: "unsat",
    smt2: "(declare-const x Int)(assert (> x 5))(assert (< x 3))(check-sat)",
    ok: (o) => o.includes("unsat"),
  },
  {
    name: "sat+model",
    smt2: "(declare-const x Int)(assert (> x 5))(check-sat)(get-model)",
    ok: (o) => /(^|\n)sat/.test(o) && o.includes("define-fun") && o.includes("x"),
  },
  {
    name: "arithmetic",
    smt2: "(declare-const a Int)(declare-const b Int)(assert (= (+ a b) 10))(assert (= (- a b) 4))(check-sat)(get-value (a b))",
    ok: (o) => /(^|\n)sat/.test(o) && /\(a 7\)/.test(o) && /\(b 3\)/.test(o),
  },
];

// Gate 2: the three solver answers, via the exact UI invocation.
for (const c of CASES) {
  try {
    const o = await uiRun(c.smt2);
    check("ui-invocation " + c.name, c.ok(o), o);
  } catch (e) {
    check("ui-invocation " + c.name, false, e.stack || String(e));
  }
}

// Gate 3: cooperative soft timeout interrupts a hostile query gracefully.
try {
  const t0 = Date.now();
  const o = await uiRun(pigeonhole(12), 0.5);
  const ms = Date.now() - t0;
  check("soft-timeout", o.includes("unknown") && ms < 10000, `output: ${o} (${ms}ms)`);
} catch (e) {
  check("soft-timeout", false, e.stack || String(e));
}

// Gate 4: fresh instances are isolated — a second run with a DIFFERENT file
// path must answer for its own input (this is what the UI relies on).
try {
  await uiRun(CASES[0].smt2, 30, "/a.smt2");
  const o = await uiRun("(declare-const q Int)(assert (> q 5))(check-sat)", 30, "/b.smt2");
  check("fresh-instance-isolation", /(^|\n)sat/.test(o) && !o.includes("already specified"), o);
} catch (e) {
  check("fresh-instance-isolation", false, e.stack || String(e));
}

// Informational: callMain re-entry in ONE instance is known-broken (stale argv).
try {
  const out = [];
  const z3 = await freshInstance(out);
  z3.FS.writeFile("/a.smt2", CASES[0].smt2);
  z3.callMain([...uiArgs(30), "/a.smt2"]);
  out.length = 0;
  z3.FS.writeFile("/b.smt2", "(declare-const q Int)(assert (> q 5))(check-sat)");
  z3.callMain([...uiArgs(30), "/b.smt2"]);
  const o = out.join("\n");
  const clean = /(^|\n)sat/.test(o) && !o.includes("already specified");
  console.log(`INFO reuse-callMain-in-one-instance: ${clean ? "WORKS" : "BROKEN (stale argv; keep REUSE_INSTANCE=false)"}`);
} catch (e) {
  console.log("INFO reuse-callMain-in-one-instance: THROWS (keep REUSE_INSTANCE=false)");
}

// --- C API gates (incremental solver sessions; the point is that state
// persists across Z3_eval_smtlib2_string calls, killing quadratic replay) ---
function apiBind(z3) {
  const cw = (n, r, a) => z3.cwrap(n, r, a);
  return {
    mkConfig: cw("Z3_mk_config", "number", []),
    setParam: cw("Z3_set_param_value", null, ["number", "string", "string"]),
    mkContext: cw("Z3_mk_context", "number", ["number"]),
    delConfig: cw("Z3_del_config", null, ["number"]),
    delContext: cw("Z3_del_context", null, ["number"]),
    setErrorHandler: cw("Z3_set_error_handler", null, ["number", "number"]),
    // cwrap "string" return copies the Z3-owned buffer immediately (it is only
    // valid until the next call). "timeout" config param is the API's -t.
    evalSmt2: cw("Z3_eval_smtlib2_string", "string", ["number", "string"]),
    errCode: cw("Z3_get_error_code", "number", ["number"]),
    errMsg: cw("Z3_get_error_msg", "string", ["number", "number"]),
  };
}
function apiContext(api, timeoutMs = 30000) {
  const cfg = api.mkConfig();
  api.setParam(cfg, "timeout", String(timeoutMs));
  const ctx = api.mkContext(cfg);
  api.delConfig(cfg);
  // NULL handler: without it Z3's default error handler calls exit(1), which
  // surfaces as a thrown ExitStatus. With it, errors only set the error code.
  api.setErrorHandler(ctx, 0);
  return ctx;
}

try {
  const z3 = await freshInstance([]);
  const missing = ["_Z3_eval_smtlib2_string", "ccall", "cwrap", "UTF8ToString"].filter((k) => typeof z3[k] !== "function");
  check("api-exports-present", missing.length === 0, "missing: " + missing.join(", "));
  const api = apiBind(z3);

  // Gate A1: state persists across separate eval calls.
  const ctx = apiContext(api);
  api.evalSmt2(ctx, "(declare-const x Int)");
  api.evalSmt2(ctx, "(assert (> x 5))");
  const a1 = api.evalSmt2(ctx, "(check-sat)");
  check("api-incremental-session", a1.trim() === "sat", a1);

  // Gate A2: push/pop.
  api.evalSmt2(ctx, "(push)");
  api.evalSmt2(ctx, "(assert false)");
  const a2u = api.evalSmt2(ctx, "(check-sat)");
  api.evalSmt2(ctx, "(pop)");
  const a2s = api.evalSmt2(ctx, "(check-sat)");
  check("api-push-pop", a2u.trim() === "unsat" && a2s.trim() === "sat", `push: ${a2u} pop: ${a2s}`);

  // Gate A3: CLI and API agree on the same transcripts.
  let parity = true, parityDetail = "";
  for (const c of CASES) {
    const cli = await uiRun(c.smt2);
    const pctx = apiContext(api);
    const viaApi = api.evalSmt2(pctx, c.smt2);
    api.delContext(pctx);
    const verdict = (o) => (/(^|\n)unsat\b/.test(o) ? "unsat" : /(^|\n)sat\b/.test(o) ? "sat" : "?");
    if (verdict(cli) !== verdict(viaApi)) { parity = false; parityDetail += `${c.name}: cli=${verdict(cli)} api=${verdict(viaApi)}\n`; }
  }
  check("api-cli-parity", parity, parityDetail);

  // Gate A4: error path is detectable and non-fatal.
  const before = api.errCode(ctx);
  const errOut = api.evalSmt2(ctx, "(assert (bogus))");
  const code = api.errCode(ctx);
  const msg = code ? api.errMsg(ctx, code) : "";
  const usable = api.evalSmt2(ctx, "(check-sat)").trim() === "sat";
  check("api-error-path", before === 0 && code !== 0 && msg.length > 0 && usable,
    `code=${code} msg=${msg} errOut=${errOut} usable=${usable}`);

  // Gate A5: no quadratic growth — 400 exchanges in one context.
  const stamps = [];
  const t0 = Date.now();
  for (let i = 0; i < 400; i++) {
    const s = Date.now();
    api.evalSmt2(ctx, `(declare-const y${i} Int)(assert (> y${i} ${i}))(check-sat)`);
    stamps.push(Date.now() - s);
  }
  const total = Date.now() - t0;
  const med = (a) => a.slice().sort((x, y) => x - y)[Math.floor(a.length / 2)];
  const mFirst = med(stamps.slice(0, 100)), mLast = med(stamps.slice(-100));
  console.log(`INFO api 400 exchanges: ${total}ms total, median first100=${mFirst}ms last100=${mLast}ms`);
  check("api-timing-flat", total < 5000 && mLast <= mFirst + 5,
    `total=${total}ms first100=${mFirst}ms last100=${mLast}ms`);

  api.delContext(ctx);
} catch (e) {
  check("api-gates", false, e.stack || String(e));
}

// Gate 5: payload budget.
const gz = gzipSync(wasmBinary, { level: 9 }).length;
console.log(`INFO gzipped wasm: ${(gz / 1048576).toFixed(2)} MB`);
check("gzip-budget<=14MB", gz <= 14 * 1048576);

console.log(`INFO glue mentions instantiateStreaming: ${glue.includes("instantiateStreaming")} (harmless if gates passed)`);

process.exit(failures ? 1 : 0);
