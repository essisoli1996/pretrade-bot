// Offline tests for the stock-token check, approval audit and trade-plan logic. The fixtures are real response
// shapes: Robinhood's registry (api.robinhood.com/rhj/assets) and Chainlink's Robinhood feed directory.
// The chain-facing parts were exercised on a local chain (approvals: grant, revoke, audit, sign the given revoke;
// trade plan: 1% / 5% / 13% impact, honeypot, sell side, 30% skim hook). Run: node test/features.test.mjs
import { indexRegistry, indexFeeds, judgeStock } from "../bot/stocks.mjs";
import { latestGrants, grantRisk, revokeTx } from "../bot/approvals.mjs";
import { planAdvice } from "../bot/sim.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };
const TRADABLE = { whole: "TRADING_STATUS_TRADABLE", fractional: "TRADING_STATUS_TRADABLE" };

// ── stock tokens ──
const registry = { assets: [
  { id: "0x01", tokenSymbol: "CRM", tokenName: "Salesforce • Robinhood Token", deployments: [{ contractAddress: "0xd95B44124e475743a7589e68F3D74008A5536D44", chainId: 4663 }], currentMultiplier: "1.001148322800714293", pendingMultiplier: "", status: "ASSET_STATUS_ACTIVE", tradingCapabilities: { market: TRADABLE, extended: TRADABLE, overnight: TRADABLE }, tokenDecimals: 18, isin: "US79466L3024" },
  { id: "0x02", tokenSymbol: "TSLA", tokenName: "Tesla • Robinhood Token", deployments: [{ contractAddress: "0x322F0929c4625eD5bAd873c95208D54E1c003b2d", chainId: 4663 }], currentMultiplier: "1.0", pendingMultiplier: "3.0", status: "ASSET_STATUS_ACTIVE", tradingCapabilities: { market: TRADABLE }, isin: "US88160R1014" },
  { id: "0x03", tokenSymbol: "OLD", tokenName: "Elsewhere", deployments: [{ contractAddress: "0x0000000000000000000000000000000000000001", chainId: 1 }] },
] };
const reg = indexRegistry(registry);
check(reg.byTicker.get("CRM")?.address === "0xd95b44124e475743a7589e68f3d74008a5536d44" && reg.byAddr.size === 2, "registry: Robinhood Chain deployments only, addresses lowercased");
const feeds = indexFeeds([
  { name: "Robinhood RGTI / USD", proxyAddress: "0x2A045cF1C49c61c166C036d2f06FA2D2d984f765", decimals: 8, heartbeat: 86400, docs: { assetClass: "Equity", baseAsset: "RGTI", productTypeCode: "primaryTokenizedPrice", marketHours: "us_equities_24/5" } },
  { name: "USDT / USD", proxyAddress: "0xbf3550B6fAe1671da7C238Af12e03Ac586BEf3B1", decimals: 8, docs: { assetClass: "Crypto", baseAsset: "USDT" } },
]);
check(feeds.size === 1 && feeds.get("RGTI")?.proxy === "0x2a045cf1c49c61c166c036d2f06fa2d2d984f765", "feeds: equity feeds only, keyed by ticker");

const crm = reg.byTicker.get("CRM"), tsla = reg.byTicker.get("TSLA");
const now = Date.UTC(2026, 8, 23);
check(judgeStock({ official: crm, paused: false, feed: { price: 250, updatedAt: now / 1000 - 600 }, dexPrice: 251, now }).verdict === "OFFICIAL", "official, active, DEX within 0.4%: OFFICIAL");
check(judgeStock({ official: crm, paused: true, now }).verdict === "DANGER", "paused contract: DANGER");
const prem = judgeStock({ official: crm, paused: false, feed: { price: 250, updatedAt: now / 1000 - 600 }, dexPrice: 265, now });
check(prem.verdict === "CAUTION" && prem.premiumPct === 6, "DEX 6% above Chainlink: CAUTION, premium reported");
check(judgeStock({ official: crm, paused: false, feed: { price: 250, updatedAt: now / 1000 - 5 * 86400 }, dexPrice: 300, now }).flags.some((f) => f.code === "REFERENCE_STALE"), "stale reference (market closed): premium not judged");
check(judgeStock({ official: tsla, paused: false, now }).flags.some((f) => f.code === "CORPORATE_ACTION_PENDING"), "pending multiplier 1 → 3: corporate action flagged");
const copy = judgeStock({ official: null, officialForTicker: tsla });
check(copy.verdict === "COPYCAT" && copy.flags[0].detail.includes("0x322f0929c4625ed5bad873c95208d54e1c003b2d"), "same ticker, other contract: COPYCAT, real address given");
check(judgeStock({ official: null, officialForTicker: null }).verdict === "NOT_A_STOCK_TOKEN", "unrelated token: NOT_A_STOCK_TOKEN");

