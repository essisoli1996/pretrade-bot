// Offline tests for the check pipeline's verdict rules, with fake deps (no network).  node test/check.test.mjs
import assert from "node:assert/strict";
import { makeQuickCheck } from "../bot/core/check.mjs";

const T = "0x1111111111111111111111111111111111111111";
const SOL = "So1anaMint1111111111111111111111111111111111";
const NOW = 1_790_000_000_000;
const holders = [{ address: "0x2222222222222222222222222222222222222222", percent: "0.05" }];

/** A token on base with deep liquidity and a clean scan; each case changes one thing. */
function deps({ chain = "base", addr = T, sec = { is_open_source: "1", holders }, solSec = null, hook = null, sim = null } = {}) {
  const pair = { chainId: chain, baseToken: { address: addr, symbol: "TST" }, pairAddress: "0xpair", liquidity: { usd: 500000 }, pairCreatedAt: NOW - 90 * 864e5, priceUsd: "1" };
  return makeQuickCheck({
    http: async (url) => {
      if (url.includes("dexscreener")) return { ok: true, status: 200, json: { pairs: [pair] }, text: "" };
      if (url.includes("gopluslabs") && url.includes("solana")) return solSec ? { ok: true, status: 200, json: { result: { [addr]: solSec } }, text: "" } : { ok: false, status: 503, json: null, text: "" };
      if (url.includes("gopluslabs")) return sec ? { ok: true, status: 200, json: { result: { [addr]: sec } }, text: "" } : { ok: false, status: 503, json: null, text: "" };
      return { ok: false, status: 503, json: null, text: "" }; // rugcheck down
    },
    rpcFor: () => null, now: () => NOW, hookMaxPoints: () => 50, infraHolders: async () => [],
    v4HookRead: async () => hook, simRead: async () => sim, exitRead: async () => null, provenanceRead: async () => null, onForkSkipped: () => {},
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

console.log("check: ok");
