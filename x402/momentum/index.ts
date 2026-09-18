// pretrade / momentum — self-contained x402 Cloud handler (Request → Response)
// ───────────────────────── shared core (inlined into every service) ─────────────────────────
type Severity = "critical" | "high" | "medium" | "low";
interface Flag { code: string; severity: Severity; points: number; detail: string }

const CHAINS: Record<string, { goplus: string; dex: string }> = {
  base: { goplus: "8453", dex: "base" },
  ethereum: { goplus: "1", dex: "ethereum" },
  bsc: { goplus: "56", dex: "bsc" },
  arbitrum: { goplus: "42161", dex: "arbitrum" },
  optimism: { goplus: "10", dex: "optimism" },
  polygon: { goplus: "137", dex: "polygon" },
  robinhood: { goplus: "4663", dex: "robinhood" },
  solana: { goplus: "solana", dex: "solana" },
};
const ADDR_RE = /^0x[a-fA-F0-9]{40}$/;
const SOL_RE = /^[1-9A-HJ-NP-Za-km-z]{32,44}$/;
const isSol = (a: string) => !a.startsWith("0x") && SOL_RE.test(a);
const validAddr = (a: string) => ADDR_RE.test(a) || isSol(a);
// EVM addresses are case-insensitive, Solana mints are case-sensitive
const norm = (a: string) => (isSol(a) ? a : a.toLowerCase());
/** Resolve the chain: explicit ?chain wins, a base58 address implies solana, otherwise base. */
function resolveChain(address: string, chainParam: string | null) {
  const key = (chainParam ?? "").toLowerCase() || (isSol(address) ? "solana" : "base");
  const chain = CHAINS[key];
  if (!chain) return { key, chain: null, error: `Supported chains: ${Object.keys(CHAINS).join(", ")}` };
  if ((key === "solana") !== isSol(address)) return { key, chain: null, error: "Address format does not match the chain (0x… for EVM, base58 mint for solana)." };
  return { key, chain, error: null };
}
const DISCLAIMER = "Automated heuristics from public data. Not financial advice. A clean result does not guarantee safety.";

function bad(status: number, error: string, hint?: string): Response {
  // status >= 400 => caller is NOT charged (x402 Cloud only settles on success)
  return Response.json({ error, hint }, { status });
}

async function getJson(url: string, timeoutMs = 8000): Promise<any | null> {
  const ctrl = new AbortController();
  const t = setTimeout(() => ctrl.abort(), timeoutMs);
  try {
    const r = await fetch(url, { signal: ctrl.signal, headers: { accept: "application/json" } });
    if (!r.ok) return null;
    return await r.json();
  } catch {
    return null;
  } finally {
    clearTimeout(t);
  }
}

const num = (v: unknown): number | null => {
  if (v === null || v === undefined || v === "") return null;
  const n = Number(v);
  return Number.isFinite(n) ? n : null;
};
const yes = (v: unknown) => v === "1" || v === 1 || v === true;

async function fetchPairs(dexChain: string, addresses: string[]): Promise<any[] | null> {
  const data = await getJson(`https://api.dexscreener.com/tokens/v1/${dexChain}/${addresses.join(",")}`);
  return Array.isArray(data) ? data : null;
}

