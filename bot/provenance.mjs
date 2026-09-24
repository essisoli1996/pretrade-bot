// Launch provenance: who launched a town token, from which post, when, and where its trading fees go.
// Source: musepad's own directory (musepad.lol/api/tokens), which records every launch it deployed with the request post,
// the launching muse, the fee wallet it wrote on-chain, and the time. Facts, not verdicts: two tokens sharing a ticker is
// described as what it is (a retry by the same launcher, or another launcher), never called "fake".

const lc = (a) => String(a ?? "").toLowerCase();
const ZERO = /^0x0{40}$|^0x0{36}dead$/i;

/** musepad directory items → one record per contract, indexed by address and by upper-case symbol (oldest first). */
export function indexLaunches(items) {
  const byAddr = new Map(), bySymbol = new Map();
  for (const it of items ?? []) {
    const address = lc(it?.contractAddress);
    if (!/^0x[0-9a-f]{40}$/.test(address) || byAddr.has(address)) continue;
    const post = Number(String(it.sourceThreadUrl ?? "").match(/\/p\/(\d+)/)?.[1]) || null;
    const rec = {
      address, symbol: String(it.symbol ?? "").trim(), name: String(it.name ?? "").trim(),
      launcher: it.launchedBy?.handle ?? null, wallet: lc(it.wallet) || null, custodial: !!it.paypal,
      launchedAt: Date.parse(it.launchedAt ?? "") || null, post, channel: it.platform ?? null,
      launchpad: it.launchpad ?? null, platform: it.sourcePlatform ?? null,
    };
    byAddr.set(address, rec);
    const k = rec.symbol.toUpperCase();
    if (!bySymbol.has(k)) bySymbol.set(k, []);
    bySymbol.get(k).push(rec);
  }
  for (const list of bySymbol.values()) list.sort((a, b) => (a.launchedAt ?? Infinity) - (b.launchedAt ?? Infinity));
  return { byAddr, bySymbol, size: byAddr.size };
}

/** Where the creator fees of a launch go. `code` is eth_getCode of the fee wallet ("0x" for a plain wallet);
 *  `tokenSymbol` is what symbol() answers at that address, when it is a token musepad didn't launch. */
export function feeRecipient(rec, reg, code, tokenSymbol = null) {
  if (!rec) return null;
  if (rec.custodial) return { kind: "custodial", text: "fees go to a wallet musepad holds for the launcher (paid out off-chain via PayPal): the launcher can't move them on-chain" };
  const w = rec.wallet;
  if (!w) return { kind: "unknown", text: "fee wallet not recorded" };
  if (ZERO.test(w)) return { kind: "burn", text: "fees go to a burn address: nobody collects them" };
  if (w === rec.address) return { kind: "self", text: "fees go to the token's own contract: probably nobody can collect them" };
  const token = reg?.byAddr?.get(w) ?? (tokenSymbol ? { symbol: tokenSymbol, address: w } : null);
  if (token) return { kind: "token-contract", token, text: `fees go to the $${token.symbol} token contract (${w.slice(0, 6)}…${w.slice(-4)}), not a wallet: likely a pasted contract address, and fees sent there are probably stuck` };
  if (typeof code !== "string") return { kind: "wallet?", text: `fees go to ${w.slice(0, 6)}…${w.slice(-4)}` };
  if (code === "0x" || code.toLowerCase().startsWith("0xef0100")) return { kind: "wallet", text: `fees go to the launcher's wallet ${w.slice(0, 6)}…${w.slice(-4)}` };
  return { kind: "contract", text: `fees go to a contract (${w.slice(0, 6)}…${w.slice(-4)}), e.g. a treasury or splitter: check what it does before trusting fee claims` };
}

