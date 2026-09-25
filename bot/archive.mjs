// Past-block reads and verified sources for Robinhood Chain. Keys never live in the repo: they come from the environment
// (GitHub secrets NODEFLARE_KEY / ETHERSCAN_KEY) or from a keys file next to the Muse's identity (KEY=value lines).
import { readFileSync, existsSync } from "node:fs";

/** Loads KEY=value lines into process.env without overriding what is already set. Returns the names loaded. */
export function loadKeysFile(path) {
  if (!path || !existsSync(path)) return [];
  const loaded = [];
  for (const line of readFileSync(path, "utf8").split("\n")) {
    const m = line.match(/^\s*([A-Z][A-Z0-9_]*)\s*=\s*(.*?)\s*$/);
    if (m && !process.env[m[1]]) { process.env[m[1]] = m[2].replace(/^["']|["']$/g, ""); loaded.push(m[1]); }
  }
  return loaded;
}

/** The archive RPC for Robinhood Chain: ARCHIVE_RPC_URL as given, else NodeFlare's keyed endpoint. */
export const archiveUrl = (env = process.env) => env.ARCHIVE_RPC_URL || (env.NODEFLARE_KEY ? `https://rpc.nodeflare.app/robinhood/${env.NODEFLARE_KEY}` : null);

/** Hides any key in a URL or message before it is printed. */
export const redact = (text, env = process.env) => [env.NODEFLARE_KEY, env.ETHERSCAN_KEY, env.ARCHIVE_RPC_URL].filter(Boolean).reduce((t, k) => t.split(k).join("<key>"), String(text));

const EIP1167 = /^0x363d3d373d3d3d363d73([0-9a-f]{40})5af43d82803e903d91602b57fd5bf3$/i;
const EIP7702 = /^0xef0100([0-9a-f]{40})$/i;

/** What a piece of runtime code is: nothing, a 7702-delegated wallet, a standard EIP-1167 clone, or a contract. */
export function codeKind(hex) {
  const code = String(hex ?? "0x").toLowerCase();
  if (code === "0x" || code === "") return { kind: "no code", size: 0 };
  let m = code.match(EIP7702);
  if (m) return { kind: "EIP-7702 wallet", size: 23, target: "0x" + m[1] };
  m = code.match(EIP1167);
  if (m) return { kind: "EIP-1167 clone (standard)", size: 45, target: "0x" + m[1] };
  const size = (code.length - 2) / 2;
  // a non-standard minimal proxy: one PUSH20 then DELEGATECALL, as in the town's 44-byte proxies
  const p = code.slice(2).match(/73([0-9a-f]{40})5af4/);
  if (size <= 64 && p) return { kind: "minimal proxy (non-standard)", size, target: "0x" + p[1] };
  return { kind: "contract", size };
}

/** Verified-source facts from Etherscan's v2 API (one key for every chain). null when there is no key. */
export async function etherscanSource(address, { chainId = 4663, key = process.env.ETHERSCAN_KEY, fetchJson } = {}) {
  if (!key) return null;
  const url = `https://api.etherscan.io/v2/api?chainid=${chainId}&module=contract&action=getsourcecode&address=${address}&apikey=${key}`;
  const j = await fetchJson(url);
  if (String(j?.status) !== "1" || !Array.isArray(j.result)) return { ok: false, error: String(j?.result ?? j?.message ?? "no answer").slice(0, 200) };
  const r = j.result[0] ?? {};
  return { ok: true, verified: !!r.SourceCode, name: r.ContractName || null, compiler: r.CompilerVersion || null, proxy: r.Proxy === "1", implementation: r.Implementation || null, license: r.LicenseType || null };
}
