// Explorer reads the Muse needs for receipts: who created a contract, and what moved in and out of an address.
// Etherscan's v2 API first (one key for every chain it serves), then the chain's Blockscout, which speaks the same
// "module/action" API with no key. Read-only; zero dependencies. The key never leaves through a result (redact).
import { codeKind } from "./archive.mjs";

/** Chain name → Etherscan v2 chain id and the Blockscout API root. */
export const EXPLORERS = Object.freeze({
  robinhood: { chainId: 4663, blockscout: "https://robinhoodchain.blockscout.com/api" },
  base: { chainId: 8453, blockscout: "https://base.blockscout.com/api" },
  ethereum: { chainId: 1, blockscout: "https://eth.blockscout.com/api" },
});

const addr = (a) => String(a ?? "").toLowerCase();

/** One getcontractcreation row → { creator, factory, txHash, timestamp }, or null. Pure. */
export function parseCreation(result) {
  const r = Array.isArray(result) ? result[0] : null;
  if (!r || !/^0x[0-9a-fA-F]{40}$/.test(r.contractCreator ?? r.creatorAddress ?? "")) return null;
  const factory = r.contractFactory && /^0x[0-9a-fA-F]{40}$/.test(r.contractFactory) ? addr(r.contractFactory) : null;
  return { creator: addr(r.contractCreator ?? r.creatorAddress), factory, txHash: r.txHash ?? r.transactionHash ?? null, timestamp: r.timestamp ? Number(r.timestamp) : null };
}

/**
 * tokentx rows for one address → what went out and what came in. Pure.
 * Amounts stay exact (BigInt base units) and are shown with the token's decimals.
 */
export function summarizeTransfers(rows, address) {
  const me = addr(address);
  const list = (Array.isArray(rows) ? rows : []).filter((r) => r && (addr(r.from) === me || addr(r.to) === me));
  const dec = Number(list[0]?.tokenDecimal ?? 18);
  const fmt = (v) => {
    const s = BigInt(v).toString().padStart(dec + 1, "0");
    const whole = s.slice(0, s.length - dec), frac = s.slice(s.length - dec).replace(/0+$/, "").slice(0, 6);
    return frac ? `${whole}.${frac}` : whole;
  };
  const side = (dir) => {
    const xs = list.filter((r) => (dir === "out" ? addr(r.from) === me : addr(r.to) === me) && addr(r.from) !== addr(r.to));
    const total = xs.reduce((t, r) => t + BigInt(r.value ?? 0), 0n);
    return { count: xs.length, total: fmt(total), rows: xs.map((r) => ({ counterparty: addr(dir === "out" ? r.to : r.from), amount: fmt(r.value ?? 0), hash: r.hash, time: Number(r.timeStamp ?? 0) })) };
  };
  return { symbol: list[0]?.tokenSymbol ?? null, decimals: dec, out: side("out"), in: side("in"), seen: list.length };
}

/**
 * http(url) → { ok, json }. rpcFor(chain) → rpc(method, params) or null. key: Etherscan key (optional).
 */
