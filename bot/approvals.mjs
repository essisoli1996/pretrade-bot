// Wallet approval audit: every token approval a wallet has granted that is STILL live, who holds it, and a ready
// revoke transaction for the risky ones. Agents approve routers all day; a forgotten unlimited approval to the wrong
// contract is how a wallet gets drained weeks later.
// Reads Approval / ApprovalForAll logs where the wallet is the owner, then the CURRENT allowance for each
// (token, spender): approvals that were revoked or used up don't count. Read-only; zero dependencies.

const T_APPROVAL = "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925";
const T_APPROVAL_ALL = "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31";
const UNLIMITED = 2n ** 255n;
const pad = (a) => "0x" + a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
const topicAddr = (t) => "0x" + String(t).slice(-40).toLowerCase();

/** Latest approval event per (token, spender) from raw logs. Pure, unit tested. */
export function latestGrants(logs) {
  const m = new Map();
  for (const l of logs ?? []) {
    const t = (l.topics ?? []).map((x) => String(x).toLowerCase());
    if (t.length < 3) continue;
    const token = String(l.address ?? "").toLowerCase(), spender = topicAddr(t[2]);
    let kind;
    if (t[0] === T_APPROVAL && t.length === 3) kind = "erc20";
    else if (t[0] === T_APPROVAL_ALL) kind = "all";
    else continue; // ERC-721 single-token approvals clear on transfer; not tracked
    const k = `${kind}|${token}|${spender}`;
    const at = [parseInt(l.blockNumber ?? "0x0", 16), parseInt(l.logIndex ?? "0x0", 16)];
    const prev = m.get(k);
    if (!prev || at[0] > prev.at[0] || (at[0] === prev.at[0] && at[1] > prev.at[1])) m.set(k, { kind, token, spender, at, block: at[0] });
  }
  return [...m.values()];
}

/**
 * Risk for one live grant. Pure, unit tested.
 * g: { kind, amount (bigint, erc20), spenderIsContract, spenderLabel, flagged: [] }
 */
export function grantRisk(g) {
  const why = [];
  let level = "low";
  const bump = (l) => { const o = { low: 0, medium: 1, high: 2, critical: 3 }; if (o[l] > o[level]) level = l; };
  if (g.flagged?.length) { bump("critical"); why.push(`spender is flagged for ${g.flagged.join(", ")}`); }
  if (g.spenderIsContract === false) { bump(g.kind === "all" || g.amount >= UNLIMITED ? "critical" : "high"); why.push("spender is a plain wallet, not a protocol contract"); }
  if (g.kind === "all") { bump(g.spenderLabel ? "medium" : "high"); why.push("can move every item in the collection"); }
  else if (g.amount >= UNLIMITED) { bump(g.spenderLabel ? "low" : "medium"); why.push("unlimited amount"); }
  if (!g.spenderLabel && g.spenderIsContract) why.push("unrecognised contract");
  if (g.spenderLabel) why.push(`spender: ${g.spenderLabel}`);
  return { level, why };
}

/** A zero-cost revoke for one grant, ready to sign: approve(spender, 0) or setApprovalForAll(operator, false). */
export function revokeTx(g, owner) {
  const spender = g.spender.replace(/^0x/, "").padStart(64, "0");
  return g.kind === "all"
    ? { from: owner, to: g.token, data: "0xa22cb465" + spender + "0".repeat(64), value: "0x0" }
    : { from: owner, to: g.token, data: "0x095ea7b3" + spender + "0".repeat(64), value: "0x0" };
}

