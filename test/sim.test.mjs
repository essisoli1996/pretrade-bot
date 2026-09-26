// Offline test for the trade-simulation judge (bot/sim.mjs): encoding, decoding and every verdict path.
// The contract itself was tested against a real v4 PoolManager on anvil (clean pool, honeypot, cooldown,
// 30% skim hook, native ETH pool, transfer-tax token, broken control); this covers the bot-side logic.
// Run: node test/sim.test.mjs
import { encodeRoundTrip, decodeResult, revertReason, classify, searchExit, makeSim } from "../bot/sim.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };
const w = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");

const key = { currency0: "0x" + "11".repeat(20), currency1: "0x" + "22".repeat(20), fee: 3000, tickSpacing: -60, hooks: "0x" + "00".repeat(20) };
const data = encodeRoundTrip("0x" + "33".repeat(20), key, true, 10n ** 18n, false, 0n);
check(data.startsWith("0x7f70be11") && data.length === 10 + 64 * 10, "roundTrip calldata: selector + 10 static words");
check(data.slice(10 + 64 * 4, 10 + 64 * 5) === w(-60), "negative tick spacing is two's complement");

// Result tuple: offset 0x20, then stage, tokenOwed, tokenGot, quoteOwed, quoteBack, bytes offset (0xc0), len, data
const errString = "08c379a0" + w(32) + w(8) + Buffer.from("honeypot").toString("hex").padEnd(64, "0");
const blob = (stage, a, b, c, d, rev = "") => "0x" + w(32) + w(stage) + w(a) + w(b) + w(c) + w(d) + w(192) + w(rev.length / 2) + rev.padEnd(Math.ceil(rev.length / 64) * 64, "0");
const r = decodeResult(blob(1, 100, 95, 0, 0, errString));
check(r.stage === 1 && r.tokenOwed === 100n && r.tokenGot === 95n, "decodes stage and amounts");
check(revertReason(r.revertData) === "honeypot", "decodes Error(string)");
check(/less than it owed/.test(revertReason("0x5212cba1")), "names v4 CurrencyNotSettled");

const ONE = 10n ** 18n;
const ok = (back) => ({ ok: true, block: 7, quoteIn: ONE, main: { stage: 2, tokenOwed: 100n, tokenGot: 100n, quoteBack: back } });
check(classify(ok((ONE * 994n) / 1000n), { fee: 3000 }).flags.length === 0, "0.6% round trip on a 0.3% pool: no flag");
check(classify(ok((ONE * 85n) / 100n), { fee: 3000 }).flags[0]?.pts === 20, "15% loss: +20");
check(classify(ok((ONE * 75n) / 100n)).flags[0]?.pts === 40, "25% loss: +40");
check(classify(ok((ONE * 49n) / 100n)).flags[0]?.critical === true, "51% loss: critical");

const failed = (extra) => ({ ok: true, block: 7, quoteIn: ONE, main: { stage: 1, tokenOwed: 100n, tokenGot: 100n, revertData: "0x" + errString }, ...extra });
check(classify(failed({ control: { stage: 2 }, holder: { stage: 1 } })).status === "honeypot", "sell fails for buyer and holder, control fine: honeypot");
check(classify(failed({ control: { stage: 2 }, holder: { stage: 1 } })).flags[0].critical, "honeypot is critical");
check(classify(failed({ control: { stage: 2 }, holder: { stage: 2 } })).status === "cooldown", "holder can sell: cooldown, not honeypot");
const inc = classify(failed({ control: { stage: 1 }, holder: { stage: 1 } }));
check(inc.status === "inconclusive" && inc.flags.length === 0, "control fails too: inconclusive, never scored");
const noCtl = classify(failed({ holder: { stage: 1 } }));
check(noCtl.status === "sell-failed" && !noCtl.flags[0].critical, "no control available: warning only, not a honeypot verdict");
check(classify({ ok: true, block: 7, quoteIn: ONE, main: { stage: 0, revertData: "0x" } }).flags.length === 0, "buy reverts: not scored");
check(classify({ ok: false, why: "x" }).status === "unavailable", "no result: unavailable");
const taxed = classify({ ok: true, block: 7, quoteIn: ONE, main: { stage: 2, tokenOwed: 100n, tokenGot: 80n, quoteBack: ONE / 2n } });
check(taxed.buyTaxPct === 20 && taxed.flags.some((f) => /buy tax 20%/.test(f.text)), "20% of bought tokens missing: buy tax flag");

