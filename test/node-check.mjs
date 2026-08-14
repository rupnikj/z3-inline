// Acceptance gates for dist/z3-st.{js,wasm}. Run: node test/node-check.mjs
//
// Gates (any failure exits 1):
//   1. glue loads with wasmBinary and NEVER touches the network (fetch is sabotaged)
//   2. unsat case answers "unsat"
//   3. sat case answers "sat" and produces a model
//   4. arithmetic case solves a+b=10, a-b=4 -> a=7, b=3
//   5. gzipped wasm <= 14MB (artifact payload budget)
// Informational (printed, not a gate): whether callMain can be reused in one
// instance, or whether the artifact must re-create the module per query.
import { createRequire } from "node:module";
import { readFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const dist = join(dirname(fileURLToPath(import.meta.url)), "..", "dist");
const wasmBinary = readFileSync(join(dist, "z3-st.wasm"));
const glue = readFileSync(join(dist, "z3-st.js"), "utf8");

// Gate 1a: any network attempt by the glue must blow up loudly.
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

function runQuery(z3, out, smt2, extraArgs = []) {
  out.length = 0;
  z3.FS.writeFile("/in.smt2", smt2);
  z3.callMain(["-smt2", ...extraArgs, "/in.smt2"]);
  return out.join("\n");
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

// Gates 2-4, each on a fresh instance (the guaranteed-correct mode).
for (const c of CASES) {
  const out = [];
  try {
    const z3 = await freshInstance(out);
    const o = runQuery(z3, out, c.smt2);
    check(c.name, c.ok(o), o);
  } catch (e) {
    check(c.name, false, e.stack || String(e));
  }
}

// Informational: can one instance serve multiple queries?
try {
  const out = [];
  const z3 = await freshInstance(out);
  const first = runQuery(z3, out, CASES[0].smt2);
  const second = runQuery(z3, out, CASES[2].smt2);
  const reuseOk = CASES[0].ok(first) && CASES[2].ok(second);
  console.log(`INFO reuse-callMain-in-one-instance: ${reuseOk ? "WORKS" : "BROKEN (artifact must re-create per query)"}`);
  if (!reuseOk) console.log("INFO second-query output was:\n" + second);
} catch (e) {
  console.log("INFO reuse-callMain-in-one-instance: THROWS (artifact must re-create per query)");
  console.log("INFO " + (e.message || e));
}

// Gate 5: payload budget.
const gz = gzipSync(wasmBinary, { level: 9 }).length;
console.log(`INFO gzipped wasm: ${(gz / 1048576).toFixed(2)} MB`);
check("gzip-budget<=14MB", gz <= 14 * 1048576);

// Belt-and-braces: static scan for network probes reachable when wasmBinary is
// provided is impossible statically, but the sabotage above already proved it
// dynamically. Just record whether the strings exist at all.
console.log(`INFO glue mentions instantiateStreaming: ${glue.includes("instantiateStreaming")} (harmless if gates passed)`);

process.exit(failures ? 1 : 0);