export function makeApprovals({ rpcFor, known = {}, reputation = null }) {
  async function logs(rpc, wallet) {
    const q = (topic) => rpc("eth_getLogs", [{ topics: [topic, pad(wallet)], fromBlock: "0x0", toBlock: "latest" }]);
    const [a, b] = [await q(T_APPROVAL), await q(T_APPROVAL_ALL)];
    const err = a?.error ?? b?.error;
    if (err) return { error: String(err.message ?? err.code).slice(0, 120) };
    return { logs: [...(a.result ?? []), ...(b.result ?? [])] };
  }

  /** chain: "robinhood" | "base" | … (whatever rpcFor knows). */
  async function audit(wallet, chain) {
    const rpc = rpcFor(chain);
    if (!rpc) return { error: `no RPC for ${chain}` };
    const owner = wallet.toLowerCase();
    const got = await logs(rpc, owner);
    if (got.error) return { error: `this RPC won't search the whole history (${got.error})` };
    const grants = latestGrants(got.logs);
    const live = [];
    for (const g of grants.slice(0, 60)) {
      if (g.kind === "erc20") {
        const r = await rpc("eth_call", [{ to: g.token, data: "0xdd62ed3e" + pad(owner).slice(2) + pad(g.spender).slice(2) }, "latest"]);
        const amt = typeof r?.result === "string" && r.result.length >= 66 ? BigInt(r.result.slice(0, 66)) : 0n;
        if (amt > 0n) live.push({ ...g, amount: amt });
      } else {
        const r = await rpc("eth_call", [{ to: g.token, data: "0xe985e9c5" + pad(owner).slice(2) + pad(g.spender).slice(2) }, "latest"]);
        if (typeof r?.result === "string" && r.result.length >= 66 && BigInt(r.result.slice(0, 66)) === 1n) live.push(g);
      }
    }
    const meta = new Map();
    const symbol = async (token) => {
      if (meta.has(token)) return meta.get(token);
      const [s, d] = [await rpc("eth_call", [{ to: token, data: "0x95d89b41" }, "latest"]), await rpc("eth_call", [{ to: token, data: "0x313ce567" }, "latest"])];
      let sym = null;
      try { const h = String(s?.result ?? "").slice(2); if (h.length >= 192) sym = new TextDecoder().decode(Uint8Array.from(h.slice(128, 128 + 2 * parseInt(h.slice(64, 128), 16)).match(/../g).map((b) => parseInt(b, 16)))); } catch {}
      let dec = null; try { dec = Number(BigInt(d?.result)); } catch {}
      const v = { symbol: sym && /^[\x20-\x7e]{1,16}$/.test(sym) ? sym : null, decimals: dec !== null && dec <= 36 ? dec : null };
      meta.set(token, v);
      return v;
    };
    const codeCache = new Map();
    const isContract = async (a) => {
      if (codeCache.has(a)) return codeCache.get(a);
      const c = (await rpc("eth_getCode", [a, "latest"]))?.result;
      const v = typeof c === "string" ? c !== "0x" && !c.toLowerCase().startsWith("0xef0100") : null;
      codeCache.set(a, v);
      return v;
    };
    const out = [];
    for (const g of live) {
      const m = await symbol(g.token);
      const spenderIsContract = await isContract(g.spender);
      const flagged = reputation ? await reputation(g.spender) : [];
      const risk = grantRisk({ ...g, spenderIsContract, spenderLabel: known[g.spender] ?? null, flagged });
      const amount = g.kind === "all" ? "ALL" : g.amount >= UNLIMITED ? "UNLIMITED"
        : m.decimals === null ? g.amount.toString() : (Number(g.amount) / 10 ** m.decimals).toLocaleString("en-US", { maximumFractionDigits: 4 });
      out.push({ token: g.token, symbol: m.symbol, spender: g.spender, spenderLabel: known[g.spender] ?? null, kind: g.kind, amount, grantedAtBlock: g.block, risk: risk.level, why: risk.why, revoke: risk.level === "low" ? null : revokeTx(g, owner) });
    }
    const order = { critical: 0, high: 1, medium: 2, low: 3 };
    out.sort((a, b) => order[a.risk] - order[b.risk]);
    return { wallet: owner, chain, scannedGrants: grants.length, live: out.length, approvals: out };
  }
  return { audit };
}
