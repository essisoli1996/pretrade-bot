// The paid endpoints carry a TypeScript port of the bot's v4 checks (x402/_shared/v4.ts, inlined into
// token-check and exit-check). This keeps the two from drifting: same constants, same simulator bytecode,
// same verdict for the same simulated legs. Run: npx tsx test/x402-v4.test.mts
import { V4 } from "../x402/_shared/v4.ts";
// @ts-ignore  plain JS modules from the bot
import { classify as botClassify } from "../bot/sim.mjs";
// @ts-ignore
import { INIT_TOPIC, poolIdOf, permissionsOf } from "../bot/v4hooks.mjs";
// @ts-ignore
import { SIM_RUNTIME } from "../bot/sim-runtime.mjs";

let bad = 0;
const check = (ok: boolean, label: string) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

check(V4.INIT_TOPIC === INIT_TOPIC, "same Initialize topic");
check(V4.SIM_RUNTIME === SIM_RUNTIME, "same simulator bytecode as the bot");
const key = { currency0: "0x0000000000000000000000000000000000000000", currency1: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", fee: 500, tickSpacing: 10, hooks: "0x0000000000000000000000000000000000000000" };
check(V4.poolIdOf(key) === poolIdOf(key) && V4.poolIdOf(key) === "0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27", "same pool id (mainnet ETH/USDC v4)");
check(JSON.stringify(V4.permissionsOf("0x00000000000000000000000000000000000000cc")) === JSON.stringify(permissionsOf("0x00000000000000000000000000000000000000cc")), "same hook permission decoding");

const ONE = 10n ** 18n;
const leg = (stage: number, back = 0n, got = 100n) => ({ stage, tokenOwed: 100n, tokenGot: got, quoteBack: back, revertData: "0x" });
const cases: [string, any][] = [
  ["clean", { ok: true, block: 1, quoteIn: ONE, main: leg(2, (ONE * 994n) / 1000n) }],
  ["15% loss", { ok: true, block: 1, quoteIn: ONE, main: leg(2, (ONE * 85n) / 100n) }],
  ["25% loss", { ok: true, block: 1, quoteIn: ONE, main: leg(2, (ONE * 75n) / 100n) }],
  ["51% loss", { ok: true, block: 1, quoteIn: ONE, main: leg(2, (ONE * 49n) / 100n) }],
  ["buy tax 20%", { ok: true, block: 1, quoteIn: ONE, main: leg(2, ONE / 2n, 80n) }],
  ["buy reverts", { ok: true, block: 1, quoteIn: ONE, main: leg(0) }],
  ["honeypot", { ok: true, block: 1, quoteIn: ONE, main: leg(1), control: leg(2), holder: leg(1) }],
  ["cooldown", { ok: true, block: 1, quoteIn: ONE, main: leg(1), control: leg(2), holder: leg(2) }],
  ["broken control", { ok: true, block: 1, quoteIn: ONE, main: leg(1), control: leg(1), holder: leg(1) }],
  ["no control", { ok: true, block: 1, quoteIn: ONE, main: leg(1), holder: leg(1) }],
];
for (const [name, res] of cases) {
  const b = botClassify(res, { fee: 3000 });
  const x = V4.classify(res, 3000);
  const bPts = b.flags.reduce((s: number, f: any) => s + f.pts, 0), xPts = x.flags.reduce((s, f) => s + f.points, 0);
  const bCrit = b.flags.some((f: any) => f.critical), xCrit = x.flags.some((f) => f.severity === "critical");
  check(b.status === x.status && bPts === xPts && bCrit === xCrit, `${name}: bot ${b.status}/${bPts}${bCrit ? "!" : ""} = endpoint ${x.status}/${xPts}${xCrit ? "!" : ""}`);
}

const r = { verdict: "OK", riskScore: 0, confidence: "high", flags: [{ code: "X", severity: "low" as const, points: 5, detail: "" }] };
const merged = V4.merge(r, [{ code: "SIM_SELL_REVERTED", severity: "critical", points: 100, detail: "" }]);
check(merged.verdict === "DANGER" && merged.riskScore === 100 && merged.flags[0].code === "SIM_SELL_REVERTED", "merge: critical sim flag → DANGER, sorted first");
check(V4.merge(r, []) === r, "merge with nothing leaves the result untouched");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
