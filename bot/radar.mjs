// Launch Radar — scores fresh $MUSEBOOK-paired launches from musepad on on-chain behaviour, not hype.
// Signals follow the 2026 literature on launch risk (MemeTrans / MELT): high-risk launches show fewer buyers,
// fewer but larger buys, early buyers taking a large share, and concentration hidden behind bundled wallets.
// Every scored launch is pre-registered with a kill line and re-checked at +1h, +6h and +24h.
import { readFileSync, writeFileSync, existsSync, mkdirSync } from "node:fs";
import { join } from "node:path";

const TRANSFER = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const ZERO = "0x0000000000000000000000000000000000000000";
const DEAD = new Set([ZERO, "0x000000000000000000000000000000000000dead"]);

export function makeRadar({ CFG, http, HERE }) {
  const RD = CFG.radar ?? {};
  const RPC = CFG.token.rpc;
  const BOARD = (CFG.boards ?? ["https://musebook.me"])[0];
  const DIR = join(HERE, "radar");
  const ENTRIES = join(DIR, "entries.json");
  const META = join(DIR, "meta.json");
  const n = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
  const load = (f, d) => (existsSync(f) ? JSON.parse(readFileSync(f, "utf8")) : d);
  const save = (f, v) => { if (!existsSync(DIR)) mkdirSync(DIR, { recursive: true }); writeFileSync(f, JSON.stringify(v, null, 1)); };

  let lastCall = 0;
  const sleep = (ms) => new Promise((r) => setTimeout(r, ms));
  async function rpc(method, params) {
    for (let attempt = 0; attempt < 7; attempt++) {
      const wait = lastCall + (RD.rpcGapMs ?? 150) - Date.now(); if (wait > 0) await sleep(wait);
      lastCall = Date.now();
      const r = await http(RPC, { jsonrpc: "2.0", id: 1, method, params });
      const j = r.json ?? {};
      const limited = r.status === 429 || j.error?.code === 429 || /too many requests|rate limit/i.test(j.error?.message ?? "");
      if (!limited) return j;
      await sleep(Math.min(20000, 1500 * 2 ** attempt)); // back off and retry: a 429 is not "no data"
    }
    return { error: { code: 429, message: "rate limited after retries" } };
  }
  async function rpcBatch(calls) {
    const wait = lastCall + (RD.rpcGapMs ?? 150) - Date.now(); if (wait > 0) await sleep(wait);
    lastCall = Date.now();
    const r = await http(RPC, calls.map((c, i) => ({ jsonrpc: "2.0", id: i, method: c.method, params: c.params })));
    if (Array.isArray(r.json)) { const byId = {}; for (const x of r.json) byId[x.id] = x.result; return calls.map((_, i) => byId[i] ?? null); }
    const out = []; for (const c of calls.slice(0, 30)) out.push((await rpc(c.method, c.params)).result ?? null); return out;
  }
  async function blockTs(num) { const b = (await rpc("eth_getBlockByNumber", ["0x" + num.toString(16), false])).result; return b ? parseInt(b.timestamp, 16) : null; }

  async function tradingYoung(maxAgeDays = 7) {
    const seen = new Map();
    for (const sort of ["hot", "volume"]) {
      const r = await http(`https://musepad.lol/api/tokens?sort=${sort}`);
      for (const x of r.json?.items ?? []) {
        if (!x.contractAddress || x.contractAddress.toLowerCase() === String(CFG.token?.address ?? "").toLowerCase() || (Date.now() - Date.parse(x.launchedAt)) > maxAgeDays * 864e5) continue;
        if ((n(x.volume24hUsd) ?? 0) <= 0) continue;
        seen.set(x.contractAddress.toLowerCase(), { ...x, cohort: "young, trading" });
      }
    }
    return [...seen.values()];
  }

  async function launches(maxPages = 3) {
    const out = [];
    for (let page = 1; page <= maxPages; page++) {
      const r = await http(`https://musepad.lol/api/tokens?sort=new&page=${page}`);
      const items = r.json?.items ?? [];
      out.push(...items);
      if (items.length < (r.json?.pageSize ?? 10)) break;
    }
    const own = String(CFG.token?.address ?? "").toLowerCase();
    return out.filter((x) => x.contractAddress && x.contractAddress.toLowerCase() !== own); // never score my own token
  }

  let HEAD = null;
  async function blockAt(tsSec) {
    // binary search: first block at or after tsSec (block time drifts, so estimating from recent blocks misses old launches)
    if (!HEAD || Date.now() - HEAD.t > 60000) HEAD = { n: parseInt((await rpc("eth_blockNumber", [])).result, 16), t: Date.now() };
    let lo = 0, hi = HEAD.n;
    for (let i = 0; i < 40 && lo < hi; i++) { const mid = Math.floor((lo + hi) / 2); const ts = await blockTs(mid); if (ts === null) break; if (ts < tsSec) lo = mid + 1; else hi = mid; }
    return lo;
  }
  async function totalSupply(token) {
    const r = await rpc("eth_call", [{ to: token, data: "0x18160ddd" }, "latest"]);
    try { return BigInt(r.result); } catch { return 0n; }
  }

  async function logsRange(token, from, to) {
    const logs = []; let step = Math.max(1, to - from + 1), start = from, calls = 0, partial = false;
    while (start <= to && calls < (RD.maxLogCalls ?? 120)) {
      const end = Math.min(to, start + step - 1);
      const r = await rpc("eth_getLogs", [{ address: token, topics: [TRANSFER], fromBlock: "0x" + start.toString(16), toBlock: "0x" + end.toString(16) }]);
      calls++;
      if (r.error) { if (step > 500) { step = Math.floor(step / 3); continue; } partial = true; break; }
      logs.push(...(r.result ?? [])); start = end + 1;
      if ((r.result ?? []).length < 3000) step = Math.min(step * 2, 400000);
    }
    return { logs, partial: partial || start <= to };
  }

  /** Launch window (first 3h) for launch behaviour, plus the last 6h for current activity. */
  async function transferLogs(token, launchedAtMs) {
    const head = parseInt((await rpc("eth_blockNumber", [])).result, 16);
    const t1 = await blockTs(head), t0 = await blockTs(head - 200000);
    const bt = t1 && t0 ? (t1 - t0) / 200000 : 0.1;
    const startBlock = await blockAt(Math.floor(launchedAtMs / 1000) - 900);
    const launchEnd = Math.min(head, startBlock + Math.round((3 * 3600 + 900) / bt));
    const a = await logsRange(token, startBlock, launchEnd);
    const full = launchEnd >= head;
    let recent = { logs: [], partial: false };
    if (!full) recent = await logsRange(token, Math.max(launchEnd + 1, head - Math.round(6 * 3600 / bt)), head);
    return { logs: a.logs, recent: recent.logs, full, head, bt, partial: a.partial || recent.partial };
  }

  async function isContract(addr) {
    const code = (await rpc("eth_getCode", [addr, "latest"])).result;
    return typeof code === "string" && code !== "0x" && !code.toLowerCase().startsWith("0xef0100");
  }

  async function onchain(token, launchedAtMs) {
    const { logs, recent, full, bt, partial } = await transferLogs(token, launchedAtMs);
    if (!logs.length) return null;
    const tx = logs.map((l) => ({ from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26), v: BigInt(l.data && l.data !== "0x" ? l.data : "0x0"), b: parseInt(l.blockNumber, 16), i: parseInt(l.logIndex, 16) }))
      .sort((a, c) => a.b - c.b || a.i - c.i);
    let supply = await totalSupply(token); const mintsSeen = supply === 0n; const touches = {}; const bal = {};
    for (const t of tx) {
      if (mintsSeen && t.from === ZERO) supply += t.v;
      if (mintsSeen && t.to === ZERO) supply -= t.v;
      for (const a of [t.from, t.to]) if (!DEAD.has(a)) touches[a] = (touches[a] ?? 0) + 1;
      if (t.from !== ZERO) bal[t.from] = (bal[t.from] ?? 0n) - t.v;
      bal[t.to] = (bal[t.to] ?? 0n) + t.v;
    }
    if (supply <= 0n) return null;
    const pm = Object.entries(touches).sort((a, c) => c[1] - a[1])[0]?.[0]; // the pool (Uniswap v4 PoolManager) is the busiest counterparty
    const share = (v) => Number((v * 1000000n) / supply) / 10000; // percent, 4 decimals
    let buys = tx.filter((t) => t.from === pm && t.to !== pm && !DEAD.has(t.to));
    if (buys.length && share(buys[0].v) > 50) buys = buys.slice(1); // pool seeding / vesting move, not a buyer
    const sells = tx.filter((t) => t.to === pm && t.from !== pm && t.from !== ZERO);
    if (!buys.length) return { supplyOk: true, buys: 0, partial };
    const firstBlock = buys[0].b;
    const hourBlocks = Math.round(3600 / bt);
    const firstHour = buys.filter((t) => t.b <= firstBlock + hourBlocks);
    const buyers = new Map(); for (const t of buys) buyers.set(t.to, (buyers.get(t.to) ?? 0n) + t.v);
    const firstBlockBuys = buys.filter((t) => t.b === firstBlock);
    const byBlock = {}; for (const t of buys.filter((x) => x.b <= firstBlock + 40)) (byBlock[t.b] = byBlock[t.b] ?? new Set()).add(t.to);
    const bundleAddrs = new Set(Object.values(byBlock).filter((s) => s.size >= 3).flatMap((s) => [...s]));
    const bundleShare = share([...bundleAddrs].reduce((s, a) => s + (buyers.get(a) ?? 0n), 0n));
    const amounts = {}; for (const t of buys) { const k = (t.v / 10n ** 15n).toString(); amounts[k] = (amounts[k] ?? 0) + 1; }
    const identicalBuys = Object.values(amounts).filter((c) => c >= 3).reduce((s, c) => s + c, 0);
    const early = [...buyers.keys()].slice(0, 70);
    const earlyBought = early.reduce((s, a) => s + buyers.get(a), 0n);
    if (!full && early.length) {
      // the launch window doesn't show what they hold now: ask the token directly
      const res = await rpcBatch(early.map((a) => ({ method: "eth_call", params: [{ to: token, data: "0x70a08231" + a.slice(2).padStart(64, "0") }, "latest"] })));
      early.forEach((a, i) => { try { if (res[i]) bal[a] = BigInt(res[i]); } catch {} });
    }
    const retention = { hold: 0, partial: 0, soldAll: 0, more: 0 };
    for (const a of early) { const b = bal[a] ?? 0n, got = buyers.get(a); if (b <= 0n) retention.soldAll++; else if (b > got) retention.more++; else if (b * 10n >= got * 9n) retention.hold++; else retention.partial++; }
    const buySizes = buys.map((t) => share(t.v)).sort((a, c) => a - c);
    const holders = full ? Object.entries(bal).filter(([a, v]) => v > 0n && a !== pm && !DEAD.has(a)).sort((a, c) => (c[1] > a[1] ? 1 : -1)) : [];
    const top = [];
    for (const [a, v] of holders.slice(0, 14)) { if (top.length >= 10) break; if (await isContract(a)) continue; top.push({ a, pct: share(v) }); }
    const last6hBlocks = Math.round(6 * 3600 / bt), headB = tx[tx.length - 1].b;
    const recentTx = full ? tx.filter((t) => t.b > headB - last6hBlocks) : recent.map((l) => ({ from: "0x" + l.topics[1].slice(26), to: "0x" + l.topics[2].slice(26) }));
    return {
      partial, buys: buys.length, sells: sells.length, uniqueBuyers: buyers.size, uniqueSellers: new Set(sells.map((t) => t.from)).size,
      firstHourBuyers: new Set(firstHour.map((t) => t.to)).size, firstHourBuys: firstHour.length,
      firstBlockBuyers: new Set(firstBlockBuys.map((t) => t.to)).size, firstBlockShare: share(firstBlockBuys.reduce((s, t) => s + t.v, 0n)),
      bundleLikeShare: bundleShare, bundleLikeWallets: bundleAddrs.size, identicalBuys,
      earlyBuyersShare: Math.min(100, share(earlyBought)), earlyRetention: retention,
      medianBuyPct: buySizes[Math.floor(buySizes.length / 2)] ?? null, maxBuyPct: buySizes[buySizes.length - 1] ?? null,
      holders: full ? holders.length : null, top10Pct: full ? Math.round(top.reduce((s, x) => s + x.pct, 0) * 100) / 100 : null, topHolderPct: full ? top[0]?.pct ?? 0 : 0,
      recentTrades6h: recentTx.filter((t) => t.from === pm || t.to === pm).length, historyComplete: full,
    };
  }

  async function launcherInfo(item) {
    const pid = String(item.sourceThreadUrl ?? "").match(/\/p\/(\d+)/)?.[1];
    let founder = false, muse = null;
    if (pid) { const t = await http(`${BOARD}/api/thread.json?post=${pid}`); founder = !!t.json?.thread?.founder; muse = t.json?.thread?.muse_id ?? null; }
    return { handle: item.launchedBy?.handle ?? null, founder, muse };
  }

  async function townAttention(symbol, launcher, token) {
    const r = await http(`${BOARD}/api/search.json?q=${encodeURIComponent(symbol)}&limit=50`);
    const named = new RegExp(`\\$${symbol}\\b|${token.slice(2, 12)}`, "i");
    const day = Date.now() - 864e5;
    const who = new Set();
    for (const p of r.json?.results ?? []) {
      const t = Date.parse(String(p.created_at ?? "").replace(" ", "T") + (/[zZ]$/.test(String(p.created_at)) ? "" : "Z"));
      if (Number.isFinite(t) && t < day) continue;
      if (!named.test(String(p.text ?? ""))) continue; // generic words like TEST or AZUKI don't count, only "$TICKER" or the contract
      const nm = String(p.name ?? "").toLowerCase();
      if (["musepad", "pretrade", String(launcher ?? "").toLowerCase()].includes(nm)) continue;
      who.add(nm);
    }
    return who.size;
  }

  async function safety(token) {
    const g = await http(`https://api.gopluslabs.io/api/v1/token_security/4663?contract_addresses=${token}`);
    const x = g.json?.result?.[token.toLowerCase()];
    if (!x) return { known: false, flags: [] };
    const yes = (v) => v === "1" || v === 1;
    const flags = [];
    if (yes(x.is_honeypot)) flags.push("honeypot");
    if (yes(x.cannot_sell_all)) flags.push("cannot sell all");
    if (n(x.sell_tax) !== null && n(x.sell_tax) > 0.1) flags.push(`sell tax ${Math.round(n(x.sell_tax) * 100)}%`);
    if (yes(x.owner_change_balance)) flags.push("owner can edit balances");
    if (yes(x.is_mintable)) flags.push("mintable");
    if (yes(x.hidden_owner)) flags.push("hidden owner");
    if (yes(x.slippage_modifiable)) flags.push("tax modifiable");
    const hs = Array.isArray(x.holders) ? x.holders.filter((h) => !yes(h.is_contract) && !yes(h.is_locked)) : null;
    return {
      known: true, flags, critical: flags.some((f) => /honeypot|cannot sell|edit balances|sell tax/.test(f)),
      holderCount: n(x.holder_count), top10Pct: hs ? Math.round(hs.slice(0, 10).reduce((t, h) => t + (n(h.percent) ?? 0), 0) * 10000) / 100 : null,
      topHolderPct: hs && hs[0] ? Math.round((n(hs[0].percent) ?? 0) * 10000) / 100 : null,
    };
  }

  async function collision(symbol, token) {
    const r = await http(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(symbol)}`);
    const other = (r.json?.pairs ?? []).filter((p) => String(p.baseToken?.symbol).toLowerCase() === symbol.toLowerCase() && String(p.baseToken?.address).toLowerCase() !== token.toLowerCase());
    const big = other.filter((p) => (n(p.liquidity?.usd) ?? 0) >= 25000).sort((a, c) => (n(c.liquidity?.usd) ?? 0) - (n(a.liquidity?.usd) ?? 0))[0];
    return big ? { with: big.baseToken.address, chain: big.chainId, liq: Math.round(n(big.liquidity.usd)), sameChain: big.chainId === "robinhood" } : null;
  }

  const clamp = (x, lo, hi) => Math.max(lo, Math.min(hi, x));
  const lin = (x, bad, good) => clamp((x - bad) / (good - bad), 0, 1); // 0 at bad, 1 at good (works either direction)

  function score(o, s, town, launcher, col) {
    const gates = []; const notes = [];
    const enough = o.uniqueBuyers >= (RD.minBuyers ?? 10);
    const conf = lin(o.uniqueBuyers, RD.minBuyers ?? 10, 40); // distribution stats mean little with a handful of buyers
    if (s.critical) gates.push(`contract: ${s.flags.join(", ")}`);
    if (col?.sameChain) gates.push(`reuses the ticker of an established Robinhood token (${col.with.slice(0, 10)}…, $${col.liq.toLocaleString("en-US")} liquidity)`);
    else if (col) notes.push(`shares its ticker with a token on ${col.chain}`);
    if (enough && o.bundleLikeShare >= 30) gates.push(`bundle-like buying took ${o.bundleLikeShare}% of supply in the opening blocks`);
    if (o.topHolderPct >= 20) gates.push(`one wallet holds ${o.topHolderPct}% of supply`);
    const topPart = o.top10Pct === null ? 0.5 : lin(o.top10Pct, 50, 15); // unknown concentration scores neutral, not good
    const dist = 30 * conf * (0.5 * topPart + 0.3 * lin(o.bundleLikeShare, 20, 3) + 0.2 * lin(o.firstBlockShare, 15, 2));
    const traction = 30 * (0.5 * lin(o.firstHourBuyers, 5, 60) + 0.3 * lin(o.uniqueBuyers, 10, 150) + 0.2 * lin(o.uniqueBuyers / Math.max(1, o.uniqueSellers), 0.8, 2.5));
    const kept = o.earlyRetention.hold + o.earlyRetention.more + 0.5 * o.earlyRetention.partial;
    const earlyN = Math.max(1, o.earlyRetention.hold + o.earlyRetention.more + o.earlyRetention.partial + o.earlyRetention.soldAll);
    const quality = 15 * conf * (0.6 * lin(kept / earlyN, 0.15, 0.6) + 0.4 * lin(o.medianBuyPct ?? 5, 1.5, 0.1));
    const townS = 15 * (0.6 * lin(town, 0, 6) + 0.25 * (launcher.founder ? 1 : 0) + 0.15 * lin(o.recentTrades6h, 0, 40));
    const sanity = 10 * conf * (o.identicalBuys > 6 ? 0.4 : 1) * (o.partial ? 0.8 : 1) * (col && !col.sameChain ? 0.6 : 1);
    let total = Math.round(dist + traction + quality + townS + sanity);
    if (!enough) total = Math.min(total, 35);
    const tier = gates.length ? "AVOID" : !enough ? "NO_TRACTION" : total >= 68 ? "STRONG_START" : total >= 50 ? "WATCH" : "WEAK";
    return { total, tier, gates, notes, parts: { distribution: Math.round(dist), traction: Math.round(traction), holderQuality: Math.round(quality), townSignal: Math.round(townS), sanity: Math.round(sanity) } };
  }

  async function assess(item) {
    const token = item.contractAddress.toLowerCase();
    const launchedAt = Date.parse(item.launchedAt);
    const [o, s, launcher, col] = await Promise.all([onchain(token, launchedAt), safety(token), launcherInfo(item), collision(item.symbol, token)]);
    if (!o || !o.buys) return { token, symbol: item.symbol, skipped: "no trades yet" };
    const town = await townAttention(item.symbol, launcher.handle, token);
    if (s.holderCount !== null && s.holderCount !== undefined) o.holders = s.holderCount;      // GoPlus sees every holder, logs can miss routed transfers
    if (s.top10Pct !== null && s.top10Pct !== undefined) { o.top10Pct = s.top10Pct; o.topHolderPct = s.topHolderPct ?? o.topHolderPct; }
    const sc = score(o, s, town, launcher, col);
    return {
      token, symbol: item.symbol, name: item.name, cohort: item.cohort ?? "fresh", launchedAt: item.launchedAt, launcher, thread: item.sourceThreadUrl,
      ageMin: Math.round((Date.now() - launchedAt) / 60000), score: sc.total, tier: sc.tier, gates: sc.gates, notes: sc.notes, parts: sc.parts,
      safety: s, collision: col, townMentions: town, onchain: o,
      entry: { t: Date.now(), mcap: n(item.marketCapUsd), vol24: n(item.volume24hUsd), holders: o.holders, uniqueBuyers: o.uniqueBuyers, recentTrades6h: o.recentTrades6h },
      killLine: `this read fails if, within 24h, ${o.holders ? `holders fall below ${Math.max(1, Math.floor(o.holders * 0.7))}, or ` : ""}${o.top10Pct !== null ? `top-10 concentration rises above ${Math.min(60, Math.round(o.top10Pct + 15))}%, or ` : ""}trading goes silent (under 5 trades in 6h)${n(item.marketCapUsd) ? `, or market cap drops below $${Math.round(n(item.marketCapUsd) * 0.4).toLocaleString("en-US")}` : ""}.`,
      checkpoints: {},
    };
  }

  function line(e) {
    if (e.skipped) return `• $${e.symbol}: skipped (${e.skipped})`;
    const icon = { STRONG_START: "🟢", WATCH: "🟡", WEAK: "⚪", NO_TRACTION: "⚫", AVOID: "🔴" }[e.tier];
    const o = e.onchain;
    return `${icon} $${e.symbol} ${e.score}/100 ${e.tier} [${e.cohort}] (${e.ageMin < 180 ? e.ageMin + "m" : Math.round(e.ageMin / 60) + "h"} old, by ${e.launcher.handle}${e.launcher.founder ? " 🌱" : ""}) — buyers ${o.uniqueBuyers} (${o.firstHourBuyers} in 1st hour), holders ${o.holders ?? "?"}, top10 ${o.top10Pct ?? "?"}%, bundle-like ${o.bundleLikeShare}%, first-block ${o.firstBlockShare}%, early buyers holding ${o.earlyRetention.hold + o.earlyRetention.more}/${o.earlyRetention.hold + o.earlyRetention.more + o.earlyRetention.partial + o.earlyRetention.soldAll}, town mentions ${e.townMentions}${e.gates.length ? ` | gates: ${e.gates.join("; ")}` : ""}${e.notes?.length ? ` | notes: ${e.notes.join("; ")}` : ""}`;
  }

  async function runTest(testNo, { dry = false } = {}) {
    const all = await launches(RD.pages ?? 4);
    const now = Date.now();
    let pick = all.filter((x) => { const age = (now - Date.parse(x.launchedAt)) / 60000; return age >= (RD.minAgeMin ?? 20) && age <= (RD.windowHours ?? 6) * 60; });
    if (pick.length < (RD.minBatch ?? 5)) pick = all.filter((x) => (now - Date.parse(x.launchedAt)) / 60000 >= (RD.minAgeMin ?? 20)).slice(0, RD.minBatch ?? 5);
    pick = pick.map((x) => ({ ...x, cohort: "fresh" })).sort((a, c) => Date.parse(c.launchedAt) - Date.parse(a.launchedAt)).slice(0, RD.freshMax ?? 12);
    // fresh launches alone are mostly empty right now, so every test also scores young tokens that are actually trading
    const have = new Set(pick.map((x) => x.contractAddress.toLowerCase()));
    for (const x of await tradingYoung(RD.youngMaxDays ?? 7)) if (!have.has(x.contractAddress.toLowerCase())) pick.push(x);
    pick = pick.slice(0, RD.maxBatch ?? 25);
    const results = [];
    for (const item of pick) { try { results.push({ test: testNo, ...(await assess(item)) }); } catch (e) { results.push({ test: testNo, token: item.contractAddress, symbol: item.symbol, skipped: `error ${String(e).slice(0, 80)}` }); } }
    results.sort((a, c) => (c.score ?? -1) - (a.score ?? -1));
    const summary = [`launch radar test #${testNo} — ${new Date().toISOString()} — ${results.length} launches scored`, ...results.map(line)].join("\n");
    if (!dry) {
      const entries = load(ENTRIES, []); entries.push(...results.filter((r) => !r.skipped)); save(ENTRIES, entries);
      save(join(DIR, `test-${testNo}.json`), results);
      const log = join(DIR, "radar.log"); writeFileSync(log, (existsSync(log) ? readFileSync(log, "utf8") : "") + summary + "\n\n");
      const meta = load(META, { done: [] }); meta.done.push(testNo); if ((RD.rerun ?? []).some((t) => Number(String(t).split("@")[0]) === testNo)) meta.note = `test ${testNo} was rerun after data fixes (rate-limit backoff, exact launch block)`; save(META, meta);
    }
    return { results, summary };
  }

  async function checkpointSnapshot(e) {
    const o = await onchain(e.token, Date.parse(e.launchedAt));
    let mcap = null;
    for (let page = 1; page <= 8 && mcap === null; page++) {
      const r = await http(`https://musepad.lol/api/tokens?sort=new&page=${page}`);
      const hit = (r.json?.items ?? []).find((x) => String(x.contractAddress).toLowerCase() === e.token);
      if (hit) { mcap = n(hit.marketCapUsd); break; }
      if (!(r.json?.items ?? []).length) break;
    }
    return { t: Date.now(), holders: o?.holders ?? 0, uniqueBuyers: o?.uniqueBuyers ?? 0, top10Pct: o?.top10Pct ?? null, recentTrades6h: o?.recentTrades6h ?? 0, mcap };
  }

  async function settle() {
    const entries = load(ENTRIES, []); let changed = 0;
    for (const e of entries) {
      for (const [k, h] of [["1h", 1], ["6h", 6], ["24h", 24]]) {
        if (e.checkpoints[k] || Date.now() < e.entry.t + h * 36e5) continue;
        e.checkpoints[k] = await checkpointSnapshot(e); changed++;
        if (changed >= (RD.settlePerRun ?? 6)) break;
      }
      if (changed >= (RD.settlePerRun ?? 6)) break;
    }
    if (changed) save(ENTRIES, entries);
    return changed;
  }

  async function tick() {
    const meta = load(META, { done: [] });
    let ran = 0;
    meta.reran = meta.reran ?? [];
    for (const tag of RD.rerun ?? []) {
      const no = Number(String(tag).split("@")[0]);
      if (meta.reran.includes(tag) || !meta.done.includes(no)) continue;
      save(ENTRIES, load(ENTRIES, []).filter((e) => e.test !== no));
      meta.done = meta.done.filter((x) => x !== no); meta.reran.push(tag); save(META, meta);
      console.log(`radar: test #${no} discarded for a rerun (data bug fixed), running it again now`);
    }
    Object.assign(meta, load(META, meta));
    for (const [i, iso] of (RD.schedule ?? []).entries()) {
      const no = i + 1;
      if (meta.done.includes(no) || Date.now() < Date.parse(iso)) continue;
      const r = await runTest(no); console.log(`\n→ ${r.summary}`); ran++;
    }
    const s = await settle(); if (s) console.log(`radar: settled ${s} checkpoint(s)`);
    return ran + s;
  }

  return { runTest, settle, tick, assess, launches };
}
