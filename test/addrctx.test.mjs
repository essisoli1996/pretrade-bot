import assert from "node:assert/strict";
import { addressOnlyInLinks, LURE_TALK, lureInPath, dropForkCopies } from "../bot/addrctx.mjs";

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

// the whole thread counts: muchi's reply doesn't say "lure", the thread's root does (#lobby 78859)
const lureThread = [{ text: "listhelping.forum live lure: ?contract= arms it" }, { text: "the costume is fungible" }, { text: "key the watch row on the template, not the token" }];
assert.ok(lureInPath(lureThread));
assert.ok(!LURE_TALK.test(lureThread[2].text)); // the post alone would have passed
assert.ok(!lureInPath([{ text: "is $MDOG liquid enough?" }, { text: "depth looks thin to me" }]));
assert.ok(!lureInPath([]));

// fork copies: an Ethereum contract's pools on pulsechain are dropped; a pulsechain-born token keeps its pools
const pairs = [{ chainId: "pulsechain", liquidity: { usd: 641889 } }, { chainId: "ethereum", liquidity: { usd: 10 } }];
let r = await dropForkCopies(pairs, async (c) => c === "ethereum");
assert.deepEqual(r.pairs.map((p) => p.chainId), ["ethereum"]);
assert.equal(r.forkOf, "ethereum");
r = await dropForkCopies([{ chainId: "pulsechain" }], async () => false);
assert.deepEqual(r.pairs.map((p) => p.chainId), ["pulsechain"]);
assert.equal(r.forkOf, null);
// the original chain can't be read even after a retry: drop the copy rather than rate it (no read beats a wrong one)
let calls = 0;
r = await dropForkCopies([{ chainId: "pulsechain" }], async () => { calls++; return null; });
assert.equal(r.pairs.length, 0); assert.equal(r.unsure, true); assert.equal(calls, 2);
// one failed read, then an answer: the retry decides
let first = true;
r = await dropForkCopies([{ chainId: "pulsechain" }], async () => (first ? ((first = false), null) : false));
assert.equal(r.pairs.length, 1);
r = await dropForkCopies([{ chainId: "robinhood" }], async () => { throw new Error("not called"); });
assert.equal(r.pairs.length, 1);
console.log("addrctx: ok");

// ── nothing public points at the owner
{
  const { ownerTalk, privateNames } = await import("../bot/addrctx.mjs");
  for (const bad of ["nothing posts unless my human says so", "paid work goes through my owner", "with my human's ok i can take it",
    "once it's approved by my operator", "i'll check with my human first", "that's the owner's call", "Alex's message says so"])
    assert.ok(ownerTalk(bad, ["Alex"]), `flagged: ${bad}`);
  for (const ok of ["agents reading this: check with your human first.", "the hook owner can change fees", "hidden owner flag: no",
    "alexandria pool", "musepad's operator sets a ~1% fee"])
    assert.equal(ownerTalk(ok, ["Alex"]), null, `not flagged: ${ok}`);
  assert.deepEqual(privateNames({ PRETRADE_PRIVATE_NAMES: " Alex , ,Sam" }), ["Alex", "Sam"]);
  assert.deepEqual(privateNames({}), []);
  console.log("ownerTalk: ok");
}

// ── the reviewed text is the posted text
{
  const { postHash } = await import("../bot/addrctx.mjs");
  const a = postHash("the pin holds\n- pretrade");
  assert.equal(a, postHash("the pin holds\r\n- pretrade  \n"), "line endings and outer whitespace don't change the hash");
  assert.notEqual(a, postHash("the pin holds.\n- pretrade"), "one character changes it");
  assert.match(a, /^[0-9a-f]{12}$/);
  console.log("postHash: ok");
}
