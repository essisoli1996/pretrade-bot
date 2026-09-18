// Offline smoke test: mocks upstream APIs so you can verify logic without network or payment.
// Run: npx tsx test/mock.test.mts
import tokenCheck from "../x402/token-check/index.ts";
import batchCheck from "../x402/batch-check/index.ts";
import momentum from "../x402/momentum/index.ts";
import twinCheck from "../x402/twin-check/index.ts";
import exitCheck from "../x402/exit-check/index.ts";

const GOOD = "0x1111111111111111111111111111111111111111";
const RUG = "0x2222222222222222222222222222222222222222";
const SOLGOOD = "DezXAZ8z7PnrnRJjz3wXBoRgixCa6xjnB7YaB1pPB263";
const SOLBAD = "BadMint1111111111111111111111111111111111111";
const SERIAL = "0x3333333333333333333333333333333333333333";

const pair = (addr: string, liq: number, ageH: number) => ({
  chainId: "base", dexId: "uniswap", url: "https://dexscreener.com/base/x", pairAddress: "0xpair",
  baseToken: { address: addr, name: "T", symbol: addr === GOOD ? "GOOD" : "RUG" },
  priceUsd: "1.2", marketCap: 5_000_000, liquidity: { usd: liq },
  volume: { h1: 40_000, h24: 300_000 }, priceChange: { m5: 1, h1: 9, h6: 14, h24: 30 },
  txns: { h1: { buys: 80, sells: 30 }, h24: { buys: 900, sells: 700 } },
  pairCreatedAt: Date.now() - ageH * 36e5,
});
const sec = (rug: boolean) => ({
  is_honeypot: rug ? "1" : "0", buy_tax: "0", sell_tax: rug ? "0.99" : "0.01", is_open_source: rug ? "0" : "1",
  is_mintable: rug ? "1" : "0", holder_count: "1200",
  holders: [{ address: "0xa", percent: rug ? "0.9" : "0.05", is_contract: 0, is_locked: 0 }],
  lp_holders: [{ address: "0x000000000000000000000000000000000000dEaD", percent: "0.98", is_locked: 1 }],
});

globalThis.fetch = (async (input: any) => {
  const u = String(input);
  if (u.includes("dex/search")) {
    const real = { ...pair(GOOD, 900_000, 300), info: { socials: [{ type: "twitter" }] } };
    const fake = pair(RUG, 4_000, 2);
    real.baseToken.symbol = fake.baseToken.symbol = "MUSEBOOK";
    real.chainId = fake.chainId = "robinhood";
    return new Response(JSON.stringify({ pairs: [fake, real] }));
  }
  if (u.includes("dexscreener") && u.includes("/solana/")) {
    const mk = (a: string, liq: number, ageH: number) => ({ ...pair(a, liq, ageH), chainId: "solana", baseToken: { address: a, name: "S", symbol: "S" } });
    const out = [];
    if (u.includes(SOLGOOD)) out.push(mk(SOLGOOD, 900_000, 20000));
    if (u.includes(SOLBAD)) out.push(mk(SOLBAD, 40_000, 3));
    return new Response(JSON.stringify(out));
  }
  if (u.includes("/solana/token_security")) {
    const a = u.split("contract_addresses=")[1];
    const bad = a === SOLBAD;
    const st = (v: boolean) => ({ authority: [], status: v ? "1" : "0" });
    return new Response(JSON.stringify({ code: 1, result: { [a]: {
      balance_mutable_authority: st(false), closable: st(false), freezable: st(bad), mintable: st(bad), metadata_mutable: st(true),
      default_account_state: "1", creators: [], holder_count: "1000",
      holders: [{ account: "x", percent: bad ? "0.7" : "0.08", is_locked: 0, tag: "" }] } } }));
  }
  if (u.includes("rugcheck")) {
    const bad = u.includes(SOLBAD);
    return new Response(JSON.stringify({ risks: bad ? [{ name: "Single holder ownership", description: "One wallet owns most supply", level: "danger", score: 9000 }] : [{ name: "Mutable metadata", level: "warn", score: 100 }], score_normalised: bad ? 80 : 7, lpLockedPct: bad ? 0 : 18.8 }));
  }
  if (u.includes("dexscreener")) {
    const out = [];
    if (u.toLowerCase().includes(SERIAL)) out.push(pair(SERIAL, 400_000, 900));
    if (u.toLowerCase().includes(GOOD)) out.push(pair(GOOD, 800_000, 2000));
    if (u.toLowerCase().includes(RUG)) out.push(pair(RUG, 3_000, 0.5));
    return new Response(JSON.stringify(out));
  }
  if (u.includes("gopluslabs")) {
    const a = u.split("contract_addresses=")[1].toLowerCase();
    const base = sec(a === RUG);
    return new Response(JSON.stringify({ code: 1, result: { [a]: a === SERIAL ? { ...base, honeypot_with_same_creator: "1", creator_address: "0xc" } : base } }));
  }
  return new Response("{}", { status: 500 });
}) as typeof fetch;

