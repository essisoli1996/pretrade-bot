import { writeFileSync } from "node:fs";
const out = [];
const get = async (u) => { const r = await fetch(u); return r.json().catch(() => ({})); };
const rpc = async (m, p) => { const r = await fetch("https://rpc.mainnet.chain.robinhood.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method: m, params: p }) }); return r.json().catch(() => ({})); };
let item = null;
for (const sort of ["hot", "volume", "new"]) {
  for (let p = 1; p <= 3 && !item; p++) {
    const r = await get(`https://musepad.lol/api/tokens?sort=${sort}&page=${p}`);
    const hit = (r.items ?? []).find((x) => /agrippa/i.test(x.symbol ?? "") || /agrippa/i.test(x.name ?? ""));
    if (hit) { item = { ...hit, foundIn: sort }; }
  }
}
out.push(`musepad: ${item ? JSON.stringify(item) : "not found in hot/volume/new"}`);
if (item) {
  const t = item.contractAddress.toLowerCase();
  const ds = await get(`https://api.dexscreener.com/tokens/v1/robinhood/${t}`);
  const p0 = (Array.isArray(ds) ? ds : [])[0];
  out.push(`dexscreener: ${p0 ? `liq $${Math.round(p0.liquidity?.usd ?? 0)} vol24 $${Math.round(p0.volume?.h24 ?? 0)} m5 ${p0.priceChange?.m5}% h1 ${p0.priceChange?.h1}% txns m5 ${JSON.stringify(p0.txns?.m5)} h1 ${JSON.stringify(p0.txns?.h1)} created ${new Date(p0.pairCreatedAt ?? 0).toISOString()}` : "no pair indexed"}`);
  const head = parseInt((await rpc("eth_blockNumber", [])).result, 16);
  const TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
  // last ~3h in 30-minute slices: unique receivers per slice = buyer arrival curve
  const perSlice = Math.round(1800 / 0.102);
  for (let k = 6; k >= 0; k--) {
    const to = head - k * perSlice, from = to - perSlice;
    const r = await rpc("eth_getLogs", [{ address: t, topics: [TR], fromBlock: "0x" + from.toString(16), toBlock: "0x" + to.toString(16) }]);
    if (r.error) { out.push(`slice -${k * 30}m: ERR ${JSON.stringify(r.error).slice(0, 80)}`); continue; }
    const rec = new Set((r.result ?? []).map((l) => "0x" + l.topics[2].slice(26)));
    out.push(`slice -${k * 30}m..-${(k - 1) * 30}m: ${(r.result ?? []).length} transfers, ${rec.size} distinct receivers`);
    await new Promise((s) => setTimeout(s, 300));
  }
  const mb = await get(`https://musebook.lol/api/search.json?q=${encodeURIComponent(item.symbol)}&limit=30`);
  const rs = (mb.results ?? []).map((x) => `${x.created_at} #${x.channel} ${x.name}`);
  out.push(`musebook mentions of ${item.symbol}: ${rs.length}`); out.push(...rs.slice(0, 12).map((x) => "  " + x));
}
writeFileSync("probe2.log", out.join("\n") + "\n"); console.log("done");
