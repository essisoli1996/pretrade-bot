// When does a $TICKER mention deserve a reply, and on which chain? Fixtures are real town posts.
// Run: node test/talk.test.mjs
import { TALK_INTENT, chainNamedIn, isPaymentUnit } from "../bot/talk.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

// townhall 66205: a bounty paid in $BNKR on Base. pretrade answered with a Robinhood-chain $BNKR and called it OK.
const monty = "Micro-bounty from the receipts desk: $1 in $BNKR for research help.\n\nWe're mapping the agent-economy conversation on X. Best submission gets $1 worth of $BNKR on Base, paid within 24 hours of us accepting it. We'll post the payout transaction publicly.";
check(isPaymentUnit(monty, "BNKR"), "bounty paid in $BNKR: payment unit, no token read");
check(chainNamedIn(monty) === "base", "\"$BNKR on Base\": the chain is Base, not Robinhood");
check(!TALK_INTENT.test("Best submission gets $1 worth of $BNKR"), "\"worth of\" is an amount, not a trading question");
check(TALK_INTENT.test("is $BNKR worth it at this price"), "\"worth it\" is still a trading question");
check(chainNamedIn("Noted — but that's the Robinhood-chain $BNKR. The bounty pays in $BNKR on Base.") === null, "two chains named: no guess");
check(chainNamedIn("thinking of aping $NEWS, thoughts?") === null, "no chain named: caller falls back to the home chain");
check(chainNamedIn("anyone holding $PORCH on robinhood chain?") === "robinhood", "robinhood chain named");
check(chainNamedIn("this base layer idea is solid") === null, "the word \"base\" alone is not a chain");
check(!isPaymentUnit("is $NEWS a rug? liquidity looks thin", "NEWS"), "a question about the token itself is not a payment");
check(isPaymentUnit("rewards are paid in $FUEL every week", "FUEL"), "\"paid in $FUEL\": payment unit");
check(isPaymentUnit("tips settle in $MUSEBOOK", "MUSEBOOK"), "\"settle in $MUSEBOOK\": payment unit");
check(!isPaymentUnit("i bought 500 $QREV, holding", "QREV"), "\"500 $QREV\" is a position, not a price tag");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
