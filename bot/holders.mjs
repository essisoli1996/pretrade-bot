import { releaseFunctions, generalPaths } from "./archive.mjs";
// Holder concentration for the token read.
const n = (v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));
const yes = (v) => v === "1" || v === 1 || v === true;
// Share of supply (%) held by the 10 biggest holders that are not pools, the token itself, burn addresses or locks.
// Contracts count: on robinhood most big holders are smart-contract wallets, and skipping every contract hid 9 of the
// top 10 on $MDOG (chiefofstaff re-walked 34.1% while this said ~2%).
const BURN = /^0x(0{40}|0{36}dead|000000000000000000000000000000000000dead)$/i;
export function top10Share(holders, poolish = []) {
  const skip = new Set(poolish.filter(Boolean).map((x) => String(x).toLowerCase()));
  const real = holders.filter((h) => !skip.has(String(h.address).toLowerCase()) && !BURN.test(String(h.address)) && !yes(h.is_locked) && !/pool|pair|lock|burn|dead|router|bridge/i.test(h.tag ?? ""));
  if (!real.length) return null; // every listed holder is a pool, lock or burn: the real holders aren't in view, not 0%
  return Math.round(real.slice(0, 10).reduce((t, h) => t + (n(h.percent) ?? 0), 0) * 1000) / 10;
}


/** What kind of holder an address is, from its runtime code (codeKind from archive.mjs) and, for contracts, the
 *  verified contract name. Plain words for a read: wallet, smart wallet, multisig, lock/vesting, pool/router, proxy… */
export function holderKind(code, name = null, sourceText = null) {
  if (code.kind === "no code") return "wallet";
  if (code.kind === "EIP-7702 wallet") return "smart wallet (7702)";
  const nm = String(name ?? "");
  if (/safe|gnosis|multisig/i.test(nm)) return `multisig (${nm})`;
  if (/lock|vest|timelock|escrow/i.test(nm)) {
    // with the verified source in hand: releasable, or no VISIBLE release path. Never "permanent": a proxy can be
    // upgraded, and a generic call or a transfer under another name can still move what's inside (RT-17)
    if (code.target) return `lock or vesting (${nm}), behind a proxy: its code can change`;
    if (sourceText) {
      const fns = releaseFunctions(sourceText);
      if (fns.length) return `lock or vesting (${nm}), releasable: ${fns.slice(0, 3).join(", ")}`;
      const other = generalPaths(sourceText);
      if (other.length) return `lock or vesting (${nm}), no release function but other ways to move tokens: ${other.slice(0, 3).join(", ")}`;
      return `lock (${nm}), no visible release path in verified source`;
    }
    return `lock or vesting (${nm})`;
  }
  if (/pool|pair|router|manager|vault/i.test(nm)) return `pool or router (${nm})`;
  if (/account|wallet/i.test(nm)) return `smart wallet (${nm})`;
  if (code.target) return `${code.kind.replace(/ \(.*\)/, "")} → ${code.target.slice(0, 6)}…${code.target.slice(-4)}${nm ? ` (${nm})` : ""}`;
  return nm ? `contract (${nm})` : "contract (unverified)";
}
