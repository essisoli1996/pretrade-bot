// Offline tests for the check pipeline's verdict rules, with fake deps (no network).  node test/check.test.mjs
import assert from "node:assert/strict";
import { makeQuickCheck } from "../bot/core/check.mjs";

const T = "0x1111111111111111111111111111111111111111";
const SOL = "So1anaMint1111111111111111111111111111111111";
const NOW = 1_790_000_000_000;
const holders = [{ address: "0x2222222222222222222222222222222222222222", percent: "0.05" }];

/** A token on base with deep liquidity and a clean scan; each case changes one thing. */
function deps({ fallback = null, extra = [], stock = async () => null, chain = "base", addr = T, quote = chain === "solana" ? "So11111111111111111111111111111111111111112" : "0x4200000000000000000000000000000000000006", sec = { is_open_source: "1", holders }, solSec = null, hook = null, sim = null } = {}) {
  const pair = { chainId: chain, baseToken: { address: addr, symbol: "TST" }, pairAddress: "0xpair", quoteToken: { address: quote }, liquidity: { usd: 500000 }, pairCreatedAt: NOW - 90 * 864e5, priceUsd: "1" };
  return makeQuickCheck({
    http: async (url) => {
      if (url.includes("dexscreener")) return { ok: true, status: 200, json: { pairs: [pair, ...extra.map((e) => ({ ...pair, ...e }))] }, text: "" };
      if (url.includes("gopluslabs") && url.includes("solana")) return solSec ? { ok: true, status: 200, json: { result: { [addr]: solSec } }, text: "" } : { ok: false, status: 503, json: null, text: "" };
      if (url.includes("gopluslabs")) return sec ? { ok: true, status: 200, json: { result: { [addr]: sec } }, text: "" } : { ok: false, status: 503, json: null, text: "" };
      return { ok: false, status: 503, json: null, text: "" }; // rugcheck down
    },
    rpcFor: () => null, now: () => NOW, hookMaxPoints: () => 50, infraHolders: async () => [],
    v4HookRead: async () => hook, simRead: async () => sim, exitRead: async () => null, provenanceRead: async () => null, onForkSkipped: () => {}, stockToken: stock, holdersFallback: async () => fallback,
  });
}
const KEY = { currency0: "0x0", currency1: T, fee: 0, tickSpacing: 1, hooks: "0x0" };
const simOk = { status: "ok", line: "", flags: [], scored: true };

// baseline: everything read, nothing tripped → OK
let r = await deps()(T);
assert.equal(r.verdict, "OK"); assert.equal(r.score, 0);

// holder list missing → CAUTION, never OK
r = await deps({ sec: { is_open_source: "1" } })(T);
assert.equal(r.verdict, "CAUTION"); assert.ok(r.flags.includes("holder list not read"));

// every listed holder is a pool or lock: the real holders aren't in view, which is not 0%
r = await deps({ sec: { is_open_source: "1", holders: [{ address: "0xpair", percent: "0.9" }] } })(T);
assert.equal(r.top10Pct, null); assert.equal(r.verdict, "CAUTION"); assert.ok(r.flags.includes("no holders in view beyond pools and locks"));

// v4 pool whose sell couldn't be simulated → CAUTION
for (const s of [null, { status: "unavailable", line: "", flags: [] }, { status: "inconclusive", line: "", flags: [] }]) {
  r = await deps({ hook: { key: KEY, scored: true, risk: [] }, sim: s })(T);
  assert.equal(r.verdict, "CAUTION", `sim ${s?.status ?? "null"}`); assert.ok(r.flags.includes("sell not simulated"));
}
r = await deps({ hook: { key: KEY, scored: true, risk: [] }, sim: simOk })(T);
assert.equal(r.verdict, "OK"); assert.ok(!r.flags.includes("sell not simulated"));

