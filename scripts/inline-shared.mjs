// x402 Cloud uploads each service's index.ts on its own (no imports), so shared code is inlined.
// Copies x402/_shared/v4.ts between the "BEGIN shared:v4" / "END shared:v4" markers of the services that use it.
//   node scripts/inline-shared.mjs          write the copies
//   node scripts/inline-shared.mjs --check  fail if any copy is out of date (runs in npm test)
import { readFileSync, writeFileSync } from "node:fs";

const SERVICES = ["token-check", "exit-check"];
const src = readFileSync(new URL("../x402/_shared/v4.ts", import.meta.url), "utf8").replace("export const V4 =", "const V4 =").trimEnd();
const BEGIN = "// ── BEGIN shared:v4 ──", END = "// ── END shared:v4 ──";
const ANCHOR = "// ───────────────────────────────────── end shared core ─────────────────────────────────────";
let stale = 0;
for (const svc of SERVICES) {
  const file = new URL(`../x402/${svc}/index.ts`, import.meta.url);
  const cur = readFileSync(file, "utf8");
  const b = cur.indexOf(BEGIN), e = cur.indexOf(END);
  const next = b >= 0 && e > b ? cur.slice(0, b) + src + cur.slice(e + END.length) : cur.replace(ANCHOR, () => ANCHOR + "\n\n" + src);
  if (next === cur) continue;
  if (process.argv.includes("--check")) { console.error(`x402/${svc}/index.ts is out of date: run node scripts/inline-shared.mjs`); stale++; }
  else { writeFileSync(file, next); console.log(`updated x402/${svc}/index.ts`); }
}
process.exit(stale ? 1 : 0);
