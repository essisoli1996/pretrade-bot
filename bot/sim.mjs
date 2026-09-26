// Real buy-and-sell simulation on the token's own Uniswap v4 pool. Nothing is sent and nothing is paid:
// a small contract (bot/Sim.sol) is placed at a scratch address with an eth_call state override, given some of
// the quote currency, and asked to buy the token and sell it straight back through the real PoolManager, hook and
// token code, pinned to one block. What comes back is measured, not estimated.
//
// Known ways a simulation lies, and what this does about each:
// - the simulator itself breaks (RPC quirk, unsupported override): a failed sell is re-run on a known-good control
//   token in the same block; if the control fails too, the result is thrown away, not reported.
// - anti-bot cooldowns block a sell in the same block as the buy: a failed sell is re-run as a plain holder
//   (balance set directly, no buy first). If the holder can sell, it's a cooldown, not a honeypot.
// - a fresh pool with thin liquidity: not simulated below a liquidity floor.
// - a result is only true for that block: the block number travels with every result.
// - a token that recognises the simulator (a fixed scratch address, a known tx.origin, the gas price of 0 an eth_call
//   uses by default) could let the simulation sell and block real buyers: the simulator and sender addresses are new
//   for every block, derived from a secret per-process seed, and every call carries the chain's real gas price.
//
// Zero dependencies. Rebuild the runtime after editing bot/Sim.sol with solc 0.8.26 (evm cancun, via-ir,
// optimizer 200 runs, no metadata hash) and paste the deployed bytecode into bot/sim-runtime.mjs.
import { keccak256 } from "./v4hooks.mjs";
import { SIM_RUNTIME } from "./sim-runtime.mjs";

const ZERO = "0x0000000000000000000000000000000000000000";
const DYNAMIC_FEE = 0x800000;
const SEL_ROUND_TRIP = "0x7f70be11";
const SEL_BALANCE_OF = "0x70a08231";
const SEL_DECIMALS = "0x313ce567";

const hex32 = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
const addr32 = (a) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const hexBytes = (h) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((b) => parseInt(b, 16)));
const toHexQty = (v) => "0x" + BigInt(v).toString(16);

export function encodeRoundTrip(pm, key, tokenIs0, quoteIn, sellOnly, sellAmount) {
  return SEL_ROUND_TRIP + addr32(pm) + addr32(key.currency0) + addr32(key.currency1) + hex32(key.fee) + hex32(key.tickSpacing) +
    addr32(key.hooks) + hex32(tokenIs0 ? 1 : 0) + hex32(quoteIn) + hex32(sellOnly ? 1 : 0) + hex32(sellAmount);
}

/** Decodes Sim.Result: (uint8 stage, uint256 tokenOwed, uint256 tokenGot, uint256 quoteOwed, uint256 quoteBack, bytes revertData). */
export function decodeResult(ret) {
  const h = ret.replace(/^0x/, "");
  const w = (i) => BigInt("0x" + h.slice(64 * i, 64 * (i + 1)));
  const base = Number(w(0)) / 32; // offset of the tuple
  const at = (i) => w(base + i);
  const bytesOff = base + Number(at(5)) / 32;
  const len = Number(w(bytesOff));
  const revertData = "0x" + h.slice(64 * (bytesOff + 1), 64 * (bytesOff + 1) + len * 2);
  return { stage: Number(at(0)), tokenOwed: at(1), tokenGot: at(2), quoteOwed: at(3), quoteBack: at(4), revertData };
}

