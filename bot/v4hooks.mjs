// Uniswap v4 hook inspection. Every musepad launch trades in a v4 pool, and a v4 pool can carry a "hook":
// arbitrary code that runs inside every swap. A malicious hook can quote one price and settle another.
// What a hook is ALLOWED to do is encoded in the low 14 bits of its address, so reading it is free and exact.
// Everything here is read-only chain data: the pool key comes from the PoolManager's Initialize event and is
// verified by re-hashing it into the pool id, so a spoofed event from another contract cannot fake a key.
// Zero dependencies.

// ───────────── keccak256 (pure JS, only a handful of hashes per check, so BigInt lanes are fast enough) ─────────────
const RC = [
  0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
  0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
  0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
  0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
];
const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
const M64 = (1n << 64n) - 1n;
const rotl = (x, r) => (r === 0 ? x : ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M64);

function keccakF(s) {
  for (let round = 0; round < 24; round++) {
    const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
    for (let x = 0; x < 5; x++) { const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[y + x] ^= d; }
    const b = new Array(25);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
    for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[y + x] = b[y + x] ^ (~b[y + ((x + 1) % 5)] & M64 & b[y + ((x + 2) % 5)]);
    s[0] ^= RC[round];
  }
}

/** keccak256 of a Uint8Array, as 0x-hex. */
export function keccak256(bytes) {
  const rate = 136;
  const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
  padded.set(bytes);
  padded[bytes.length] ^= 0x01;
  padded[padded.length - 1] ^= 0x80;
  const s = new Array(25).fill(0n);
  for (let off = 0; off < padded.length; off += rate) {
    for (let i = 0; i < rate / 8; i++) {
      let lane = 0n;
      for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
      s[i] ^= lane;
    }
    keccakF(s);
  }
  let out = "0x";
  for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out += Number((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0");
  return out;
}
const utf8 = (t) => new TextEncoder().encode(t);
const hexBytes = (h) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((b) => parseInt(b, 16)));

// ───────────── v4 constants, straight from v4-core (Hooks.sol, LPFeeLibrary.sol, PoolManager events) ─────────────
export const INIT_TOPIC = keccak256(utf8("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"));
const DYNAMIC_FEE = 0x800000;
const ZERO = "0x0000000000000000000000000000000000000000";

/** bit → permission, from Hooks.sol. "delta" permissions let the hook change how much the swapper gets. */
export const PERMISSIONS = [
  [13, "beforeInitialize"], [12, "afterInitialize"],
  [11, "beforeAddLiquidity"], [10, "afterAddLiquidity"], [9, "beforeRemoveLiquidity"], [8, "afterRemoveLiquidity"],
  [7, "beforeSwap"], [6, "afterSwap"], [5, "beforeDonate"], [4, "afterDonate"],
  [3, "beforeSwapReturnsDelta"], [2, "afterSwapReturnsDelta"], [1, "afterAddLiquidityReturnsDelta"], [0, "afterRemoveLiquidityReturnsDelta"],
];
export function permissionsOf(hook) {
  const bits = Number(BigInt(hook) & 0x3fffn);
  return PERMISSIONS.filter(([b]) => bits & (1 << b)).map(([, name]) => name);
}

// EIP-1967 slots and the EIP-1167 clone prefix
const IMPL_SLOT = "0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc";
const BEACON_SLOT = "0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50";
const CLONE_PREFIX = "0x363d3d373d3d3d363d73";

const word = (hex, i) => hex.slice(2 + 64 * i, 2 + 64 * (i + 1));
const wordAddr = (w) => "0x" + w.slice(24).toLowerCase();
const signed24 = (w) => { const v = parseInt(w.slice(-6), 16); return v >= 0x800000 ? v - 0x1000000 : v; };
const pad32 = (hex) => hex.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const int32word = (v) => (v >= 0 ? v.toString(16).padStart(64, "0") : (BigInt(v) + (1n << 256n)).toString(16));

/** PoolId = keccak256(abi.encode(PoolKey)). Used to prove the key we read belongs to this pool. */
export function poolIdOf(key) {
  const enc = pad32(key.currency0) + pad32(key.currency1) + key.fee.toString(16).padStart(64, "0") + int32word(key.tickSpacing) + pad32(key.hooks);
  return keccak256(hexBytes(enc));
}

/** Decodes a PoolManager Initialize log. Returns null unless the key re-hashes to the pool id in the log. */
export function keyFromLog(log) {
  if (!log?.topics || log.topics.length < 4 || String(log.topics[0]).toLowerCase() !== INIT_TOPIC) return null;
  const data = String(log.data ?? "");
  if (data.length < 2 + 64 * 3) return null;
  const key = {
    currency0: wordAddr(log.topics[2].slice(2)), currency1: wordAddr(log.topics[3].slice(2)),
    fee: parseInt(word(data, 0).slice(-6), 16), tickSpacing: signed24(word(data, 1)), hooks: wordAddr(word(data, 2)),
  };
  if (poolIdOf(key) !== String(log.topics[1]).toLowerCase()) return null;
  return { ...key, poolManager: String(log.address ?? "").toLowerCase(), block: parseInt(log.blockNumber ?? "0x0", 16) };
}

export function makeV4Hooks({ http, rpcUrl, known = {}, baselineToken = null, gapMs = 150 }) {
  const memo = {}; // used when the caller has no state object to cache into
  // the public Robinhood RPC rate-limits hard: space calls out and back off on 429 instead of reading it as "no data"
  let last = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function rpc(method, params) {
    for (let attempt = 0; ; attempt++) {
      const wait = last + gapMs - Date.now(); if (wait > 0) await sleep(wait);
      last = Date.now();
      const r = await http(rpcUrl, { jsonrpc: "2.0", id: 1, method, params });
      const j = r.json ?? { error: { code: r.status, message: `HTTP ${r.status}` } };
      const limited = r.status === 429 || j.error?.code === 429 || /too many requests|rate limit/i.test(j.error?.message ?? "");
      if (!limited || attempt >= 4) return j;
      await sleep(Math.min(8000, 800 * 2 ** attempt));
    }
  }

  async function blockAt(tsSec) {
    const head = parseInt((await rpc("eth_blockNumber", [])).result, 16);
    if (!Number.isFinite(head)) return null;
    let lo = 0, hi = head;
    for (let i = 0; i < 40 && lo < hi; i++) {
      const mid = Math.floor((lo + hi) / 2);
      const b = (await rpc("eth_getBlockByNumber", ["0x" + mid.toString(16), false])).result;
      if (!b) return null;
      if (parseInt(b.timestamp, 16) < tsSec) lo = mid + 1; else hi = mid;
    }
    return { block: lo, head };
  }

  /** Finds the pool key for a v4 pool id. Tries the whole chain in one query, then walks forward from the pair's birth. */
  async function poolKey(poolId, createdAtMs, state) {
    const id = poolId.toLowerCase();
    const cache = state ? (state.v4pools = state.v4pools ?? {}) : (memo.pools = memo.pools ?? {});
    if (cache[id]) return cache[id];
    const pick = (logs) => { for (const l of logs ?? []) { const k = keyFromLog(l); if (k) return k; } return null; };
    let key = null;
    const all = await rpc("eth_getLogs", [{ topics: [INIT_TOPIC, id], fromBlock: "0x0", toBlock: "latest" }]);
    memo.lastError = all.error ? String(all.error.message ?? all.error.code).slice(0, 100) : null;
    if (!all.error) key = pick(all.result);
    else if (createdAtMs) {
      const at = await blockAt(Math.floor(createdAtMs / 1000) - 3600);
      if (at) {
        let step = 50000;
        for (let start = at.block, calls = 0; start <= at.head && calls < 25 && !key; calls++) {
          const end = Math.min(at.head, start + step - 1);
          const r = await rpc("eth_getLogs", [{ topics: [INIT_TOPIC, id], fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) }]);
          if (r.error) { if (step > 1000) { step = Math.floor(step / 5); continue; } break; }
          key = pick(r.result);
          start = end + 1;
        }
      }
    }
    if (key) {
      cache[id] = key; // a pool key never changes
      const ids = Object.keys(cache);
      if (ids.length > 500) delete cache[ids[0]];
    }
    return key;
  }

  /** What the hook contract itself looks like: does it exist, can it be swapped out, does someone own it. */
  async function hookContract(hook) {
    const code = (await rpc("eth_getCode", [hook, "latest"])).result;
    if (typeof code !== "string") return { known: false };
    if (code === "0x") return { known: true, hasCode: false };
    const lc = code.toLowerCase();
    const clone = lc.startsWith(CLONE_PREFIX) ? "0x" + lc.slice(CLONE_PREFIX.length, CLONE_PREFIX.length + 40) : null;
    const impl = await rpc("eth_getStorageAt", [hook, IMPL_SLOT, "latest"]);
    const beacon = await rpc("eth_getStorageAt", [hook, BEACON_SLOT, "latest"]);
    const owner = await rpc("eth_call", [{ to: hook, data: "0x8da5cb5b" }, "latest"]);
    const slotAddr = (r) => (typeof r.result === "string" && /^0x0*[1-9a-f]/i.test(r.result) ? wordAddr(pad32(r.result)) : null);
    const ownerAddr = typeof owner.result === "string" && owner.result.length >= 66 ? wordAddr(owner.result.slice(2, 66)) : null;
    return {
      known: true, hasCode: true, clone,
      upgradeable: !!(slotAddr(impl) || slotAddr(beacon)), implementation: slotAddr(impl), beacon: slotAddr(beacon),
      owner: ownerAddr && ownerAddr !== ZERO ? ownerAddr : null,
    };
  }

  /** The launchpad's own hook: the hook on the bot's own token pool. A standard launchpad hook is not a red flag. */
  async function baselineHooks(pairsFor, state) {
    const out = new Map(Object.entries(known).map(([a, label]) => [a.toLowerCase(), label]));
    if (!baselineToken) return out;
    const store = state ?? memo;
    const b = store.v4baseline;
    if (b?.hook && Date.now() - b.t < 7 * 864e5) { out.set(b.hook, b.label); return out; }
    for (const p of (await pairsFor(baselineToken)).filter(isV4)) {
      const key = await poolKey(p.pairAddress, p.pairCreatedAt, state);
      if (key?.hooks && key.hooks !== ZERO) {
        const label = `standard launch hook (same as $${p.baseToken?.symbol ?? "own token"})`;
        store.v4baseline = { hook: key.hooks, label, t: Date.now() };
        out.set(key.hooks, label);
        break;
      }
    }
    return out;
  }

  /**
   * Full read for one v4 pool. `pair` is a DexScreener pair whose pairAddress is the 32-byte pool id.
   * Returns null when this is not a v4 pool or the key can't be read (never guess on missing data).
   */
  async function inspect(pair, standard, state) {
    if (!isV4(pair)) return null;
    const key = await poolKey(pair.pairAddress, pair.pairCreatedAt, state);
    if (!key) return { poolId: pair.pairAddress, readable: false, why: memo.lastError ?? "no Initialize event found for this pool id" };
    const perms = key.hooks === ZERO ? [] : permissionsOf(key.hooks);
    const dynamicFee = key.fee === DYNAMIC_FEE;
    const base = { poolId: pair.pairAddress.toLowerCase(), readable: true, hook: key.hooks, perms, dynamicFee, feePct: dynamicFee ? null : key.fee / 1e4, poolManager: key.poolManager };
    if (key.hooks === ZERO) return { ...base, none: true, risk: [], points: 0 };
    const label = standard.get(key.hooks) ?? null;
    const contract = await hookContract(key.hooks);
    const risk = [];
    let points = 0;
    const add = (text, pts) => { risk.push({ text, pts }); points += pts; };
    const swapDelta = perms.includes("beforeSwapReturnsDelta") || perms.includes("afterSwapReturnsDelta");
    if (!label) {
      if (swapDelta) add("custom v4 hook can change swap amounts", 30);
      if (dynamicFee && perms.includes("beforeSwap")) add("custom v4 hook sets the swap fee per trade", 20);
      if (contract.upgradeable && (swapDelta || dynamicFee)) add("that hook is upgradeable", 20);
      if (contract.known && contract.hasCode === false) add("hook address has no code", 10);
    }
    return { ...base, standard: label, contract, risk, points };
  }

  return { inspect, baselineHooks, poolKey, hookContract };
}

