// Assemble dist/z3-artifact.html from dist/z3-st.{js,wasm} + the template.
// Run: node tools/make-artifact.mjs [--reuse=true]
//
// Instance reuse is OFF by default: callMain re-entry keeps the previous run's
// input file in Z3's global argv state ("WARNING: input file was already
// specified") and can answer for the stale file. Fresh instance per run
// (~1s) is always correct.
//
// Pipeline: gzip wasm -> base64 -> inline as text/plain script; glue inlined
// as a classic script (defines global createZ3). The page never fetches.
import { readFileSync, writeFileSync } from "node:fs";
import { gzipSync } from "node:zlib";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const root = join(dirname(fileURLToPath(import.meta.url)), "..");
const dist = join(root, "dist");
const MAX_HTML = 20 * 1048576;
const reuse = process.argv.includes("--reuse=true");

const wasm = readFileSync(join(dist, "z3-st.wasm"));
let glue = readFileSync(join(dist, "z3-st.js"), "utf8");
let info = { z3Version: "unknown" };
try { info = JSON.parse(readFileSync(join(dist, "build-info.json"), "utf8")); } catch {}

// A literal "</script" anywhere in the glue would terminate our script tag.
// In JS string/regex context "<\/script" is byte-for-byte equivalent.
glue = glue.replace(/<\/script/gi, "<\\/script");

const gz = gzipSync(wasm, { level: 9 });
const b64 = gz.toString("base64");
const mb = (n) => (n / 1048576).toFixed(2) + "MB";

const html = readFileSync(join(root, "tools", "artifact-template.html"), "utf8")
  .replaceAll("__Z3_VERSION__", info.z3Version ?? "unknown")
  .replaceAll("__PAYLOAD_NOTE__", `${mb(wasm.length)} wasm, ${mb(gz.length)} gzipped, ${mb(b64.length)} base64`)
  .replaceAll("__REUSE_INSTANCE__", String(reuse))
  .replace("__WASM_B64__", () => b64)     // function form: payload may contain "$&" etc.
  .replace("__GLUE_JS__", () => glue);

for (const marker of ["__WASM_B64__", "__GLUE_JS__", "__Z3_VERSION__"]) {
  if (html.includes(marker)) { console.error(`FAIL: unreplaced marker ${marker}`); process.exit(1); }
}

const outPath = join(dist, "z3-artifact.html");
writeFileSync(outPath, html);
console.log(`z3-artifact.html: ${mb(html.length)} (wasm ${mb(wasm.length)} -> gz ${mb(gz.length)} -> b64 ${mb(b64.length)}, glue ${mb(glue.length)}) reuse=${reuse}`);
if (html.length > MAX_HTML) {
  console.error(`FAIL: artifact exceeds ${mb(MAX_HTML)} budget`);
  process.exit(1);
}
