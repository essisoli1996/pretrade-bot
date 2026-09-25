import assert from "node:assert/strict";
import { addressOnlyInLinks, LURE_TALK, dropForkCopies } from "../bot/addrctx.mjs";

const USDT = "0xdAC17F958D2ee523a2206206994597C13D831ec7";
// UDP, #lobby 78475: USDT fed into a phishing lure as its query input
const udp = `independent read: \`?contract=${USDT}\` (USDT — a known ticker, on purpose) returned a live page. rewrites the link to \`/go-cd94d33c/<contract>\`.`;
assert.equal(addressOnlyInLinks(udp, USDT.toLowerCase()), true);
assert.equal(addressOnlyInLinks(`https://evil.example/claim/${USDT}`, USDT), true);
assert.equal(addressOnlyInLinks(`/go-cd94d33c/${USDT}`, USDT), true);
// a plain mention, or an explorer / chart link, is still a token under discussion
assert.equal(addressOnlyInLinks(`is ${USDT} safe to buy?`, USDT), false);
assert.equal(addressOnlyInLinks(`chart: https://dexscreener.com/ethereum/${USDT}`, USDT), false);
assert.equal(addressOnlyInLinks(`see ?contract=${USDT} and also ${USDT} itself`, USDT), false);
assert.equal(addressOnlyInLinks("no address here", USDT), false);

assert.ok(LURE_TALK.test("the lure arms on the query param"));
assert.ok(LURE_TALK.test("this is a phishing page"));
assert.ok(!LURE_TALK.test("is this token a good buy? liquidity looks thin"));

// fork copies: an Ethereum contract's pools on pulsechain are dropped; a pulsechain-born token keeps its pools
const pairs = [{ chainId: "pulsechain", liquidity: { usd: 641889 } }, { chainId: "ethereum", liquidity: { usd: 10 } }];
let r = await dropForkCopies(pairs, async (c) => c === "ethereum");
assert.deepEqual(r.pairs.map((p) => p.chainId), ["ethereum"]);
assert.equal(r.forkOf, "ethereum");
r = await dropForkCopies([{ chainId: "pulsechain" }], async () => false);
assert.deepEqual(r.pairs.map((p) => p.chainId), ["pulsechain"]);
assert.equal(r.forkOf, null);
r = await dropForkCopies([{ chainId: "pulsechain" }], async () => null); // unknown: keep, don't guess
assert.equal(r.pairs.length, 1);
r = await dropForkCopies([{ chainId: "robinhood" }], async () => { throw new Error("not called"); });
assert.equal(r.pairs.length, 1);
console.log("addrctx: ok");
