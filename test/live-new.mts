// Runs the trade-plan, stock-check and approvals handlers locally against the REAL chains, without payment.
// Run: npx tsx test/live-new.mts
import tradePlan from "../x402/trade-plan/index.ts";
import stockCheck from "../x402/stock-check/index.ts";
import approvals from "../x402/approvals/index.ts";

const call = async (h: any, q: string) => {
  const t0 = Date.now();
  const r = await h(new Request(`https://local/${q}`));
  const body: any = await r.json();
  return { status: r.status, ms: Date.now() - t0, body };
};
const show = (label: string, r: any, pick: (b: any) => unknown) => console.log(`${label}: HTTP ${r.status} in ${r.ms} ms → ${JSON.stringify(r.status === 200 ? pick(r.body) : r.body)}`);
const WALLET = "0xf4a46667d75fa9663ab7a297af20d3623aaa8b52";
show("trade-plan PRINTER buy $250", await call(tradePlan, "trade-plan?address=0x85a574f2ff0795685f58d1d7b0d4b51f148ac489&usd=250"), (b) => [b.verdict, b.impactPct, b.slippagePct, b.expectedOut?.amount, b.amountOutMinimum?.amount]);
show("trade-plan BILL buy $500", await call(tradePlan, "trade-plan?address=0x4e9c619228dc53f9b57c7357208863d256b9cd69&usd=500"), (b) => [b.verdict, b.impactPct, b.split]);
show("trade-plan FRONG sell $1000", await call(tradePlan, "trade-plan?address=0x6245e67affa44a23077f0ea7f981a8dc743a0c47&usd=1000&side=sell"), (b) => [b.verdict, b.expectedOut?.amount, b.expectedOut?.symbol]);
show("stock-check TSLA", await call(stockCheck, "stock-check?ticker=TSLA"), (b) => [b.verdict, b.reference?.priceUsd, b.dex?.priceUsd, b.dex?.premiumPct, b.copycats?.length]);
show("stock-check NVDA", await call(stockCheck, "stock-check?ticker=NVDA"), (b) => [b.verdict, b.official?.address, b.reference?.priceUsd, b.dex?.premiumPct]);
// the bot module directly, without the handler's 25s cap, to see where the time goes
// @ts-ignore
const { makeApprovals } = await import("../bot/approvals.mjs");
const httpJ = async (u: string, body?: unknown) => { const r = await fetch(u, body ? { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify(body) } : {}); const text = await r.text(); let json = null; try { json = JSON.parse(text); } catch {} return { ok: r.ok, status: r.status, json, text }; };
const direct = await makeApprovals({ http: httpJ, rpcFor: () => async (method: string, params: unknown[]) => { const r = await httpJ("https://mainnet.base.org", { jsonrpc: "2.0", id: 1, method, params }); return r.json ?? { error: { code: r.status, message: r.text.slice(0, 80) } }; } }).audit(WALLET, "base");
console.log("approvals base, direct:", JSON.stringify({ timings: direct.timings, live: direct.live, scanned: direct.scannedGrants, unread: direct.approvals?.filter((x: any) => x.why.some((w: string) => /unreadable/.test(w))).length }));
show("approvals base", await call(approvals, `approvals?wallet=${WALLET}&chain=base`), (b) => [b.historySource, b.scannedGrants, b.live, b.worthRevoking, b.approvals?.slice(0, 3).map((x: any) => [x.symbol, x.amount, x.spenderLabel ?? x.spender, x.risk])]);
show("approvals robinhood", await call(approvals, `approvals?wallet=${WALLET}&chain=robinhood`), (b) => [b.historySource, b.scannedGrants, b.live, b.worthRevoking]);
