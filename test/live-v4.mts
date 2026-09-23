// Runs the token-check and exit-check handlers locally against the REAL Robinhood Chain and DexScreener,
// without x402 payment. For checking the v4 hook read and trade simulation before a deploy.
// Run: npx tsx test/live-v4.mts [address ...]
import tokenCheck from "../x402/token-check/index.ts";
import exitCheck from "../x402/exit-check/index.ts";

const targets = process.argv.slice(2).length ? process.argv.slice(2) : [
  "0x85a574f2ff0795685f58d1d7b0d4b51f148ac489", // PRINTER: custom hook
  "0x4e9c619228dc53f9b57c7357208863d256b9cd69", // BILL: standard musepad hook
  "0x6245e67affa44a23077f0ea7f981a8dc743a0c47", // FRONG: no hook
  "0x91a2dae9699f0b82540b5886b0d8759c22820ba3", // musebook
];
for (const a of targets) {
  const t0 = Date.now();
  const r: any = await (await tokenCheck(new Request(`https://local/token-check?address=${a}&chain=robinhood`))).json();
  const t1 = Date.now();
  const e: any = await (await exitCheck(new Request(`https://local/exit-check?address=${a}&chain=robinhood&usd=500`))).json();
  console.log(`$${r.market?.symbol ?? "?"} ${a}: ${r.verdict} ${r.riskScore} [${(r.flags ?? []).map((f: any) => f.code).join(", ")}] (${t1 - t0} ms)`);
  console.log(`  hook: ${r.v4?.hook ? `${r.v4.hook.address ?? "none"} ${r.v4.hook.standard ?? "custom"} ${JSON.stringify(r.v4.hook.permissions)}` : "n/a"}`);
  console.log(`  simulation: ${JSON.stringify(r.v4?.simulation ?? null)}`);
  console.log(`  exit-check: ${e.exitability}, $500 → ${JSON.stringify(e.position)} (${Date.now() - t1} ms)`);
}