const assert = (c: boolean, m: string) => { if (!c) { console.error("FAIL:", m); process.exit(1); } console.log("ok  -", m); };
const j = async (r: Response) => ({ status: r.status, body: await r.json() as any });

const g = await j(await tokenCheck(new Request(`https://x/token-check?address=${GOOD}`)));
assert(g.status === 200 && g.body.verdict === "OK", `good token → OK (score ${g.body.riskScore})`);
const r = await j(await tokenCheck(new Request(`https://x/token-check?address=${RUG}`)));
assert(r.body.verdict === "DANGER" && r.body.flags[0].severity === "critical", `rug → DANGER (score ${r.body.riskScore}, ${r.body.flags.length} flags)`);
const e = await j(await tokenCheck(new Request("https://x/token-check?address=nope")));
assert(e.status === 400, "invalid address → 400 (caller not charged)");
const b = await j(await batchCheck(new Request("https://x/batch-check", { method: "POST", body: JSON.stringify({ addresses: [RUG, GOOD] }) })));
assert(b.body.count === 2 && b.body.safest === GOOD, "batch ranks safest first");
const m = await j(await momentum(new Request(`https://x/momentum?address=${GOOD}`)));
assert(m.status === 200 && ["UP", "STRONG_UP"].includes(m.body.signal), `momentum → ${m.body.signal} (${m.body.momentumScore})`);
const sg = await j(await tokenCheck(new Request(`https://x/token-check?address=${SOLGOOD}`)));
assert(sg.status === 200 && sg.body.chain === "solana" && sg.body.verdict === "OK", `solana blue chip auto-detected → OK (score ${sg.body.riskScore}; old pair so LP/holder flags are skipped)`);
const sb = await j(await tokenCheck(new Request(`https://x/token-check?address=${SOLBAD}`)));
const sbCodes = sb.body.flags.map((f: any) => f.code);
assert(sb.body.verdict === "DANGER" && sbCodes.includes("FREEZE_AUTHORITY") && sbCodes.includes("MINT_AUTHORITY"), `solana risky mint → DANGER (${sb.body.riskScore}): ${sbCodes.join(", ")}`);
const mix = await j(await tokenCheck(new Request(`https://x/token-check?address=${SOLGOOD}&chain=base`)));
assert(mix.status === 400, "solana mint with chain=base → 400");
const sr = await j(await tokenCheck(new Request(`https://x/token-check?address=${SERIAL}`)));
assert(sr.body.flags.some((f: any) => f.code === "CREATOR_HONEYPOT_HISTORY") && sr.body.creator.honeypotHistory === true, `creator with honeypot history is flagged (${sr.body.verdict}, ${sr.body.riskScore})`);
const ex = await j(await exitCheck(new Request(`https://x/exit-check?address=${SOLBAD}&usd=5000`)));
assert(ex.status === 200 && ex.body.position.estPriceImpactPct === 20 && ex.body.exitability === "HARD", `exit-check: $5k into $40k pool → ${ex.body.position.estPriceImpactPct}% impact, ${ex.body.exitability}, max 2% sell $${ex.body.maxSellUsd.impact2pct}`);
const ex2 = await j(await exitCheck(new Request(`https://x/exit-check?address=${RUG}&usd=100`)));
assert(ex2.body.exitability === "TRAPPED" && ex2.body.sellBlockedByContract === true, "exit-check: honeypot → TRAPPED");
const ex3 = await j(await exitCheck(new Request(`https://x/exit-check?address=${GOOD}&usd=-5`)));
assert(ex3.status === 400, "exit-check: bad usd → 400");
const bs = await j(await batchCheck(new Request(`https://x/batch-check?addresses=${SOLGOOD},${SOLBAD}`)));
assert(bs.body.chain === "solana" && bs.body.safest === SOLGOOD, "batch-check works on solana and ranks safest first");
const bm = await j(await batchCheck(new Request(`https://x/batch-check?addresses=${SOLGOOD},${GOOD}`)));
assert(bm.status === 400, "batch-check: mixed chains → 400");
const t = await j(await twinCheck(new Request(`https://x/twin-check?symbol=$musebook&chain=robinhood&address=${RUG}`)));
assert(t.body.likelyOriginal.address === GOOD && t.body.claim.verdict === "LIKELY_COPYCAT", `twin-check → original found, claimed address flagged copycat (confidence ${t.body.confidence})`);
const t2 = await j(await twinCheck(new Request("https://x/twin-check?symbol=")));
assert(t2.status === 400, "twin-check empty symbol → 400");
console.log("\nALL TESTS PASSED");
