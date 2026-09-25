// Where an address sits in a post, and which chain it really belongs to.
//
// An address pasted as part of a link (`?contract=0x…`, `/go-cd94d33c/0x…`) is the input someone fed a page, not a
// token under discussion: UDP fed Ethereum's USDT into a live phishing lure on purpose (#lobby 78475) and the engine
// drafted a CAUTION read on $USDT into the phishing thread. Explorer and chart links still count as a mention.
const URL_RE = /https?:\/\/\S+/gi;
const EXPLORER = /(etherscan|basescan|arbiscan|bscscan|polygonscan|robinscan|blockscout|explorer\.|dexscreener|geckoterminal|dextools|birdeye|solscan|pump\.fun|rugcheck)/i;

/** True when every occurrence of addr in text is part of a link (a URL that is not an explorer, or a ?param=/path). */
export function addressOnlyInLinks(text, addr) {
  const t = String(text ?? ""), a = String(addr ?? "").toLowerCase();
  if (!a) return false;
  const spans = [...t.matchAll(URL_RE)].map((m) => ({ from: m.index, to: m.index + m[0].length, explorer: EXPLORER.test(m[0]) }));
  const low = t.toLowerCase();
  let seen = 0;
  for (let i = low.indexOf(a); i !== -1; i = low.indexOf(a, i + a.length)) {
    seen++;
    const url = spans.find((s) => i >= s.from && i < s.to);
    if (url ? url.explorer : !/[=/]/.test(t[i - 1] ?? "")) return false; // one plain mention is enough
  }
  return seen > 0;
}

// A post about a phishing page or a drainer: a token read there reads as a verdict on the coin the lure wears.
export const LURE_TALK = /\b(lure|phish\w*|drainer|drain(?:s|ed|ing)? wallets?|scam (?:page|site|link)|fake (?:site|page|airdrop|claim))\b/i;

/** True when any post on the path from the thread's root to this post talks about a lure. A reply deep in a phishing
 *  thread often doesn't say "lure" itself (muchi, #lobby 78859: "key the watch row on the template") while the root does. */
export const lureInPath = (path) => (path ?? []).some((n) => LURE_TALK.test(String(n?.text ?? "")));

// Chains that copied Ethereum's whole state at launch: every Ethereum contract address exists there as a copy.
// A pool on the copy says nothing about the original token (USDT read as "$USDT, pulsechain", #lobby 78475).
export const FORK_COPIES = { pulsechain: "ethereum", ethereumpow: "ethereum", ethw: "ethereum" };

/** Drops pairs on a fork-copy chain when the address is a contract on the chain it was copied from.
 *  hasCodeOn(chain) → true / false / null (unknown, retried once; still unknown drops the copies too). Returns
 *  { pairs, forkOf, unsure } — forkOf names the original chain when copies were dropped, unsure when that was unconfirmed. */
export async function dropForkCopies(pairs, hasCodeOn) {
  const copies = [...new Set(pairs.map((p) => p.chainId).filter((c) => FORK_COPIES[c]))];
  if (!copies.length) return { pairs, forkOf: null };
  const origins = [...new Set(copies.map((c) => FORK_COPIES[c]))];
  const real = [], unsure = [];
  for (const o of origins) {
    // one retry: a single failed read on the original chain let the copy's rating through (Muse's first try, USDT)
    let has = await hasCodeOn(o);
    if (has === null) has = await hasCodeOn(o);
    if (has === true) real.push(o); else if (has === null) unsure.push(o);
  }
  // unknown is not "born on the copy": no read beats a read on the wrong chain
  const drop = [...real, ...unsure];
  if (!drop.length) return { pairs, forkOf: null, unsure: false }; // a token born on the copy chain itself: keep it
  return { pairs: pairs.filter((p) => !drop.includes(FORK_COPIES[p.chainId])), forkOf: (real[0] ?? unsure[0]), unsure: !real.length };
}
