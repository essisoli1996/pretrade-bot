// Pre-signing simulation for "@pretrade sign": runs the exact transaction someone is about to sign on the current
// block with eth_simulateV1 (traceTransfers on, so plain ETH moves show up as transfer logs too) and reports what
// actually leaves and enters the wallet, and every approval it grants, including ones buried inside a multicall.
// Nothing is signed or sent. The signer's ETH balance is topped up in the simulation only, so "insufficient funds"
// doesn't hide what the call would do.
//
// Honest limits, stated in every result: it is true for that block only (the chain can change before the real
// transaction lands), and a contract can behave differently for a simulation than for the real thing.
// Where eth_simulateV1 isn't available it falls back to eth_call: success or revert only, no asset changes.
// Zero dependencies.
import { revertReason } from "./sim.mjs";

const TOPIC = {
  transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef",
  approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925",
  approvalForAll: "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31",
  transferSingle: "0xc3d58168c5ae7397731d063d5bbf3d657854427343f4c083240f7aacaa2d0f62",
  transferBatch: "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb",
};
export const NATIVE = "0xeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeeee"; // eth_simulateV1 traceTransfers pseudo-token for ETH
const UNLIMITED = 2n ** 255n;
const ADDR = /^0x[0-9a-fA-F]{40}$/;
const topicAddr = (t) => "0x" + String(t).slice(-40).toLowerCase();
const big = (h) => { try { return BigInt(h && h !== "0x" ? h : "0x0"); } catch { return 0n; } };

/** Finds a transaction in pasted text: a tx object, an eth_sendTransaction request, or {params:[tx]}. */
export function parseTx(text, chainById = {}) {
  const s = String(text ?? "");
  const start = s.indexOf("{"), end = s.lastIndexOf("}");
  if (start < 0 || end <= start) return null;
  let j;
  try { j = JSON.parse(s.slice(start, end + 1)); } catch { return null; }
  const tx = Array.isArray(j?.params) ? j.params[0] : j?.tx ?? j?.transaction ?? j;
  if (!tx || typeof tx !== "object" || !ADDR.test(String(tx.to ?? ""))) return null;
  const data = String(tx.data ?? tx.input ?? "0x");
  if (!/^0x([0-9a-fA-F]{2})*$/.test(data)) return null;
  const cid = tx.chainId ?? j.chainId;
  const chainId = cid === undefined ? null : Number(typeof cid === "string" && cid.startsWith("0x") ? parseInt(cid, 16) : cid);
  const value = tx.value === undefined ? 0n : big(typeof tx.value === "number" ? "0x" + tx.value.toString(16) : String(tx.value).startsWith("0x") ? tx.value : "0x" + BigInt(tx.value).toString(16));
  return {
    from: ADDR.test(String(tx.from ?? "")) ? String(tx.from).toLowerCase() : null,
    to: String(tx.to).toLowerCase(), data: data.toLowerCase(), value,
    chainId, chain: chainId !== null ? chainById[chainId] ?? null : null,
  };
}

/** Turns logs into per-asset changes for `who` plus the approvals `who` granted. Pure, unit tested. */
export function effectsFor(logs, who) {
  const me = who.toLowerCase();
  const moves = new Map(); // key token or token#id → { token, id, kind, out, in, to: Set }
  const approvals = [];
  const bump = (token, id, kind, dir, amt, other) => {
    const k = id === null ? token : `${token}#${id}`;
    const m = moves.get(k) ?? { token, id, kind, out: 0n, in: 0n, counterparties: new Set() };
    m[dir] += amt; if (other) m.counterparties.add(other);
    moves.set(k, m);
  };
  for (const l of logs ?? []) {
    const t = (l.topics ?? []).map((x) => String(x).toLowerCase());
    const addr = String(l.address ?? "").toLowerCase();
    if (t[0] === TOPIC.transfer && t.length >= 3) {
      const from = topicAddr(t[1]), to = topicAddr(t[2]);
      const nft = t.length === 4;
      const amt = nft ? 1n : big(l.data);
      const id = nft ? big(t[3]).toString() : null;
      const kind = addr === NATIVE ? "native" : nft ? "erc721" : "erc20";
      if (from === me) bump(addr, id, kind, "out", amt, to);
      if (to === me) bump(addr, id, kind, "in", amt, from);
    } else if (t[0] === TOPIC.approval && t.length >= 3 && topicAddr(t[1]) === me) {
      if (t.length === 4) approvals.push({ token: addr, spender: topicAddr(t[2]), kind: "erc721", id: big(t[3]).toString() });
      else approvals.push({ token: addr, spender: topicAddr(t[2]), kind: "erc20", amount: big(l.data) });
    } else if (t[0] === TOPIC.approvalForAll && t.length >= 3 && topicAddr(t[1]) === me) {
      approvals.push({ token: addr, spender: topicAddr(t[2]), kind: "all", approved: big(l.data) === 1n });
    } else if ((t[0] === TOPIC.transferSingle || t[0] === TOPIC.transferBatch) && t.length >= 4) {
      const from = topicAddr(t[2]), to = topicAddr(t[3]);
      const d = String(l.data ?? "").replace(/^0x/, "");
      const w = (i) => big("0x" + d.slice(64 * i, 64 * (i + 1)));
      const pairs = [];
      if (t[0] === TOPIC.transferSingle) pairs.push([w(0), w(1)]);
      else {
        const ids = Number(w(0)) / 32, vals = Number(w(1)) / 32, n = Number(w(ids));
        for (let i = 0; i < Math.min(n, 50); i++) pairs.push([w(ids + 1 + i), w(vals + 1 + i)]);
      }
      for (const [id, amt] of pairs) {
        if (from === me) bump(addr, id.toString(), "erc1155", "out", amt, to);
        if (to === me) bump(addr, id.toString(), "erc1155", "in", amt, from);
      }
    }
  }
  // one hop further: where the first recipient sends the same asset on, inside the same transaction
  const forwards = [];
  const firstHops = new Set([...moves.values()].filter((m) => m.out > 0n).flatMap((m) => [...m.counterparties].map((c) => `${m.token}|${c}`)));
  for (const l of logs ?? []) {
    const t = (l.topics ?? []).map((x) => String(x).toLowerCase());
    if (t[0] !== TOPIC.transfer || t.length !== 3) continue;
    const token = String(l.address ?? "").toLowerCase(), from = topicAddr(t[1]), to = topicAddr(t[2]);
    if (firstHops.has(`${token}|${from}`) && to !== me) forwards.push({ token, via: from, to, amount: big(l.data) });
  }
  return { moves: [...moves.values()].map((m) => ({ ...m, counterparties: [...m.counterparties] })), approvals, forwards };
}

