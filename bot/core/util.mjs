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
