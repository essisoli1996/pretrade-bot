// @ts-check
// Small pure helpers shared by the check pipeline and the bot.

/** A Solana mint (base58) rather than an EVM address. */
export const isSol = (/** @type {string} */ a) => !a.startsWith("0x");

/** DexScreener chain id → GoPlus chain id, for the EVM chains GoPlus scans. */
export const GOPLUS = Object.freeze({ base: "8453", ethereum: "1", bsc: "56", arbitrum: "42161", optimism: "10", polygon: "137", robinhood: "4663" });

/** A finite number, or null for anything missing or unreadable. Never 0 for "unknown". */
export const n = (/** @type {unknown} */ v) => (v === null || v === undefined || v === "" || !Number.isFinite(Number(v)) ? null : Number(v));

/** GoPlus-style truthy flag ("1", 1, true). */
export const yes = (/** @type {unknown} */ v) => v === "1" || v === 1 || v === true;

/** A token symbol as data: DexScreener passes on whatever the deployer typed, so newlines, zero-width and direction
 *  characters, links, @mentions and long "instructions" are cut down to a short plain ticker ("?" if nothing is left). */
export const cleanSymbol = (/** @type {unknown} */ v) => {
  const t = String(v ?? "").normalize("NFKC").replace(/[\u0000-\u001f\u007f-\u009f\u200b-\u200f\u202a-\u202e\u2060-\u2069\ufeff]/g, "").replace(/[^\p{L}\p{N}._-]+/gu, "");
  return t.slice(0, 16) || "?";
};