export function makeTxSim({ rpcFor }) {
  async function meta(rpc, token) {
    if (token === NATIVE) return { symbol: "ETH", decimals: 18 };
    const call = async (data) => (await rpc("eth_call", [{ to: token, data }, "latest"]))?.result;
    const [sym, dec] = [await call("0x95d89b41"), await call("0x313ce567")];
    let symbol = null;
    try {
      const h = String(sym ?? "").replace(/^0x/, "");
      if (h.length >= 192) symbol = new TextDecoder().decode(Uint8Array.from(h.slice(128, 128 + 2 * parseInt(h.slice(64, 128), 16)).match(/../g).map((b) => parseInt(b, 16))));
      else if (h.length === 64) symbol = new TextDecoder().decode(Uint8Array.from(h.match(/../g).map((b) => parseInt(b, 16)).filter((b) => b)));
    } catch {}
    const decimals = dec && dec !== "0x" ? Number(big(dec)) : null;
    return { symbol: symbol && /^[\x20-\x7e]{1,16}$/.test(symbol) ? symbol : null, decimals: decimals !== null && decimals <= 36 ? decimals : null };
  }

  /** Runs the tx on the chain's current block. Returns {method, block, ok, revert, moves, approvals} or {error}. */
  async function simulate(tx, chain) {
    const rpc = rpcFor(chain);
    if (!rpc) return { error: `no RPC configured for ${chain}` };
    if (!tx.from) return { error: "the transaction has no \"from\": whose wallet would sign it?" };
    const head = (await rpc("eth_blockNumber", []))?.result;
    if (typeof head !== "string") return { error: `${chain} RPC unreachable` };
    const call = { from: tx.from, to: tx.to, data: tx.data, value: "0x" + tx.value.toString(16) };
    const topUp = { [tx.from]: { balance: "0x" + (tx.value + 10n ** 20n).toString(16) } }; // gas money, in the simulation only
    const r = await rpc("eth_simulateV1", [{ blockStateCalls: [{ stateOverrides: topUp, calls: [call] }], traceTransfers: true, validation: false }, head]);
    const c = r?.result?.[0]?.calls?.[0];
    if (c) {
      const ok = c.status === "0x1";
      const eff = ok ? effectsFor(c.logs ?? [], tx.from) : { moves: [], approvals: [], forwards: [] };
      const tokens = [...new Set([...eff.moves.map((m) => m.token), ...eff.approvals.map((a) => a.token)])].slice(0, 8);
      const info = {};
      for (const t of tokens) info[t] = await meta(rpc, t);
      const why = ok ? null : c.returnData && c.returnData !== "0x" ? revertReason(c.returnData) : String(c.error?.message ?? "reverted");
      return { method: "eth_simulateV1", chain, block: parseInt(head, 16), ok, revert: why ? why.slice(0, 120) : null, ...eff, info };
    }
    // no eth_simulateV1 here: eth_call can still say whether it would go through
    const e = await rpc("eth_call", [call, head, topUp]);
    if (e?.result !== undefined) return { method: "eth_call", chain, block: parseInt(head, 16), ok: true, revert: null, moves: null, approvals: null, forwards: null, info: {} };
    const why = e?.error?.data && /^0x[0-9a-f]{8}/i.test(e.error.data) ? revertReason(e.error.data) : String(e?.error?.message ?? "reverted");
    return { method: "eth_call", chain, block: parseInt(head, 16), ok: false, revert: why.slice(0, 120), moves: null, approvals: null, forwards: null, info: {} };
  }
  return { simulate };
}