// measured exit size: a constant-product pool with a 1% fee; 2% impact sits at x = 0.02·X/0.98
{
  const X = 1_000_000n * ONE, Y = 50n * ONE;
  const pool = (reserve) => async (x) => (Y * x * 99n) / ((reserve + x) * 100n);
  const r = await searchExit({ sellOut: pool(X), refIn: ONE, guessIn: 100_000n * ONE });
  const want = (0.02 * 1_000_000) / 0.98, got = Number(r.amountIn / ONE);
  check(r && !r.atLeast && got <= want && got > want * 0.95, `exit search lands just under the 2% size (${got} vs ${Math.round(want)})`);
  check(r.impact < 0.02 && r.calls <= 15, `fees cancel out against the reference sell, ${r.calls} simulated sells`);
  // the full-position guess overstates tenfold (Doppler multicurve): the search still finds the in-range size
  const thin = await searchExit({ sellOut: pool(X / 10n), refIn: ONE, guessIn: 20_000n * ONE });
  check(Math.abs(Number(thin.amountIn / ONE) - want / 10) < want / 10 * 0.05, "a guess 10x too big is searched down to the real exit");
  // a guess too small grows until it crosses 2%
  const grown = await searchExit({ sellOut: pool(X), refIn: ONE, guessIn: 1000n * ONE });
  check(Math.abs(Number(grown.amountIn / ONE) - want) < want * 0.05, "a guess too small grows until impact crosses 2%");
  // a sell that reverts above some size counts as full impact
  const capped = await searchExit({ sellOut: async (x) => (x > 5000n * ONE ? null : pool(X)(x)), refIn: ONE, guessIn: 100_000n * ONE });
  check(Number(capped.amountIn / ONE) <= 5000, "sizes that revert are never reported as an exit");
  check((await searchExit({ sellOut: async () => null, refIn: ONE, guessIn: ONE * 10n })) === null, "no reference sell: no exit figure");
}

// the simulator can't be recognised (RT-20/24): new addresses every block, a real gas price on every call
{
  const calls = [];
  let head = 100;
  const rpc = async (method, params) => {
    calls.push({ method, params });
    if (method === "eth_blockNumber") return { result: "0x" + (head++).toString(16) };
    if (method === "eth_gasPrice") return { result: "0x989680" };
    if (method === "eth_createAccessList") return { result: { accessList: [] } };
    return { result: "0x" };
  };
  const key = { poolManager: "0x" + "44".repeat(20), currency0: "0x0000000000000000000000000000000000000000", currency1: "0x" + "11".repeat(20), fee: 0, tickSpacing: 60, hooks: "0x0000000000000000000000000000000000000000" };
  const simA = makeSim({ rpc }), simB = makeSim({ rpc });
  await simA.run({ key, token: key.currency1, quoteIn: 1000n });
  await simA.run({ key, token: key.currency1, quoteIn: 1000n });
  await simB.run({ key, token: key.currency1, quoteIn: 1000n });
  const ethCalls = calls.filter((c) => c.method === "eth_call");
  const froms = ethCalls.map((c) => c.params[0].from), tos = ethCalls.map((c) => c.params[0].to);
  check(ethCalls.length === 3 && new Set(froms).size === 3 && new Set(tos).size === 3, "a new simulator and sender every block, and per process");
  check(!froms.concat(tos).some((a) => /5117/.test(a)), "no fixed 0x5117… address left");
  check(ethCalls.every((c) => c.params[0].gasPrice === "0x989680"), "every eth_call carries the chain's gas price");
  check(ethCalls.every((c) => c.params[2][c.params[0].from]?.balance), "the sender is funded for that gas");
  const s1 = makeSim({ rpc, seed: "fixture" }), s2 = makeSim({ rpc, seed: "fixture" });
  calls.length = 0; head = 7; await s1.run({ key, token: key.currency1, quoteIn: 1n });
  const first = calls.find((c) => c.method === "eth_call").params[0];
  calls.length = 0; head = 7; await s2.run({ key, token: key.currency1, quoteIn: 1n });
  check(calls.find((c) => c.method === "eth_call").params[0].from === first.from, "a fixed seed (recorded fixtures) asks the same questions");
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