// ── approvals ──
const ME = "0x" + "11".repeat(20), T1 = "0x" + "aa".repeat(20), S1 = "0x" + "bb".repeat(20), NFT = "0x" + "cc".repeat(20);
const t = (a) => "0x" + a.slice(2).padStart(64, "0");
const A = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const g = latestGrants([
  { address: T1, topics: [A, t(ME), t(S1)], data: "0x1", blockNumber: "0x10", logIndex: "0x0" },
  { address: T1, topics: [A, t(ME), t(S1)], data: "0x0", blockNumber: "0x20", logIndex: "0x1" },
  { address: NFT, topics: [ALL, t(ME), t(S1)], data: "0x1", blockNumber: "0x05", logIndex: "0x0" },
  { address: NFT, topics: [A, t(ME), t(S1), t("0x07")], data: "0x", blockNumber: "0x06", logIndex: "0x0" },
]);
check(g.length === 2 && g.find((x) => x.kind === "erc20").block === 32, "latest grant per (token, spender); single-NFT approvals skipped");
const U = 2n ** 256n - 1n;
check(grantRisk({ kind: "erc20", amount: U, spenderIsContract: false }).level === "critical", "unlimited to a plain wallet: critical");
check(grantRisk({ kind: "erc20", amount: U, spenderIsContract: true, spenderLabel: "Permit2" }).level === "low", "unlimited to a known protocol: low");
check(grantRisk({ kind: "erc20", amount: U, spenderIsContract: true }).level === "medium", "unlimited to an unknown contract: medium");
check(grantRisk({ kind: "all", spenderIsContract: true }).level === "high", "collection-wide approval to an unknown contract: high");
check(grantRisk({ kind: "erc20", amount: 5n, spenderIsContract: true, flagged: ["phishing activities"] }).level === "critical", "flagged spender: critical");
check(revokeTx({ kind: "erc20", token: T1, spender: S1 }, ME).data === "0x095ea7b3" + "0".repeat(24) + "bb".repeat(20) + "0".repeat(64), "revoke = approve(spender, 0)");
check(revokeTx({ kind: "all", token: NFT, spender: S1 }, ME).data.startsWith("0xa22cb465"), "revoke all = setApprovalForAll(operator, false)");

// ── trade plan ──
const E = 10n ** 18n;
const res = (out, extra = {}) => ({ ok: true, block: 1, side: "buy", amountIn: 10n * E, out, refIn: E / 100n, refOut: (E / 100n) * 997n / 1000n, sellBackFails: false, roundTripBack: null, ...extra });
check(planAdvice(res((10n * E * 987n) / 1000n)).verdict === "GO", "1% impact: GO");
const mid = planAdvice(res((10n * E * 95n) / 100n), { usd: 500 });
check(mid.verdict === "CAUTION" && mid.split?.pieces >= 3 && mid.split.usdEach > 0, "~4.7% impact: CAUTION with a split");
check(planAdvice(res((10n * E * 85n) / 100n)).verdict === "NO_GO", "~15% impact: NO_GO");
check(planAdvice(res((10n * E * 99n) / 100n), { m5: 3 }).slippagePct === 5, "volatile (5m +3%): slippage capped at 5%");
check(planAdvice(res((10n * E * 99n) / 100n)).slippagePct === 0.5, "calm: 0.5% slippage");
check(planAdvice(res(9n * E, { sellBackFails: true })).verdict === "NO_GO", "sell-back reverts: NO_GO");
check(planAdvice(res(null, { why: "reverted" })).verdict === "NO_GO", "buy reverts: NO_GO");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