export function makeExplorer({ http, rpcFor, key = null, pageSize = 1000 }) {
  /** Etherscan v2 first, then Blockscout. → { ok, result, via } or { ok: false, error }. */
  async function query(chain, params) {
    const ex = EXPLORERS[chain];
    if (!ex) return { ok: false, error: `no explorer configured for ${chain}` };
    const qs = new URLSearchParams(params).toString();
    const tries = [
      ...(key ? [["etherscan", `https://api.etherscan.io/v2/api?chainid=${ex.chainId}&${qs}&apikey=${key}`]] : []),
      ["blockscout", `${ex.blockscout}?${qs}`],
    ];
    let last = "no answer";
    for (const [via, url] of tries) {
      const r = await http(url).catch((e) => ({ ok: false, json: null, text: String(e) }));
      const j = r?.json;
      if (j && String(j.status) === "1" && j.result !== undefined) return { ok: true, result: j.result, via };
      // an empty list is an answer, not a failure ("No transactions found")
      if (j && Array.isArray(j.result) && /no (transactions|records|token transfers) found/i.test(String(j.message ?? ""))) return { ok: true, result: [], via };
      last = String(j?.result ?? j?.message ?? r?.text ?? r?.status ?? "no answer").slice(0, 160);
    }
    return { ok: false, error: last };
  }

  /** Who created a contract: the creation record, the wallet that sent the creating transaction, and what each is. */
  async function creator(address, chain = "robinhood") {
    const q = await query(chain, { module: "contract", action: "getcontractcreation", contractaddresses: address });
    if (!q.ok) return { ok: false, error: q.error };
    const c = parseCreation(q.result);
    if (!c) return { ok: false, error: "no creation record for that address (not a contract, or not indexed yet)" };
    const rpc = rpcFor(chain);
    const kindOf = async (a) => (rpc ? codeKind((await rpc("eth_getCode", [a, "latest"]).catch(() => null))?.result ?? null) : null);
    // the transaction's sender is the wallet that started the launch, even when a factory contract did the CREATE
    const tx = rpc && c.txHash ? (await rpc("eth_getTransactionByHash", [c.txHash]).catch(() => null))?.result : null;
    const sender = tx?.from ? addr(tx.from) : null;
    const creatorKind = await kindOf(c.creator);
    const senderKind = sender && sender !== c.creator ? await kindOf(sender) : creatorKind;
    return { ok: true, via: q.via, ...c, creatorKind: creatorKind?.kind ?? null, sender, senderKind: senderKind?.kind ?? null };
  }

  /** A token's transfers in and out of one address (e.g. an escrow), oldest first. */
  async function transfers(token, address, chain = "base") {
    const q = await query(chain, { module: "account", action: "tokentx", contractaddress: token, address, page: "1", offset: String(pageSize), sort: "asc" });
    if (!q.ok) return { ok: false, error: q.error };
    const rows = Array.isArray(q.result) ? q.result : [];
    return { ok: true, via: q.via, capped: rows.length >= pageSize, ...summarizeTransfers(rows, address) };
  }

  return { query, creator, transfers };
}

/** Blockscout getTokenHolders rows + total supply → the GoPlus holder shape ({ address, percent }), biggest first. Pure. */
export function holdersShape(rows, totalSupply) {
  const supply = BigInt(totalSupply ?? 0);
  if (supply <= 0n || !Array.isArray(rows)) return [];
  return rows
    .filter((r) => /^0x[0-9a-fA-F]{40}$/.test(r?.address ?? ""))
    .map((r) => ({ address: String(r.address).toLowerCase(), balance: BigInt(r.value ?? 0) }))
    .sort((x, y) => (y.balance > x.balance ? 1 : y.balance < x.balance ? -1 : 0))
    .map((r) => ({ address: r.address, percent: String(Number((r.balance * 10n ** 12n) / supply) / 1e12) }));
}

/**
 * The biggest holders of a token from the chain's Blockscout, for when GoPlus has no list (fresh launches). Percent of
 * total supply read on-chain at the same time. → { holders, count } or null.
 */
export async function blockscoutHolders(token, chain, { http, rpc, limit = 20 }) {
  const ex = EXPLORERS[chain];
  if (!ex || !rpc) return null;
  const [list, supply] = await Promise.all([
    http(`${ex.blockscout}?module=token&action=getTokenHolders&contractaddress=${token}&page=1&offset=${limit}`).catch(() => null),
    rpc("eth_call", [{ to: token, data: "0x18160ddd" }, "latest"]).catch(() => null), // totalSupply()
  ]);
  const rows = list?.json?.result;
  if (!Array.isArray(rows) || !rows.length || typeof supply?.result !== "string" || supply.result.length < 3) return null;
  const holders = holdersShape(rows, BigInt(supply.result));
  return holders.length ? { holders, count: null } : null;
}