const fmt = (amt, dec) => {
  if (dec === null || dec === undefined) return amt.toString() + " (raw units)";
  if (amt >= UNLIMITED) return "UNLIMITED";
  const s = amt.toString().padStart(dec + 1, "0");
  const whole = s.slice(0, s.length - dec), frac = s.slice(s.length - dec).replace(/0+$/, "").slice(0, 6);
  return frac ? `${whole}.${frac}` : whole;
};
const short = (a) => `${a.slice(0, 6)}…${a.slice(-4)}`;

/**
 * Human lines and risk findings from a simulation. Pure, unit tested.
 * plainSend: the decoded call is a direct transfer (or empty calldata), so "value leaves, nothing returns" is expected.
 */
export function describeTxSim(sim, { plainSend = false } = {}) {
  if (!sim || sim.error) return { lines: [`🧪 couldn't simulate it (${sim?.error ?? "no result"}).`], findings: [], counterparties: [] };
  const where = `${sim.chain} block ${sim.block}`;
  if (!sim.ok) return { lines: [`🧪 simulated on ${where}: it would FAIL right now (${sim.revert}). a failing transaction still costs gas.`], findings: [], counterparties: [] };
  if (sim.moves === null) return { lines: [`🧪 simulated on ${where}: it would go through. this RPC can't show asset changes, so read the decoded call carefully.`], findings: [], counterparties: [] };
  const name = (m) => { const i = sim.info[m.token] ?? {}; return m.kind === "native" ? "ETH" : i.symbol ? `$${i.symbol}` : `token ${short(m.token)}`; };
  const amount = (m, dir) => m.kind === "erc721" ? `NFT #${m.id}` : m.kind === "erc1155" ? `${m[dir]}× item #${m.id}` : fmt(m[dir], (sim.info[m.token] ?? {}).decimals);
  const outs = sim.moves.filter((m) => m.out > m.in).map((m) => ({ ...m, out: m.out - m.in }));
  const ins = sim.moves.filter((m) => m.in > m.out).map((m) => ({ ...m, in: m.in - m.out }));
  const findings = [], counterparties = [];
  const lines = [`🧪 simulated on ${where}:`];
  lines.push(outs.length ? `  you send: ${outs.map((m) => `${amount(m, "out")} ${name(m)} → ${m.counterparties.map(short).join(", ")}`).join("; ")}` : "  you send: nothing");
  for (const f of (sim.forwards ?? []).slice(0, 3)) {
    const m = { token: f.token, kind: f.token === NATIVE ? "native" : "erc20", out: f.amount };
    lines.push(`  …which ${short(f.via)} passes straight on: ${amount(m, "out")} ${name(m)} → ${short(f.to)}`);
    counterparties.push({ addr: f.to, role: "forwarded to", chain: sim.chain, nothingBack: !ins.length });
  }
  lines.push(ins.length ? `  you receive: ${ins.map((m) => `${amount(m, "in")} ${name(m)}`).join("; ")}` : "  you receive: nothing");
  for (const a of sim.approvals) {
    const tok = (sim.info[a.token] ?? {}).symbol ? `$${sim.info[a.token].symbol}` : `token ${short(a.token)}`;
    counterparties.push({ addr: a.spender, role: "spender", chain: sim.chain });
    if (a.kind === "all") {
      lines.push(`  approval: ${a.approved ? "ALL" : "revokes all"} items of ${tok} → ${short(a.spender)}`);
      if (a.approved) findings.push({ why: `the transaction hands ${short(a.spender)} every item in ${tok}`, pts: 60, crit: true });
    } else if (a.kind === "erc721") {
      lines.push(`  approval: NFT #${a.id} of ${tok} → ${short(a.spender)}`);
    } else {
      const unl = a.amount >= UNLIMITED;
      lines.push(`  approval: ${unl ? "UNLIMITED" : fmt(a.amount, (sim.info[a.token] ?? {}).decimals)} ${tok} → ${short(a.spender)}`);
      if (unl) findings.push({ why: `the transaction grants ${short(a.spender)} an unlimited ${tok} approval${sim.approvals.length > 1 ? " (one of several approvals in one transaction)" : ""}`, pts: 40 });
    }
  }
  if (outs.length && !ins.length && !plainSend) {
    findings.push({ why: "value leaves your wallet and nothing comes back in this transaction. normal for bridges, deposits and payments; a drain looks exactly the same", pts: 30 });
  }
  const recipients = new Set(outs.flatMap((m) => m.counterparties));
  if (outs.length >= 3 && recipients.size >= 2) findings.push({ why: `${outs.length} different assets leave your wallet in one transaction: the sweep shape drainers use`, pts: 50, crit: true });
  for (const r of recipients) counterparties.push({ addr: r, role: "recipient", chain: sim.chain });
  lines.push(`  true for this block only: the chain can change before a real transaction lands, and a contract can act differently for a simulation.`);
  return { lines, findings, counterparties };
}
