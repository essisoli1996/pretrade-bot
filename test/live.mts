// Runs the real handlers against the real upstream APIs (no payment involved: handlers are called directly).
// Used by the live-test workflow. Run locally with: npx tsx test/live.mts
import tokenCheck from "../x402/token-check/index.ts";
import exitCheck from "../x402/exit-check/index.ts";
import momentum from "../x402/momentum/index.ts";
import twinCheck from "../x402/twin-check/index.ts";
import batchCheck from "../x402/batch-check/index.ts";

const BONK = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const WETH = "0x4200000000000000000000000000000000000006";
const MUSEGRAM = "0x9cb595fbb3601dc0ef80e87921dc4ffd9307aba3";
const cases: [string, (r: Request) => Promise<Response>, string][] = [
  ["token-check solana BONK", tokenCheck, `?address=${BONK}`],
  ["token-check base WETH", tokenCheck, `?address=${WETH}`],
  ["token-check robinhood musegram", tokenCheck, `?address=${MUSEGRAM}&chain=robinhood`],
  ["exit-check solana BONK $5000", exitCheck, `?address=${BONK}&usd=5000`],
  ["exit-check robinhood musegram $500", exitCheck, `?address=${MUSEGRAM}&chain=robinhood&usd=500`],
  ["momentum solana BONK", momentum, `?address=${BONK}`],
  ["twin-check MUSEBOOK", twinCheck, `?symbol=MUSEBOOK`],
  ["batch-check solana", batchCheck, `?addresses=${BONK},So11111111111111111111111111111111111111112`],
];
let failed = 0;
for (const [name, fn, qs] of cases) {
  const res = await fn(new Request("https://local/x" + qs));
  const body: any = await res.json();
  const slim = JSON.stringify(body, (k, v) => (k === "disclaimer" || k === "model" || k === "note" ? undefined : Array.isArray(v) && v.length > 4 ? v.slice(0, 4) : v));
  console.log(`\n### ${name} → HTTP ${res.status}\n${slim.slice(0, 1100)}`);
  if (res.status !== 200) failed++;
}
console.log(`\n${failed ? "FAILED: " + failed : "ALL LIVE CASES RETURNED 200"}`);