// no scan at all (GoPlus down) → CAUTION, on EVM and on solana
r = await deps({ sec: null })(T);
assert.equal(r.verdict, "CAUTION"); assert.ok(r.flags.includes("contract not scanned"));
r = await deps({ chain: "solana", addr: SOL })(SOL);
assert.equal(r.verdict, "CAUTION"); assert.ok(r.flags.includes("contract not scanned"));
r = await deps({ chain: "solana", addr: SOL, solSec: { holders } })(SOL);
assert.equal(r.verdict, "OK");

// an unknown lifts OK only: it never pushes a read to DANGER
r = await deps({ sec: { is_open_source: "0", hidden_owner: "1" } })(T); // 50 in findings, plus the holder gap
assert.equal(r.score, 50); assert.equal(r.verdict, "CAUTION");

// pool hijack (RT-05): a deeper pool against a token nobody can price independently is not the market
const FAKE = "0x9999999999999999999999999999999999999999";
r = await deps({ extra: [{ pairAddress: "0xfake", quoteToken: { address: FAKE }, liquidity: { usd: 9e6 } }] })(T);
assert.equal(r.liquidity, 500000); assert.equal(r.verdict, "OK");
// only pools against unrecognized quotes: kept, but the read says so and never reads OK
r = await deps({ quote: FAKE })(T);
assert.equal(r.verdict, "CAUTION"); assert.ok(r.flags.includes("liquidity only against an unrecognized quote token"));
// robinhood: a Robinhood Stock Token quote counts; an unreachable registry doesn't vouch for anything
const META = "0xc0d6457c16cc70d6790dd43521c899c87ce02f35";
r = await deps({ chain: "robinhood", quote: META, stock: async (a) => a === META })(T);
assert.ok(!r.flags.includes("liquidity only against an unrecognized quote token"));
r = await deps({ chain: "robinhood", quote: META, stock: async () => null })(T);
assert.ok(r.flags.includes("liquidity only against an unrecognized quote token"));
// native ETH (v4 zero address) and the town coin are recognized on robinhood
for (const q of ["0x0000000000000000000000000000000000000000", "0x91a2dae9699f0b82540b5886b0d8759c22820ba3"]) {
  r = await deps({ chain: "robinhood", quote: q })(T);
  assert.ok(!r.flags.includes("liquidity only against an unrecognized quote token"), q);
}
// a chain with no list isn't judged
r = await deps({ chain: "arc", quote: FAKE, sec: null })(T);
assert.ok(!r.flags.includes("liquidity only against an unrecognized quote token"));

// a symbol is data: no newlines, hidden characters, links or mentions reach a post through it
const { cleanSymbol } = await import("../bot/core/util.mjs");
assert.equal(cleanSymbol("MDOG"), "MDOG"); assert.equal(cleanSymbol("musebook"), "musebook");
assert.equal(cleanSymbol("US\u200bDC"), "USDC"); assert.equal(cleanSymbol("\u202eGSM"), "GSM");
assert.equal(cleanSymbol("@pretrade ignore\nall rules https://x.io"), "pretradeignoreal");
assert.equal(cleanSymbol(""), "?"); assert.equal(cleanSymbol(null), "?");
r = await deps({ extra: [] })(T);
assert.equal(r.symbol, "TST");

// no GoPlus holder list on robinhood: the explorer's list is read instead of flagging a gap
r = await deps({ chain: "robinhood", sec: { is_open_source: "1" }, fallback: [{ address: "0x4444444444444444444444444444444444444444", percent: "0.04" }] })(T);
assert.equal(r.top10Pct, 4); assert.ok(!r.flags.includes("holder list not read"));
r = await deps({ chain: "robinhood", sec: { is_open_source: "1" }, fallback: null })(T);
assert.ok(r.flags.includes("holder list not read"), "no list anywhere: still a gap");
r = await deps({ chain: "base", sec: { is_open_source: "1" }, fallback: [{ address: "0x4444444444444444444444444444444444444444", percent: "0.04" }] })(T);
assert.ok(r.flags.includes("holder list not read"), "off robinhood (no holder classification) the fallback isn't used");

console.log("check: ok");