/** DexScreener lists v4 pools by their 32-byte pool id instead of a 20-byte pair address. */
export const isV4 = (p) => /^0x[0-9a-fA-F]{64}$/.test(String(p?.pairAddress ?? ""));

/** One line for humans. */
export function hookLine(h) {
  if (!h) return null;
  if (!h.readable) return "🪝 v4 hook: pool key not readable right now, hook not checked.";
  if (h.none) return "🪝 v4 hook: none. plain pool, no custom code runs in swaps.";
  const short = `${h.hook.slice(0, 6)}…${h.hook.slice(-4)}`;
  const powers = h.perms.filter((p) => /Swap/.test(p));
  const fee = h.dynamicFee ? "fee set by the hook per trade" : `fee ${h.feePct}%`;
  const c = h.contract ?? {};
  const upg = c.known ? (c.upgradeable ? "upgradeable" : "not upgradeable") : "upgradeability unknown";
  if (h.standard) return `🪝 v4 hook ${short}: ${h.standard}. ${fee}, ${upg}.`;
  return `🪝 v4 hook ${short}: custom. swap powers: ${powers.length ? powers.join(", ") : "none"}. ${fee}, ${upg}${c.owner ? `, owned by ${c.owner.slice(0, 6)}…${c.owner.slice(-4)}` : ""}.`;
}
