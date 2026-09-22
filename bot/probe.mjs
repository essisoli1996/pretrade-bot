import { readFileSync, writeFileSync } from "node:fs";
const out = [];
const j = async (b) => { const r = await fetch("https://rpc.mainnet.chain.robinhood.com", { method: "POST", headers: { "Content-Type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, ...b }) }); return r.json().catch((e) => ({ parseError: String(e) })); };
const head = parseInt((await j({ method: "eth_blockNumber", params: [] })).result, 16);
out.push(`head ${head}`);
for (const off of [1000, 1000000, 5000000, 20000000]) { const b = await j({ method: "eth_getBlockByNumber", params: ["0x" + (head - off).toString(16), false] }); out.push(`block head-${off}: ts ${b.result ? new Date(parseInt(b.result.timestamp, 16) * 1000).toISOString() : JSON.stringify(b).slice(0, 150)}`); }
const launched = Date.parse("2026-09-17T06:02:00Z") / 1000;
let lo = 0, hi = head, it = 0;
while (lo < hi && it < 40) { it++; const mid = Math.floor((lo + hi) / 2); const b = await j({ method: "eth_getBlockByNumber", params: ["0x" + mid.toString(16), false] }); if (!b.result) { out.push(`null at ${mid}: ${JSON.stringify(b).slice(0, 120)}`); break; } const ts = parseInt(b.result.timestamp, 16); if (ts < launched) lo = mid + 1; else hi = mid; }
out.push(`launch block ~${lo} after ${it} steps (head-${head - lo})`);
const T = "0xc43f61cd9e694990436564fc3648e48f89abacf0", TR = "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef";
const w = await j({ method: "eth_getLogs", params: [{ address: T, topics: [TR], fromBlock: "0x" + (lo - 9000).toString(16), toBlock: "0x" + head.toString(16) }] });
out.push(`whole range: ${w.error ? "ERR " + JSON.stringify(w.error).slice(0, 150) : w.result.length + " logs"}`);
const c = await j({ method: "eth_getLogs", params: [{ address: T, topics: [TR], fromBlock: "0x" + (lo - 9000).toString(16), toBlock: "0x" + (lo + 51000).toString(16) }] });
out.push(`first 60k after launch: ${c.error ? "ERR " + JSON.stringify(c.error).slice(0, 150) : c.result.length + " logs"}`);
const ts = await j({ method: "eth_call", params: [{ to: T, data: "0x18160ddd" }, "latest"] }); out.push(`totalSupply ${ts.result ?? JSON.stringify(ts.error)}`);
writeFileSync("radar-one.log", out.join("\n") + "\n"); console.log(out.join("\n"));
