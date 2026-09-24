// When a post is really about a token, and which chain it means. Pure text rules, shared by the bot and its tests.
export const TALK_INTENT = /\?|\b(buy|buying|ape|aped|aping|safe|rug|rugged|legit|scam|honeypot|worth(?!\s+of\b)|entry|chart|pump|dump|moon|bag|bags|hold|holding|sell|selling|dyor|thoughts)\b/i;
/** The chain a post names for its token ("on Base", "base mainnet", "solana"), or null when it names none or several. */
const CHAIN_WORDS = { robinhood: /\brobinhood(?:\s+chain)?\b|\brh\s+chain\b/i, base: /\b(?:on|via|over)\s+base\b|\bbase\s+(?:chain|mainnet|network)\b/i, ethereum: /\b(?:on\s+)?(?:ethereum|eth\s+mainnet|mainnet\s+eth)\b/i, solana: /\bsolana\b/i, bsc: /\b(?:bsc|bnb\s+chain|binance\s+smart\s+chain)\b/i, arbitrum: /\barbitrum\b/i };
export function chainsNamedIn(text) {
  return Object.entries(CHAIN_WORDS).filter(([, re]) => re.test(String(text))).map(([c]) => c);
}
export function chainNamedIn(text) {
  const hits = chainsNamedIn(text);
  return hits.length === 1 ? hits[0] : null;
}
/** In a reply to me: the chain they point at. "that's the Robinhood one, it pays on Base" names two; the one i did NOT
 *  already read is the one they mean. */
export function chainTheyMean(text, myEarlierText = "") {
  const named = chainsNamedIn(text);
  if (named.length === 1) return named[0];
  const mine = new Set(chainsNamedIn(myEarlierText));
  const fresh = named.filter((c) => !mine.has(c));
  return fresh.length === 1 ? fresh[0] : null;
}
/** True when the $TICKER is only the currency something is paid or priced in, not the thing being discussed. */
export function isPaymentUnit(text, sym) {
  const t = `\\$${sym}\\b`;
  return new RegExp(`\\$?\\d[\\d.,]*\\s*[kKmM]?\\s+(?:worth\\s+of|in|of)\\s+${t}`, "i").test(text)
    || new RegExp(`\\b(?:paid|pays|pay|paying|payout|payouts|reward|rewards|bounty|bounties|tip|tips|tipped|priced|denominated|settled?)\\b[^.\\n]{0,30}?\\bin\\s+${t}`, "i").test(text);
}
