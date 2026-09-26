// @ts-check
// The token check behind every read: one address in, one verdict out. Everything it needs from outside (HTTP, RPC,
// the v4 hook read, the trade simulation, the exit measurement, provenance, the clock) comes in as `deps`, so the
// whole pipeline can run offline against recorded fixtures (test/replay.test.mjs) and the bot wires in the live ones.
import { isSol, GOPLUS, n, yes } from "./util.mjs";
import { top10Share } from "../holders.mjs";
import { dropForkCopies } from "../addrctx.mjs";
import { recognizedQuote } from "./quotes.mjs";

/** @param {import("./types").CheckDeps} deps */
export function makeQuickCheck(deps) {
  const { http, rpcFor, now, hookMaxPoints, infraHolders, v4HookRead, simRead, exitRead, provenanceRead, onForkSkipped, stockToken } = deps;
  /** @type {import("./types").QuickCheck} */
  return async function quickCheck(address, { light = false, chain: onlyChain = null } = {}) {
    const sol = isSol(address);
    const a = sol ? address : address.toLowerCase();
    const found = await http(`https://api.dexscreener.com/latest/dex/search?q=${a}`);
    let pairs = (found.json?.pairs ?? []).filter((p) => (sol ? p?.baseToken?.address === a && p.chainId === "solana" : p?.baseToken?.address?.toLowerCase() === a) && (!onlyChain || p.chainId === onlyChain));
    // a pool on a chain that copied Ethereum's state (pulsechain) is not the market of the Ethereum token at that address
    if (!sol && pairs.length) {
      const fork = await dropForkCopies(pairs, async (c) => { const r = await rpcFor(c)?.("eth_getCode", [a, "latest"]).catch(() => null); return r?.result === undefined ? null : r.result !== "0x"; });
      pairs = fork.pairs;
      if (fork.forkOf) onForkSkipped(a, { chain: fork.forkOf, unsure: !!fork.unsure });
    }
    if (!pairs.length) return null; // wallet, pre-graduation token or unknown → stay silent
    // liquidity counts only against a recognized quote (see core/quotes.mjs): a pool against a token nobody can price
    // independently can list depth no seller reaches. With no recognized pool at all, the read keeps the pools but says so.
    const known = await Promise.all(pairs.map((q) => recognizedQuote(q.chainId, q.quoteToken?.address, stockToken)));
    const trusted = pairs.filter((_, i) => known[i] !== false);
    const quoteUnknown = trusted.length === 0;
    if (!quoteUnknown) pairs = trusted;
    pairs.sort((x, y) => (n(y.liquidity?.usd) ?? 0) - (n(x.liquidity?.usd) ?? 0));
    const p = pairs[0];
    const chain = p.chainId;
    const liquidity = Math.round(pairs.reduce((s, q) => s + (n(q.liquidity?.usd) ?? 0), 0));
    // DexScreener gives no liquidity for a pump.fun bonding curve (or an unindexed pool): that is "unknown", not $0
    // ($moose, #lobby 77591: the draft said "liquidity $0" and "LP 0% locked" to the token's own launcher)
    const liqKnown = pairs.some((q) => n(q.liquidity?.usd) !== null);
    const ageH = n(p.pairCreatedAt) ? (now() - (n(p.pairCreatedAt) ?? 0)) / 36e5 : null;

    let sec = null, solSec = null;
    if (sol) {
      const [g, r] = await Promise.all([
        http(`https://api.gopluslabs.io/api/v1/solana/token_security?contract_addresses=${a}`),
        http(`https://api.rugcheck.xyz/v1/tokens/${a}/report/summary`),
      ]);
      const gp = g.json?.result?.[a] ?? null;
      const rc = Array.isArray(r.json?.risks) ? r.json : null;
      if (gp || rc) solSec = { gp, rc };
    } else if (GOPLUS[chain]) {
      const g = await http(`https://api.gopluslabs.io/api/v1/token_security/${GOPLUS[chain]}?contract_addresses=${a}`);
      sec = g.json?.result?.[a] ?? null;
    }

    const flags = [];
    let score = 0, critical = false;
    const add = (label, pts, crit = false) => { flags.push(label); score += pts; critical ||= crit; };
    const young = ageH === null || ageH < 24 * 30;
    if (solSec) {
      const st = (x) => yes(x?.status);
      const gp = solSec.gp ?? {};
      if (st(gp.balance_mutable_authority)) add("balances mutable", 100, true);
      if (yes(gp.non_transferable)) add("non-transferable", 100, true);
      if (st(gp.freezable)) add("freeze authority active", 30);
      if (st(gp.mintable)) add("mint authority active", 25);
      if (st(gp.closable)) add("closable", 25);
      for (const r of (solSec.rc?.risks ?? []).filter((x) => x?.level === "danger").slice(0, 2)) {
        if (/mint|freeze/i.test(r.name ?? "")) continue;
        add(String(r.name ?? "rugcheck risk").toLowerCase(), 20);
      }
      const lp = n(solSec.rc?.lpLockedPct);
      if (young && liqKnown && lp !== null && lp < 50) add(`LP ${lp.toFixed(0)}% locked`, 10); // a curve has no LP to lock
    }
    if (sec) {
      if (yes(sec.honeypot_with_same_creator)) add("creator has honeypot history", 35);
      if (yes(sec.is_honeypot)) add("honeypot", 100, true);
      if (yes(sec.cannot_sell_all)) add("cannot sell all", 100, true);
      if (yes(sec.owner_change_balance)) add("owner can edit balances", 100, true);
      const st = n(sec.sell_tax), bt = n(sec.buy_tax);
      if (st !== null && st >= 0.5) add(`sell tax ${(st * 100).toFixed(0)}%`, 100, true);
      else if (st !== null && st > 0.1) add(`sell tax ${(st * 100).toFixed(0)}%`, 30);
      if (bt !== null && bt > 0.1) add(`buy tax ${(bt * 100).toFixed(0)}%`, 15);
      if (sec.is_open_source !== undefined && !yes(sec.is_open_source)) add("unverified source", 25);
      if (yes(sec.hidden_owner)) add("hidden owner", 25);
      if (yes(sec.slippage_modifiable)) add("tax modifiable", 25);
      if (yes(sec.is_mintable)) add("mintable", 15);
      if (yes(sec.transfer_pausable)) add("pausable", 15);
      if (yes(sec.is_proxy)) add("proxy", 10);
    }
    // unknown is not the same as clean: without a scan, never say OK (on solana too: GoPlus and RugCheck both down)
    if (!sec && !solSec) add("contract not scanned", 20);
    // a third of supply in ten non-pool wallets is an exit risk the pool numbers can't show (chiefofstaff, #memecoins 74152)
    const top10Pct = await (async () => {
      const hs = sec?.holders ?? solSec?.gp?.holders;
      if (!Array.isArray(hs) || !hs.length) return null;
      // on robinhood, holders are classified by code and verified name: launch lockers and routers are not holders
      // ($MDOG: 8.2% sat in PonsV2LaunchLocker and was counted as concentration)
      const infra = chain === "robinhood" && !light ? await infraHolders(hs.slice(0, 12).map((h) => String(h.address).toLowerCase())) : [];
      return top10Share(hs, [a, p.pairAddress, ...(sec?.dex ?? []).flatMap((d) => [d.pool_manager, d.pair]), ...infra]);
    })();
    if (top10Pct !== null && top10Pct >= 50) add(`top 10 holders own ${Math.round(top10Pct)}%`, 30);
    else if (top10Pct !== null && top10Pct >= 30) add(`top 10 holders own ${Math.round(top10Pct)}%`, 20);
    if (!liqKnown) add("no liquidity figure (bonding curve or unindexed pool)", 0);
    const liqAt = flags.length; // the low-liquidity flag goes here once the exit is known (measured on v4 pools, below)
    if (ageH !== null && ageH < 24) add(`pair ${ageH < 1 ? "<1h" : Math.round(ageH) + "h"} old`, ageH < 1 ? 15 : 10);
    const hook = light ? null : await v4HookRead(p);
    // capped: a hook that CAN change amounts is not proof that it does. alone it reads CAUTION; with other flags it can reach DANGER
    let hookBudget = hookMaxPoints();
    for (const r of hook?.scored ? hook.risk ?? [] : []) { const pts = Math.min(r.pts, hookBudget); hookBudget -= pts; add(r.text, pts); }
    const sim = hook?.key ? await simRead(p, hook.key, a) : null;
    const prov = !light && chain === "robinhood" ? await provenanceRead(a) : null;
    for (const f of sim?.scored ? sim.flags : []) add(f.text, f.pts, !!f.critical);

    const deepest = n(p.liquidity?.usd) ?? 0;
    const formula2 = Math.floor((0.02 * (deepest / 2)) / 0.98);
    // on a v4 pool the exit is measured by selling on the live pool: a full-position figure (Doppler multicurve) overstates it
    const measured = sim?.status === "ok" && hook?.key ? await exitRead(p, hook.key, a, formula2) : null;
    // an irregular pool (impact not rising with size) has no honest single exit figure: no number from it, and the
    // listed-liquidity formula isn't trusted either, so the read says so and never reads OK
    const irregularExit = !!measured?.irregular;
    const exit = irregularExit ? null : measured;
    // "low liquidity" judges what a seller can reach: with a measured exit, the depth that exit implies (2% size × 98),
    // not the listed figure ($musemini: $9,987 listed read "low", ~$2k reachable is "very low")
    if (liqKnown) {
      const reach = exit ? Math.min(liquidity, exit.atLeast ? Infinity : exit.usd * 98) : liquidity;
      /** @type {[string, number] | null} */
      const f = reach < 5000 ? ["very low liquidity", 25] : reach < 25000 ? ["low liquidity", 10] : null;
      if (f) { flags.splice(liqAt, 0, f[0]); score += f[1]; }
    }

    // missing evidence never reads OK: a holder list or a sell simulation that should exist but didn't come back leaves the
    // read at CAUTION at least. it lifts OK only; an unknown is not a finding, so it never pushes a read to DANGER.
    const gaps = [];
    const listed = sec?.holders ?? solSec?.gp?.holders;
    if (top10Pct === null) gaps.push(Array.isArray(listed) && listed.length ? "no holders in view beyond pools and locks" : "holder list not read");
    if (irregularExit) gaps.push("exit size irregular: price impact doesn't rise with sell size");
    if (quoteUnknown) gaps.push("liquidity only against an unrecognized quote token");
    if (hook?.key && (!sim || sim.status === "unavailable" || sim.status === "inconclusive")) gaps.push("sell not simulated");
    for (const g of gaps) flags.push(g);
    if (gaps.length) score = Math.max(score, 20);

    score = Math.min(100, score);
    const verdict = critical || score >= 60 ? "DANGER" : score >= 20 ? "CAUTION" : "OK";
    const k = exit && formula2 > 0 ? exit.usd / formula2 : 1;
    const maxSell2 = exit ? exit.usd : formula2;
    const sellMax = (i) => Math.floor(((i * (deepest / 2)) / (1 - i)) * k);
    return {
      address: a, chain, symbol: p.baseToken?.symbol ?? "?", verdict, score, flags, liquidity, liqKnown, maxSell2, exit, contractScanned: !!(sec || solSec),
      critical, url: p.url ?? null, ageH, at: now(), price: n(p.priceUsd),
      holders: n(sec?.holder_count ?? solSec?.gp?.holder_count),
      top10Pct,
      priceChange: { h1: n(p.priceChange?.h1), h6: n(p.priceChange?.h6), h24: n(p.priceChange?.h24) },
      flowH1: { buys: n(p.txns?.h1?.buys) ?? 0, sells: n(p.txns?.h1?.sells) ?? 0 },
      volume24h: n(p.volume?.h24), marketCap: n(p.marketCap) ?? n(p.fdv),
      sellMax: { p1: sellMax(0.01), p2: sellMax(0.02), p5: sellMax(0.05) },
      hook, sim, provenance: prov,
    };
  };
}