const ago = (ms, now) => {
  const h = (now - ms) / 36e5;
  return h < 1 ? `${Math.max(1, Math.round(h * 60))}m ago` : h < 48 ? `${Math.round(h)}h ago` : `${Math.round(h / 24)}d ago`;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/** How the other contracts with the same ticker relate to this one. */
export function siblingsOf(rec, reg) {
  const all = reg?.bySymbol?.get(rec.symbol.toUpperCase()) ?? [];
  return all.filter((x) => x.address !== rec.address).map((x) => ({
    ...x,
    relation: x.launcher && rec.launcher && x.launcher === rec.launcher ? "same-launcher" : "other-launcher",
    earlier: (x.launchedAt ?? Infinity) < (rec.launchedAt ?? Infinity),
  }));
}

/** One or two lines for a token read: who launched it, and what shares its ticker. */
export function provenanceLines(rec, reg, fee, { now = Date.now(), board = "musebook.me" } = {}) {
  if (!rec) return [];
  const lines = [`🧾 launched ${rec.launchedAt ? ago(rec.launchedAt, now) : ""} by ${rec.launcher ?? "an unnamed muse"} via musepad${rec.post ? ` (${board}/p/${rec.post})` : ""}${fee ? `; ${fee.text}` : ""}.`.replace("launched  by", "launched by")];
  const sib = siblingsOf(rec, reg);
  if (sib.length) {
    const same = sib.filter((s) => s.relation === "same-launcher"), other = sib.filter((s) => s.relation === "other-launcher");
    const parts = [];
    if (same.length) parts.push(`${same.length} more by the same launcher (${same.slice(0, 2).map((s) => short(s.address)).join(", ")}), likely retries`);
    if (other.length) parts.push(`${other.length} by other launchers: ${other.slice(0, 2).map((s) => `${short(s.address)} by ${s.launcher ?? "?"}${s.earlier ? ", earlier" : ""}`).join("; ")}`);
    lines.push(`same ticker $${rec.symbol} on musepad: ${parts.join("; ")}. match the address, not the name.`);
  }
  return lines;
}

/** "@pretrade real <TICKER>": every Robinhood Chain contract using the ticker, with the facts that tell them apart.
 *  `market` is DexScreener's view: [{ address, liq, trades, created }]. */
export function tickerReport(symbol, reg, market, fees = new Map(), { now = Date.now(), board = "musebook.me" } = {}) {
  const sym = symbol.replace(/^\$/, "").toUpperCase();
  const launches = reg?.bySymbol?.get(sym) ?? [];
  const rows = new Map();
  for (const l of launches) rows.set(l.address, { address: l.address, launch: l, liq: 0, trades: 0 });
  for (const m of market ?? []) { const r = rows.get(m.address) ?? { address: m.address, launch: reg?.byAddr?.get(m.address) ?? null, liq: 0, trades: 0 }; r.liq = m.liq ?? 0; r.trades = m.trades ?? 0; r.created = m.created ?? null; rows.set(m.address, r); }
  const list = [...rows.values()];
  if (!list.length) return { found: 0, lines: [`no contract on Robinhood Chain trades or launched as $${sym} that i can see.`] };
  const firstAt = (r) => r.launch?.launchedAt ?? r.created ?? Infinity;
  const first = list.reduce((a, b) => (firstAt(b) < firstAt(a) ? b : a));
  const deepest = list.reduce((a, b) => (b.liq > a.liq ? b : a));
  list.sort((a, b) => b.liq - a.liq || firstAt(a) - firstAt(b));
  const lines = [`${list.length} contract${list.length === 1 ? "" : "s"} use $${sym} on Robinhood Chain:`];
  for (const r of list.slice(0, 5)) {
    const tags = [r === deepest && r.liq > 0 ? "most liquid" : null, r === first && list.length > 1 ? "first" : null].filter(Boolean);
    const who = r.launch ? `launched by ${r.launch.launcher ?? "?"} ${r.launch.launchedAt ? ago(r.launch.launchedAt, now) : ""}${r.launch.post ? ` (${board}/p/${r.launch.post})` : ""}` : "not a musepad launch";
    const fee = fees.get(r.address);
    lines.push(`• ${r.address}${tags.length ? ` [${tags.join(", ")}]` : ""}: $${Math.round(r.liq).toLocaleString("en-US")} liquidity, ${r.trades} trades 24h, ${who.replace(/ +\(/, " (").trim()}${fee && fee.kind !== "wallet" ? `; ${fee.text}` : ""}.`);
  }
  if (list.length > 5) lines.push(`…and ${list.length - 5} more.`);
  const launchers = new Set(list.map((r) => r.launch?.launcher ?? null));
  if (list.length > 1 && launchers.size === 1 && !launchers.has(null)) lines.push(`all ${list.length} were launched by ${[...launchers][0]}: likely retries of one launch, not copies.`);
  else if (list.length > 1) lines.push(`same name is not same token: take the address from the project's own launch post.`);
  return { found: list.length, first: first.address, deepest: deepest.address, lines };
}

/** A new launch that reuses a ticker already in town: the facts worth posting, or null when it is not news
 *  (the same launcher retrying, or the existing token is dead). */
export function reuseAlert(rec, reg, market, fee, { minLiquidityUsd = 5000, board = "musebook.me" } = {}) {
  // earlier tokens with this ticker: musepad's own launches, plus anything else trading on the chain (launched elsewhere)
  const prior = siblingsOf(rec, reg).filter((s) => s.earlier);
  for (const m of market ?? []) {
    if (m.address === rec.address || prior.some((x) => x.address === m.address) || reg?.byAddr?.has(m.address)) continue;
    if (m.created && rec.launchedAt && m.created >= rec.launchedAt) continue;
    prior.push({ address: m.address, launcher: "a launch outside musepad", relation: "other-launcher", earlier: true });
  }
  const liqOf = (a) => market?.find((m) => m.address === a)?.liq ?? 0;
  const live = prior.filter((p) => liqOf(p.address) >= minLiquidityUsd);
  const others = live.filter((p) => p.relation === "other-launcher");
  const stuck = fee && ["token-contract", "self", "burn"].includes(fee.kind);
  if (!others.length && !stuck) return null;
  const lines = [`🧾 new $${rec.symbol}: ${rec.address}, launched by ${rec.launcher ?? "?"} via musepad${rec.post ? ` (${board}/p/${rec.post})` : ""}.`];
  if (others.length) {
    const o = others.sort((a, b) => liqOf(b.address) - liqOf(a.address))[0];
    lines.push(`this is not the $${rec.symbol} already trading: ${o.address} (by ${o.launcher ?? "?"}, $${Math.round(liqOf(o.address)).toLocaleString("en-US")} liquidity). same ticker, different contract.`);
  }
  if (stuck) lines.push(`fee note: ${fee.text}.`);
  lines.push(`facts from musepad's own launch record. if you meant the other one, match the address.`);
  return lines;
}

/** Keeps the musepad directory in memory, refreshed at most every `everyMs`. */
export function makeProvenance({ http, rpc = null, everyMs = 10 * 60_000, now = () => Date.now() }) {
  let reg = indexLaunches([]), at = 0, seen = new Set();
  const codeCache = new Map();
  async function refresh(force = false) {
    if (!force && reg.size && now() - at < everyMs) return reg;
    const items = [];
    for (let page = 1; page <= 60; page++) {
      const r = await http(`https://musepad.lol/api/tokens?sort=new&page=${page}&pageSize=100`);
      const got = r?.json?.items;
      if (!Array.isArray(got)) { if (page === 1) return reg; break; } // keep the last good directory on a failed read
      items.push(...got);
      if (!got.length || page >= (r.json.totalPages ?? page)) break;
    }
    if (items.length) { reg = indexLaunches(items); at = now(); }
    return reg;
  }
  const symCache = new Map();
  /** symbol() at an address, when it is an ERC-20 (null for wallets and non-token contracts). */
  async function symbolAt(addr) {
    if (!rpc || !addr) return null;
    if (symCache.has(addr)) return symCache.get(addr);
    const r = await rpc("eth_call", [{ to: addr, data: "0x95d89b41" }, "latest"]).catch(() => null);
    let sym = null;
    const hex = typeof r?.result === "string" ? r.result.slice(2) : "";
    if (hex.length >= 192) { const len = parseInt(hex.slice(64, 128), 16); if (len > 0 && len <= 32) sym = Buffer.from(hex.slice(128, 128 + len * 2), "hex").toString("utf8").replace(/[^\x20-\x7e]/g, "") || null; }
    else if (hex.length === 64) sym = Buffer.from(hex, "hex").toString("utf8").replace(/\0+$/, "").replace(/[^\x20-\x7e]/g, "") || null;
    if (r) symCache.set(addr, sym);
    return sym;
  }
  async function codeAt(addr) {
    if (!rpc || !addr) return null;
    if (codeCache.has(addr)) return codeCache.get(addr);
    const r = await rpc("eth_getCode", [addr, "latest"]).catch(() => null);
    const code = typeof r?.result === "string" ? r.result : null;
    if (code !== null) codeCache.set(addr, code);
    return code;
  }
  async function feeOf(rec) {
    const code = await codeAt(rec.wallet);
    const isContract = typeof code === "string" && code !== "0x" && !code.toLowerCase().startsWith("0xef0100");
    return feeRecipient(rec, reg, code, isContract ? await symbolAt(rec.wallet) : null);
  }
  return {
    refresh,
    registry: () => reg,
    async lookup(address) {
      await refresh();
      const rec = reg.byAddr.get(lc(address)) ?? null;
      if (!rec) return null;
      return { rec, fee: await feeOf(rec) };
    },
    feeOf,
    /** Launches not seen before (the first call only primes, so a restart never reports old launches). */
    async fresh() {
      await refresh(true);
      const all = [...reg.byAddr.values()];
      if (!seen.size) { seen = new Set(all.map((r) => r.address)); return []; }
      const out = all.filter((r) => !seen.has(r.address));
      for (const r of out) seen.add(r.address);
      return out;
    },
    prime(addresses) { for (const a of addresses ?? []) seen.add(lc(a)); },
    seen: () => [...seen],
  };
}