/** Short human reason from revert bytes: Error(string), a v4 wrapped error, or the raw selector. */
export function revertReason(data) {
  const h = String(data ?? "").replace(/^0x/, "");
  if (!h) return "reverted without a reason";
  if (h.startsWith("08c379a0") && h.length >= 8 + 128) {
    const len = parseInt(h.slice(8 + 64, 8 + 128), 16);
    const txt = new TextDecoder().decode(hexBytes(h.slice(8 + 128, 8 + 128 + len * 2)));
    return txt.slice(0, 80) || "reverted";
  }
  return KNOWN_ERRORS[h.slice(0, 8)] ?? `error 0x${h.slice(0, 8)}`;
}
const KNOWN_ERRORS = {
  "5212cba1": "the token delivered less than it owed the pool (transfer tax or blocked transfer)",
  "90bfb865": "the pool's hook reverted",
  "7c9c6e8f": "price limit already exceeded",
  "486aa307": "pool not initialized",
};

/** Candidate storage slots for balanceOf[holder] across common ERC20 layouts, used when eth_createAccessList is missing. */
function candidateSlots(holder) {
  const out = [];
  for (let s = 0; s < 10; s++) {
    out.push(keccak256(hexBytes(addr32(holder) + hex32(s)))); // solidity mapping
    out.push(keccak256(hexBytes(hex32(s) + addr32(holder)))); // vyper mapping
  }
  out.push(keccak256(hexBytes(addr32(holder) + "52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00"))); // OZ v5 upgradeable
  out.push(keccak256(hexBytes(holder.replace(/^0x/, "").toLowerCase() + "0000000000000000" + "87a211a2"))); // solady
  return out;
}

/**
 * rpc(method, params) → JSON-RPC response object ({result} or {error}).
 * control: optional async () => ({ key, token, quoteIn }) for a known-good pool, used to validate a failed sell.
 * seed: secret the per-block simulator and sender addresses derive from (random per process; fixed only for recorded
 * test fixtures, so a replay asks the same questions).
 */
