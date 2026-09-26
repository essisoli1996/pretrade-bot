// @ts-check
// Which quote tokens a pool's liquidity can be trusted against. DexScreener prices a pool's quote side from that
// token's own markets, so a pool against a token the attacker also made (and pumped) can list "deep liquidity" that no
// seller can reach. A pool counts toward liquidity, and can be the pool a read is about, only when its quote is the
// chain's native coin, its wrapped native coin, a major stablecoin or BTC, the town coin, or (on Robinhood Chain) a
// Robinhood Stock Token from Robinhood's own registry.

const NATIVE = "0x0000000000000000000000000000000000000000"; // uniswap v4 pools quote native ETH as the zero address

/** Per chain: lowercase addresses (base58 as-is on solana). A chain missing here is not judged. */
export const QUOTES = Object.freeze({
  ethereum: ["0xc02aaa39b223fe8d0a0e5c4f27ead9083c756cc2", "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", "0xdac17f958d2ee523a2206206994597c13d831ec7", "0x6b175474e89094c44da98b954eedeac495271d0f", "0x2260fac5e5542a773aa44fbcfedf7c193bc2c599"], // WETH USDC USDT DAI WBTC
  base: ["0x4200000000000000000000000000000000000006", "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", "0xd9aaec86b65d86f6a7b5b1b0c42ffa531710b6ca", "0xcbb7c0000ab88b473b1f5afd9ef808440eed33bf", "0x50c5725949a6f0c72e6c4a641f24049a917db0cb"], // WETH USDC USDbC cbBTC DAI
  bsc: ["0xbb4cdb9cbd36b01bd1cbaebf2de08d9173bc095c", "0x55d398326f99059ff775485246999027b3197955", "0x8ac76a51cc950d9822d68b83fe1ad97b32cd580d", "0xe9e7cea3dedca5984780bafc599bd69add087d56"], // WBNB USDT USDC BUSD
  arbitrum: ["0x82af49447d8a07e3bd95bd0d56f35241523fbab1", "0xaf88d065e77c8cc2239327c5edb3a432268e5831", "0xff970a61a04b1ca14834a43f5de4533ebddb5cc8", "0xfd086bc7cd5c481dcc9c85ebe478a1c0b69fcbb9"], // WETH USDC USDC.e USDT
  optimism: ["0x4200000000000000000000000000000000000006", "0x0b2c639c533813f4aa9d7837caf62653d097ff85", "0x94b008aa00579c1307b0ef2c499ad98a8ce58e58"], // WETH USDC USDT
  polygon: ["0x0d500b1d8e8ef31e21c99d1db9a6444d3adf1270", "0x3c499c542cef5e3811e1192ce70d8cc03d5c3359", "0x2791bca1f2de4661ed88a30c99a7a9449aa84174", "0xc2132d05d31c914a87c6611c10748aeb04b58e8f", "0x7ceb23fd6bc0add59e62ac25578270cff1b9f619"], // WPOL USDC USDC.e USDT WETH
  robinhood: ["0x0bd7d308f8e1639fab988df18a8011f41eacad73", "0x5fc5360d0400a0fd4f2af552add042d716f1d168", "0x91a2dae9699f0b82540b5886b0d8759c22820ba3"], // WETH USDG $MUSEBOOK
  solana: ["So11111111111111111111111111111111111111112", "EPjFWdd5AufqSSqeM2qN1xzybapC8G4wEGGkZwyTDt1v", "Es9vMFrzaCERmJfrF4H2FYD4KCoNkY11McCe8BenwNYB"], // SOL USDC USDT
});

/**
 * true: a recognized quote. false: not recognized. null: this chain has no list, so it isn't judged.
 * @param {string} chain
 * @param {string} quote
 * @param {(addr: string) => Promise<boolean | null>} [stockToken] Robinhood registry lookup (null when unreachable)
 */
export async function recognizedQuote(chain, quote, stockToken) {
  const list = /** @type {Record<string, string[]>} */ (QUOTES)[chain];
  if (!list) return null;
  const q = chain === "solana" ? String(quote ?? "") : String(quote ?? "").toLowerCase();
  if (list.includes(q) || (chain !== "solana" && q === NATIVE)) return true;
  if (chain === "robinhood" && stockToken) return (await stockToken(q)) === true; // unreachable registry: not recognized
  return false;
}