async function fetchSecurity(goplusChain: string, address: string): Promise<any | null> {
  if (goplusChain === "solana") {
    const [g, r] = await Promise.all([
      getJson(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${address}`),
      getJson(`https://api.rugcheck.xyz/v1/tokens/${address}/report/summary`, 6000),
    ]);
    const gp = g?.result && typeof g.result === "object" ? (g.result[address] ?? Object.values(g.result)[0] ?? null) : null;
    const rc = r && Array.isArray(r.risks) ? r : null;
    return gp || rc ? { __solana: true, gp, rc } : null;
  }
  const data = await getJson(
    `https://api.gopluslabs.io/api/v1/token_security/${goplusChain}?contract_addresses=${address}`,
  );
  const result = data?.result;
  if (!result || typeof result !== "object") return null;
  return result[address.toLowerCase()] ?? Object.values(result)[0] ?? null;
}

const same = (x: unknown, a: string) => typeof x === "string" && norm(x) === norm(a);

function bestPair(pairs: any[], address: string): any | null {
  const mine = pairs.filter((p) => same(p?.baseToken?.address, address) || same(p?.quoteToken?.address, address));
  if (!mine.length) return null;
  return mine.sort((x, y) => (num(y?.liquidity?.usd) ?? 0) - (num(x?.liquidity?.usd) ?? 0))[0];
}

function marketSnapshot(pair: any | null, pairs: any[], address: string) {
  if (!pair) return null;
  const totalLiq = pairs
    .filter((p) => same(p?.baseToken?.address, address))
    .reduce((s, p) => s + (num(p?.liquidity?.usd) ?? 0), 0);
  const created = num(pair.pairCreatedAt);
  return {
    symbol: pair.baseToken?.symbol ?? null,
    name: pair.baseToken?.name ?? null,
    priceUsd: num(pair.priceUsd),
    marketCapUsd: num(pair.marketCap) ?? num(pair.fdv),
    liquidityUsd: Math.round(totalLiq),
    volume24hUsd: num(pair.volume?.h24),
    pairAgeHours: created ? Math.round(((Date.now() - created) / 36e5) * 10) / 10 : null,
    deepestPoolUsd: Math.round(num(pair.liquidity?.usd) ?? 0),
    topPair: { dex: pair.dexId ?? null, address: pair.pairAddress ?? null, url: pair.url ?? null },
  };
}

function assess(sec: any | null, market: ReturnType<typeof marketSnapshot>) {
  const flags: Flag[] = [];
  const add = (code: string, severity: Severity, points: number, detail: string) =>
    flags.push({ code, severity, points, detail });

  const young = !market || market.pairAgeHours === null || market.pairAgeHours < 24 * 30;
  const st1 = (x: any) => yes(x?.status);

  if (sec?.__solana) {
    const gp = sec.gp;
    if (gp) {
      if (st1(gp.balance_mutable_authority)) add("BALANCE_MUTABLE", "critical", 100, "An authority can change holder balances.");
      if (yes(gp.non_transferable)) add("NON_TRANSFERABLE", "critical", 100, "Token is non-transferable: it cannot be sold.");
      if (String(gp.default_account_state) === "2") add("ACCOUNTS_FROZEN_BY_DEFAULT", "critical", 100, "New token accounts start frozen.");
      if (st1(gp.freezable)) add("FREEZE_AUTHORITY", "high", 30, "Freeze authority is active: your tokens can be frozen.");
      if (st1(gp.mintable)) add("MINT_AUTHORITY", "high", 25, "Mint authority is active: supply can be inflated.");
      if (st1(gp.closable)) add("CLOSABLE", "high", 25, "Mint can be closed by an authority.");
      if (gp.transfer_hook && (Array.isArray(gp.transfer_hook) ? gp.transfer_hook.length : st1(gp.transfer_hook))) add("TRANSFER_HOOK", "medium", 15, "Custom transfer hook can alter or block transfers.");
      const feeBps = num(gp.transfer_fee?.current_fee_rate?.fee_rate);
      if (feeBps !== null && feeBps > 1000) add("TRANSFER_FEE_HIGH", "high", 30, `Transfer fee ${(feeBps / 100).toFixed(1)}%.`);
      else if (st1(gp.transfer_fee_upgradable)) add("TRANSFER_FEE_UPGRADABLE", "medium", 10, "Transfer fee can be raised later.");
      if (st1(gp.metadata_mutable)) add("METADATA_MUTABLE", "low", 3, "Name and image can be changed.");
      if (Array.isArray(gp.creators) && gp.creators.some((c: any) => yes(c?.malicious_address))) add("CREATOR_FLAGGED", "high", 35, "A creator address is flagged as malicious.");
      if (Array.isArray(gp.holders) && gp.holders.length) {
        const top10 = gp.holders.slice(0, 10).filter((h: any) => !yes(h.is_locked) && !h.tag).reduce((s: number, h: any) => s + (num(h.percent) ?? 0), 0);
        if (young && top10 > 0.8) add("HOLDERS_CONCENTRATED", "high", 25, `Top 10 accounts hold ${(top10 * 100).toFixed(0)}% (may include pools).`);
        else if (young && top10 > 0.5) add("HOLDERS_CONCENTRATED", "medium", 15, `Top 10 accounts hold ${(top10 * 100).toFixed(0)}% (may include pools).`);
      }
    }
    const rc = sec.rc;
    if (rc) {
      const have = new Set(flags.map((f) => f.code));
      for (const r of rc.risks.filter((x: any) => x?.level === "danger").slice(0, 3)) {
        const code = "RUGCHECK_" + String(r.name ?? "RISK").toUpperCase().replace(/[^A-Z0-9]+/g, "_").slice(0, 40);
        // skip what GoPlus already reported, so one fact is never double-counted
        if (/MINT/.test(code) && have.has("MINT_AUTHORITY")) continue;
        if (/FREEZE/.test(code) && have.has("FREEZE_AUTHORITY")) continue;
        add(code, "high", 20, String(r.description ?? r.name ?? "").slice(0, 160));
      }
      const lp = num(rc.lpLockedPct);
      if (young && lp !== null && lp < 50) add("LP_UNLOCKED", "medium", 10, `Only ${lp.toFixed(0)}% of LP is locked or burned.`);
    }
  } else if (sec) {
    if (yes(sec.honeypot_with_same_creator)) add("CREATOR_HONEYPOT_HISTORY", "high", 35, "This creator has deployed a honeypot before.");
    const creatorPct = num(sec.creator_percent);
    if (creatorPct !== null && creatorPct > 0.2) add("CREATOR_HOLDS_LARGE_SHARE", "medium", 15, `Creator still holds ${(creatorPct * 100).toFixed(0)}% of supply.`);
    if (yes(sec.is_honeypot)) add("HONEYPOT", "critical", 100, "Simulation indicates the token cannot be sold.");
    if (yes(sec.cannot_sell_all)) add("CANNOT_SELL_ALL", "critical", 100, "Holders cannot sell their full balance.");
    if (yes(sec.cannot_buy)) add("CANNOT_BUY", "critical", 100, "Buying is blocked.");
    if (yes(sec.owner_change_balance)) add("OWNER_CAN_CHANGE_BALANCE", "critical", 100, "Owner can modify holder balances.");

    const sellTax = num(sec.sell_tax);
    const buyTax = num(sec.buy_tax);
    if (sellTax !== null && sellTax >= 0.5) add("SELL_TAX_EXTREME", "critical", 100, `Sell tax ${(sellTax * 100).toFixed(1)}%.`);
    else if (sellTax !== null && sellTax > 0.1) add("SELL_TAX_HIGH", "high", 30, `Sell tax ${(sellTax * 100).toFixed(1)}%.`);
    if (buyTax !== null && buyTax > 0.1) add("BUY_TAX_HIGH", "medium", 15, `Buy tax ${(buyTax * 100).toFixed(1)}%.`);

    if (sec.is_open_source !== undefined && !yes(sec.is_open_source)) add("UNVERIFIED_SOURCE", "high", 25, "Contract source is not verified.");
    if (yes(sec.hidden_owner)) add("HIDDEN_OWNER", "high", 25, "Hidden owner mechanism detected.");
    if (yes(sec.can_take_back_ownership)) add("OWNERSHIP_RECLAIMABLE", "high", 25, "Renounced ownership can be reclaimed.");
    if (yes(sec.selfdestruct)) add("SELFDESTRUCT", "high", 30, "Contract can self-destruct.");
    if (yes(sec.slippage_modifiable)) add("TAX_MODIFIABLE", "high", 25, "Owner can change trading tax.");
    if (yes(sec.is_mintable)) add("MINTABLE", "medium", 15, "Supply can be increased.");
    if (yes(sec.transfer_pausable)) add("PAUSABLE", "medium", 15, "Transfers can be paused.");
    if (yes(sec.is_blacklisted)) add("BLACKLIST", "medium", 10, "Contract has a blacklist function.");
    if (yes(sec.is_proxy)) add("PROXY", "medium", 10, "Upgradeable proxy: logic can change.");
    if (yes(sec.trading_cooldown)) add("COOLDOWN", "low", 5, "Trading cooldown present.");

    if (Array.isArray(sec.holders) && sec.holders.length) {
      const top10 = sec.holders
        .slice(0, 10)
        .filter((h: any) => !yes(h.is_contract) && !yes(h.is_locked))
        .reduce((s: number, h: any) => s + (num(h.percent) ?? 0), 0);
      if (top10 > 0.8) add("HOLDERS_CONCENTRATED", "high", 25, `Top wallets (non-contract, unlocked) hold ${(top10 * 100).toFixed(0)}%.`);
      else if (top10 > 0.5) add("HOLDERS_CONCENTRATED", "medium", 15, `Top wallets (non-contract, unlocked) hold ${(top10 * 100).toFixed(0)}%.`);
    }
    // V3/V4-style pools hold liquidity as NFT positions; "locked LP" is not a meaningful signal there
    const nftLp = Array.isArray(sec.lp_holders) && sec.lp_holders.some((h: any) => Array.isArray(h?.NFT_list) && h.NFT_list.length);
    if (!nftLp && Array.isArray(sec.lp_holders) && sec.lp_holders.length) {
      const locked = sec.lp_holders
        .filter((h: any) => yes(h.is_locked) || /^0x0{36}(0000|dead)$/i.test(h.address ?? ""))
        .reduce((s: number, h: any) => s + (num(h.percent) ?? 0), 0);
      if (young && locked < 0.5) add("LP_UNLOCKED", "medium", 10, `Only ${(locked * 100).toFixed(0)}% of LP is locked or burned.`);
    }
  }

  if (!market) add("NO_DEX_PAIR", "high", 30, "No DEX pair found: cannot verify liquidity.");
  else {
    if (market.liquidityUsd < 5_000) add("LIQUIDITY_VERY_LOW", "high", 25, `Liquidity $${market.liquidityUsd}.`);
    else if (market.liquidityUsd < 25_000) add("LIQUIDITY_LOW", "medium", 10, `Liquidity $${market.liquidityUsd}.`);
    if (market.pairAgeHours !== null && market.pairAgeHours < 1) add("PAIR_BRAND_NEW", "medium", 15, "Pair is under 1 hour old.");
    else if (market.pairAgeHours !== null && market.pairAgeHours < 24) add("PAIR_NEW", "medium", 10, "Pair is under 24 hours old.");
  }

  const score = Math.min(100, flags.reduce((s, f) => s + f.points, 0));
  const critical = flags.some((f) => f.severity === "critical");
  const verdict = critical || score >= 60 ? "DANGER" : score >= 20 ? "CAUTION" : "OK";
  const confidence = sec && market ? "high" : sec || market ? "medium" : "low";
  const order: Record<Severity, number> = { critical: 0, high: 1, medium: 2, low: 3 };
  flags.sort((a, b) => order[a.severity] - order[b.severity]);
  return { verdict, riskScore: score, confidence, flags };
}
function taxesOf(sec: any | null) {
  if (!sec) return null;
  if (sec.__solana) {
    const bps = num(sec.gp?.transfer_fee?.current_fee_rate?.fee_rate);
    const t = bps === null ? 0 : bps / 10000;
    return { buy: t, sell: t };
  }
  return { buy: num(sec.buy_tax), sell: num(sec.sell_tax) };
}

/**
 * Constant-product estimate against the deepest pool: selling $S into a pool holding $L in total
 * moves price by roughly S / (L/2 + S). Concentrated-liquidity pools can be better or worse.
 */
function exitModel(deepestPoolUsd: number) {
  const half = deepestPoolUsd / 2;
  const impact = (usd: number) => (half > 0 ? usd / (half + usd) : 1);
  const maxFor = (i: number) => Math.floor((i * half) / (1 - i));
  return { impact, maxUsd: { impact1pct: maxFor(0.01), impact2pct: maxFor(0.02), impact5pct: maxFor(0.05) } };
}
// ───────────────────────────────────── end shared core ─────────────────────────────────────

const clamp = (n: number, lo: number, hi: number) => Math.max(lo, Math.min(hi, n));

export default async function handler(req: Request): Promise<Response> {
  const url = new URL(req.url);
  const address = (url.searchParams.get("address") ?? "").trim();
  if (!validAddr(address)) return bad(400, "invalid_address", "Pass ?address= as 0x… (EVM) or a base58 mint (Solana).");
  const { key: chainKey, chain, error } = resolveChain(address, url.searchParams.get("chain"));
  if (!chain) return bad(400, "unsupported_chain", error!);

  const pairs = await fetchPairs(chain.dex, [address]);
  if (!pairs) return bad(502, "upstream_unavailable", "Market data unreachable. You were not charged.");
  const pair = bestPair(pairs, address);
  if (!pair) return bad(404, "no_pair_found", "No DEX pair for this token on this chain. You were not charged.");

  const market = marketSnapshot(pair, pairs, address)!;
  const pc = { m5: num(pair.priceChange?.m5), h1: num(pair.priceChange?.h1), h6: num(pair.priceChange?.h6), h24: num(pair.priceChange?.h24) };
  const tx = (k: string) => ({ buys: num(pair.txns?.[k]?.buys) ?? 0, sells: num(pair.txns?.[k]?.sells) ?? 0 });
  const h1 = tx("h1");
  const h24 = tx("h24");
  const buyRatio = (t: { buys: number; sells: number }) => (t.buys + t.sells ? t.buys / (t.buys + t.sells) : null);
  const br1 = buyRatio(h1);
  const br24 = buyRatio(h24);

  const v1 = num(pair.volume?.h1) ?? 0;
  const v24 = num(pair.volume?.h24) ?? 0;
  // >1 means the last hour is running hotter than the 24h average hour
  const volumeAcceleration = v24 > 0 ? Math.round(((v1 * 24) / v24) * 100) / 100 : null;
  const liqToMcap = market.marketCapUsd ? Math.round((market.liquidityUsd / market.marketCapUsd) * 1000) / 1000 : null;

  let score = 0;
  score += clamp((pc.h1 ?? 0) * 1.5, -30, 30);
  score += clamp((pc.h6 ?? 0) * 0.5, -20, 20);
  if (br1 !== null && h1.buys + h1.sells >= 10) score += clamp((br1 - 0.5) * 80, -25, 25);
  if (volumeAcceleration !== null) score += clamp((volumeAcceleration - 1) * 10, -10, 25);
  score = Math.round(clamp(score, -100, 100));

  const signal = score >= 35 ? "STRONG_UP" : score >= 12 ? "UP" : score <= -35 ? "STRONG_DOWN" : score <= -12 ? "DOWN" : "NEUTRAL";
  const warnings: string[] = [];
  if (market.liquidityUsd < 25_000) warnings.push("Thin liquidity: signal is easy to manipulate.");
  if (h1.buys + h1.sells < 10) warnings.push("Fewer than 10 trades in the last hour: low statistical weight.");
  if (liqToMcap !== null && liqToMcap < 0.02) warnings.push("Liquidity is under 2% of market cap: exits will move price.");

  return Response.json({
    address: norm(address),
    chain: chainKey,
    signal,
    momentumScore: score,
    priceChangePct: pc,
    flow: { h1: { ...h1, buyRatio: br1 }, h24: { ...h24, buyRatio: br24 } },
    volumeUsd: { h1: v1, h24: v24, acceleration: volumeAcceleration },
    liquidityToMarketCap: liqToMcap,
    market,
    warnings,
    checkedAt: new Date().toISOString(),
    disclaimer: DISCLAIMER,
  });
}