export function makeSim({ rpc, control = null, seed = null }) {
  const slotCache = new Map();
  const decCache = new Map();
  const secret = seed ?? Array.from(globalThis.crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const derive = (tag, block) => "0x" + keccak256(new TextEncoder().encode(`${secret}:${tag}:${block}`)).slice(-40);
  /** Simulator and sender addresses for one block: unpredictable, and different every block. */
  const actors = (block) => ({ sim: derive("sim", block), from: derive("from", block) });
  const gasCache = new Map();
  /** A real gas price for this block: twice its base fee, as a real transaction would pay (never 0: a token can tell an
   *  eth_call from a transaction by that, and never under the base fee, which the RPC refuses). */
  async function gasPrice(block) {
    if (!gasCache.has(block)) {
      const b = await rpc("eth_getBlockByNumber", [block, false]).catch(() => null);
      let base = null;
      try { base = BigInt(b?.result?.baseFeePerGas); } catch {}
      if (!base) { const r = await rpc("eth_gasPrice", []).catch(() => null); try { base = BigInt(r?.result); } catch {} }
      gasCache.clear(); gasCache.set(block, toHexQty((base && base > 0n ? base : 10n ** 9n) * 2n));
    }
    return gasCache.get(block);
  }

  async function call(to, data, block, overrides) {
    const { from } = actors(block);
    // the sender pays real gas, so it is given the ETH to cover it (and nothing else changes about it)
    const over = { ...overrides, [from]: { ...(overrides?.[from] ?? {}), balance: "0xc9f2c9cd04674edea40000000" } };
    return rpc("eth_call", [{ from, to, data, gas: "0x1c9c380", gasPrice: await gasPrice(block) }, block, over]);
  }

  async function decimals(token, block) {
    if (token === ZERO) return 18;
    if (decCache.has(token)) return decCache.get(token);
    const r = await call(token, SEL_DECIMALS, block, {});
    const d = typeof r.result === "string" && r.result.length > 2 ? Number(BigInt(r.result)) : null;
    if (d !== null && d <= 36) decCache.set(token, d);
    return d;
  }

  /** Finds the storage slot holding balanceOf[holder] by writing a marker and reading it back. */
  async function balanceSlot(token, holder, block) {
    const k = `${token}:${holder}`;
    if (slotCache.has(k)) return slotCache.get(k);
    const data = SEL_BALANCE_OF + addr32(holder);
    let keys = [];
    const al = await rpc("eth_createAccessList", [{ from: actors(block).from, to: token, data }, block]);
    for (const e of al.result?.accessList ?? []) if (String(e.address).toLowerCase() === token) keys.push(...(e.storageKeys ?? []));
    keys = [...new Set([...keys, ...candidateSlots(holder)])];
    const marker = 0x5117_5117_5117n;
    for (const slot of keys) {
      const r = await call(token, data, block, { [token]: { stateDiff: { [slot]: "0x" + hex32(marker) } } });
      if (typeof r.result === "string" && r.result.length > 2 && BigInt(r.result) === marker) { slotCache.set(k, slot); return slot; }
    }
    slotCache.set(k, null);
    return null;
  }

  /** Builds the override: Sim code at this block's simulator address, plus `amount` of `currency` in its balance. Null if it can't be funded. */
  async function funded(currency, amount, block) {
    const { sim } = actors(block);
    const o = { [sim]: { code: SIM_RUNTIME } };
    if (currency === ZERO) { o[sim].balance = toHexQty(amount); return o; }
    const slot = await balanceSlot(currency, sim, block);
    if (!slot) return null;
    o[currency] = { stateDiff: { [slot]: "0x" + hex32(amount) } };
    return o;
  }

  /** One round trip on one pool. sellOnly: fund the Sim with `amount` of the token and only sell. */
  async function roundTrip({ key, token, amount, sellOnly = false, block }) {
    const tokenIs0 = key.currency0 === token;
    const quote = tokenIs0 ? key.currency1 : key.currency0;
    const over = await funded(sellOnly ? token : quote, amount, block);
    if (!over) return { stage: -1, why: `couldn't find the balance slot of ${sellOnly ? "the token" : "the quote currency"}` };
    const r = await call(actors(block).sim, encodeRoundTrip(key.poolManager, key, tokenIs0, sellOnly ? 0n : amount, sellOnly, sellOnly ? amount : 0n), block, over);
    if (r.error) return { stage: -1, why: `eth_call failed: ${String(r.error.message ?? r.error.code).slice(0, 100)}` };
    try { return decodeResult(r.result); } catch { return { stage: -1, why: "unreadable simulator output" }; }
  }

  /**
   * Full read. key: v4 pool key incl. poolManager. token: lowercased token address.
   * quoteIn: amount of the quote currency to buy with (base units). Returns the raw legs; classify() judges them.
   */
  async function run({ key, token, quoteIn }) {
    const head = (await rpc("eth_blockNumber", [])).result;
    if (typeof head !== "string") return { ok: false, why: "no block number from the RPC" };
    const block = head;
    const main = await roundTrip({ key, token, amount: quoteIn, block });
    const out = { ok: true, block: parseInt(block, 16), quoteIn, main };
    if (main.stage !== 1) return out;
    // sell failed: is it the simulator, a cooldown, or the token?
    if (control) {
      try {
        const c = await control();
        if (c) out.control = await roundTrip({ key: c.key, token: c.token, amount: c.quoteIn, block });
      } catch (e) { out.control = { stage: -1, why: String(e).slice(0, 100) }; }
    }
    if (main.tokenOwed > 0n) out.holder = await roundTrip({ key, token, amount: main.tokenOwed, sellOnly: true, block });
    return out;
  }

  /**
   * Exact-size quote on the live pool, plus a small reference trade in the same block for the mid price.
   * side "buy": spend `amount` of the quote currency. side "sell": sell `amount` of the token (as a plain holder).
   */
  async function plan({ key, token, side, amount, refAmount }) {
    const head = (await rpc("eth_blockNumber", [])).result;
    if (typeof head !== "string") return { ok: false, why: "no block number from the RPC" };
    const sell = side === "sell";
    const big = await roundTrip({ key, token, amount, sellOnly: sell, block: head });
    const small = await roundTrip({ key, token, amount: refAmount, sellOnly: sell, block: head });
    const got = (r) => (sell ? (r.stage === 2 ? r.quoteBack : null) : r.stage >= 1 ? r.tokenGot : null);
    return {
      ok: true, block: parseInt(head, 16), side: sell ? "sell" : "buy", amountIn: amount, out: got(big), refIn: refAmount, refOut: got(small),
      stage: big.stage, why: big.why ?? null, revertData: big.revertData ?? null,
      // a buy whose immediate sell-back reverts is a trap even if the buy itself works
      sellBackFails: !sell && big.stage === 1, roundTripBack: !sell && big.stage === 2 ? big.quoteBack : null,
    };
  }

  /**
   * Measured exit size: the biggest single sell (token base units) whose price impact stays under `target`, found by
   * selling as a plain holder on the live pool at one block. Counts only what the pool really pays: for a Doppler v4
   * multicurve that is the in-range liquidity, not the out-of-range, single-sided part a full-position figure includes.
   */
  async function exitSize({ key, token, refIn, guessIn, target = 0.02 }) {
    const head = (await rpc("eth_blockNumber", [])).result;
    if (typeof head !== "string") return null;
    const sellOut = async (amount) => { const r = await roundTrip({ key, token, amount, sellOnly: true, block: head }); return r.stage === 2 ? r.quoteBack : null; };
    const r = await searchExit({ sellOut, refIn, guessIn, target });
    return r ? { ...r, block: parseInt(head, 16) } : null;
  }

  return { run, plan, roundTrip, exitSize, balanceSlot, decimals, block: async () => (await rpc("eth_blockNumber", [])).result };
}

/**
 * Searches for the largest sell whose price impact (average price vs a small reference sell in the same block, so pool
 * and hook fees cancel out) stays under `target`. sellOut(amount) → quote received, or null when the sell reverts.
 * Pure apart from sellOut, so it is unit tested. Returns { amountIn, impact, atLeast, calls } or null (no reference).
 * atLeast: even the largest size tried stayed under target, so the real exit size is bigger than amountIn.
 */
export async function searchExit({ sellOut, refIn, guessIn, target = 0.02, steps = 8, maxGrow = 4 }) {
  let calls = 0;
  const out = async (x) => { calls++; return sellOut(x); };
  const refOut = await out(refIn);
  if (!refOut || refOut <= 0n || refIn <= 0n) return null;
  const rateRef = Number((refOut * 10n ** 18n) / refIn) / 1e18;
  const probes = [{ x: refIn, imp: 0 }];
  const impactAt = async (x) => {
    const o = await out(x);
    const imp = o === null ? 1 : Math.max(0, 1 - Number((o * 10n ** 18n) / x) / 1e18 / rateRef);
    probes.push({ x, imp });
    return imp;
  };
  let lo = refIn, loImpact = 0, hi = guessIn > refIn ? guessIn : refIn * 10n;
  let hiImpact = await impactAt(hi);
  for (let g = 0; hiImpact < target && g < maxGrow; g++) { lo = hi; loImpact = hiImpact; hi *= 4n; hiImpact = await impactAt(hi); }
  const done = async (r) => {
    // the search assumes a bigger sell never costs less per token. A pool or hook that breaks that (a fee band, a sell
    // that reverts at one size and works at a bigger one) makes any single figure a guess: one more probe below the
    // answer, then every probe must rise with size, or the exit is reported as irregular instead of as a number.
    if (lo > refIn) { const mid = BigInt(Math.floor(Math.sqrt(Number(refIn) * Number(lo)))); if (mid > refIn && mid < lo) await impactAt(mid); }
    const sorted = [...probes].sort((a, b) => (a.x < b.x ? -1 : a.x > b.x ? 1 : 0));
    const irregular = sorted.some((p, i) => i > 0 && p.imp < sorted[i - 1].imp - 0.002);
    return { ...r, irregular, calls };
  };
  if (hiImpact < target) return done({ amountIn: hi, impact: hiImpact, atLeast: true });
  for (let i = 0; i < steps; i++) {
    const mid = BigInt(Math.floor(Math.sqrt(Number(lo) * Number(hi))));
    if (mid <= lo || mid >= hi) break;
    const m = await impactAt(mid);
    if (m < target) { lo = mid; loImpact = m; } else hi = mid;
  }
  return done({ amountIn: lo, impact: loImpact, atLeast: false });
}

/**
 * Turns an exact-size simulation into a trade plan. Pure, unit tested (and mirrored in x402/_shared/v4.ts).
 * volatilityPct: recent move in % (DexScreener m5 / h1), used to size slippage for the time between quote and inclusion.
 * Returns { verdict: GO | CAUTION | NO_GO, impactPct, slippagePct, minOutFraction, split, reasons[] }.
 */
export function planAdvice(res, { m5 = 0, h1 = 0, usd = null } = {}) {
  if (!res?.ok) return { verdict: "UNAVAILABLE", reasons: [res?.why ?? "no simulation"] };
  if (res.out === null || res.out === 0n) {
    const what = res.side === "sell" ? "the sell" : "the buy";
    return { verdict: "NO_GO", reasons: [`${what} reverted in simulation (${res.why ?? revertReason(res.revertData)})`] };
  }
  const reasons = [];
  let impact = 0;
  if (res.refOut && res.refOut > 0n && res.refIn > 0n) {
    // price per unit at size vs at the reference size, same block
    const atSize = Number((res.out * 10n ** 18n) / res.amountIn) / 1e18;
    const atRef = Number((res.refOut * 10n ** 18n) / res.refIn) / 1e18;
    impact = Math.max(0, 1 - atSize / atRef);
  }
  const impactPct = pct(impact);
  const vol = Math.max(Math.abs(m5 ?? 0), Math.abs(h1 ?? 0) / 3);
  const slippagePct = Math.round(Math.min(5, Math.max(0.5, 0.5 + 1.5 * vol)) * 10) / 10;
  const minOutFraction = 1 - slippagePct / 100;
  let verdict = "GO";
  if (res.sellBackFails) { verdict = "NO_GO"; reasons.push("the buy works but selling it straight back reverts: you could get in and not out"); }
  if (impactPct > 8) { verdict = "NO_GO"; reasons.push(`price impact ${impactPct}% at this size`); }
  else if (impactPct > 2) { if (verdict === "GO") verdict = "CAUTION"; reasons.push(`price impact ${impactPct}% at this size`); }
  if (res.roundTripBack !== null && res.amountIn > 0n) {
    const rt = pct(Math.max(0, 1 - Number((res.roundTripBack * 1_000_000n) / res.amountIn) / 1e6));
    if (rt >= 20 && verdict !== "NO_GO") { verdict = rt >= 50 ? "NO_GO" : "CAUTION"; reasons.push(`buying and selling back at this size loses ${rt}%`); }
  }
  // split so each piece stays near 1% impact (impact grows roughly linearly with size at these depths)
  const pieces = impactPct > 2 ? Math.min(10, Math.ceil(impactPct / 1)) : 1;
  const split = pieces > 1 ? { pieces, usdEach: usd ? Math.round((usd / pieces) * 100) / 100 : null, note: "a few blocks apart, re-quote each" } : null;
  if (!reasons.length) reasons.push("clean at this size");
  return { verdict, impactPct, slippagePct, minOutFraction, split, reasons };
}

const pct = (x) => Math.round(x * 1000) / 10;
const ratio = (a, b) => (b > 0n ? Number((a * 1_000_000n) / b) / 1_000_000 : null);

/**
 * Turns raw legs into flags. Pure, so it is unit tested.
 * Returns { status, line, flags: [{ text, pts, critical }], roundTripLossPct, buyTaxPct }.
 */
export function classify(res, { fee = null, sizeUsd = null, hasHook = false } = {}) {
  const size = sizeUsd ? `$${sizeUsd < 10 ? sizeUsd.toFixed(2) : Math.round(sizeUsd)}` : "a small";
  if (!res?.ok) return { status: "unavailable", line: `🧪 trade simulation unavailable (${res?.why ?? "no result"}).`, flags: [] };
  const m = res.main;
  if (m.stage === -1) return { status: "unavailable", line: `🧪 trade simulation unavailable (${m.why}).`, flags: [] };
  if (m.stage === 0) return { status: "buy-failed", line: `🧪 a simulated ${size} buy reverted (${revertReason(m.revertData)}), so buying and selling couldn't be tested. not scored.`, flags: [] };
  const buyTax = m.tokenOwed > 0n ? 1 - ratio(m.tokenGot, m.tokenOwed) : 0;
  const flags = [];
  const buyTaxPct = pct(Math.max(0, buyTax));
  if (buyTaxPct > 10) flags.push({ text: `buy tax ${Math.round(buyTaxPct)}% (simulated)`, pts: 15 });
  if (m.stage === 1) {
    const reason = revertReason(m.revertData);
    const c = res.control;
    if (c && c.stage !== 2) return { status: "inconclusive", line: `🧪 simulated sell failed, but so did a known-good control token in the same block, so the simulator is at fault. not scored.`, flags: [], buyTaxPct };
    const h = res.holder;
    if (h?.stage === 2) {
      flags.push({ text: "can't sell in the same block as buying (anti-bot cooldown)", pts: 15 });
      return { status: "cooldown", line: `🧪 simulated ${size} buy worked; selling in the same block reverted (${reason}), but a plain holder could sell. looks like an anti-bot cooldown, not a honeypot. block ${res.block}.`, flags, buyTaxPct };
    }
    if (h && h.stage >= 0 && h.stage < 2 && c?.stage === 2) {
      flags.push({ text: "sell reverted in simulation (honeypot)", pts: 100, critical: true });
      return { status: "honeypot", line: `🧪 simulated ${size} buy worked, but selling reverted (${reason}), for a fresh buyer and for a plain holder, while a control token sold fine in the same block. block ${res.block}.`, flags, buyTaxPct };
    }
    flags.push({ text: "sell failed in simulation (unconfirmed)", pts: 25 });
    return { status: "sell-failed", line: `🧪 simulated ${size} buy worked, but selling it back reverted (${reason}). couldn't run every cross-check, so this is scored as a warning, not a verdict. block ${res.block}.`, flags, buyTaxPct };
  }
  const back = ratio(m.quoteBack, res.quoteIn);
  const loss = Math.max(0, 1 - back);
  const lossPct = pct(loss);
  const expected = fee !== null && fee !== DYNAMIC_FEE ? pct((2 * fee) / 1e6) : null;
  if (lossPct >= 50) flags.push({ text: `simulated round trip loses ${Math.round(lossPct)}%`, pts: 100, critical: true });
  else if (lossPct >= 20) flags.push({ text: `simulated round trip loses ${Math.round(lossPct)}%`, pts: 40 });
  else if (lossPct >= 10) flags.push({ text: `simulated round trip loses ${Math.round(lossPct)}%`, pts: 20 });
  const feeNote = expected === null ? " incl. pool and hook fees"
    : hasHook && lossPct > expected + 0.5 ? ` (pool fee ~${expected}%, the rest goes to the pool's hook)`
    : ` (pool fees alone would be ~${expected}%)`;
  const taxNote = buyTaxPct > 1 ? `, ${buyTaxPct}% of the bought tokens never arrived (transfer tax)` : "";
  return { status: "ok", line: `🧪 simulated ${size} buy then sell on the real pool: ${lossPct}% round-trip cost${feeNote}${taxNote}. block ${res.block}.`, flags, roundTripLossPct: lossPct, buyTaxPct };
}
