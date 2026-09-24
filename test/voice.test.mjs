// The voice: varied wording, identical facts. Run: node test/voice.test.mjs
import { makeVoice, tokenRead, lookupLead, digestText, launchAlertText, acceptOpener, fill } from "../bot/voice.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };
let seed = 7; const random = () => ((seed = (seed * 16807) % 2147483647) / 2147483647);
const v = makeVoice({ random });
const c = { symbol: "NEWS", chain: "robinhood", verdict: "CAUTION", score: 50, flags: ["low liquidity", "pair 7h old", "custom v4 hook can change swap amounts"], liquidity: 6942, maxSell2: 70, contractScanned: true, sim: { status: "ok", flags: [], roundTripLossPct: 2 } };
const url = "https://x402.bankr.bot/0xf4a4/token-check?address=0xe6b1&chain=robinhood";
const outs = Array.from({ length: 40 }, (_, i) => tokenRead(v, c, { kind: i % 2 ? "mention" : "channel", who: "Monty", url }));

check(new Set(outs).size >= 30, `40 reads of the same token, ${new Set(outs).size} different texts`);
check(outs.every((o, i) => i === 0 || o !== outs[i - 1]), "never the same text twice in a row");
const heads = outs.map((o) => o.split("\n").find((l) => /^[🟢🟡🔴]/u.test(l)));
check(new Set(heads).size >= 3 && heads.every((h, i) => i === 0 || h !== heads[i - 1]), "the verdict line itself varies and never repeats back to back");
check(outs.every((o) => /CAUTION/.test(o) && /50\/100/.test(o) && /\$6,942/.test(o) && /\$70/.test(o) && /\$NEWS/.test(o) && /robinhood/.test(o)), "every variant carries the verdict word, score, liquidity, sell size, ticker and chain");
check(outs.every((o) => /low liquidity, pair 7h old, custom v4 hook/.test(o) && /2%/.test(o)), "every variant carries the flags and the simulation result");
check(outs.filter((o, i) => i % 2).every((o) => o.includes(url)), "when someone asked (mention), the json link is always there");
const chimed = outs.filter((o, i) => !(i % 2)).filter((o) => o.includes(url)).length;
check(chimed > 0 && chimed < 20, `when i chimed in on my own, the link shows only sometimes (${chimed}/20)`);
check(outs.some((o) => /Monty/.test(o)) && outs.some((o) => !/Monty/.test(o)), "sometimes addresses the person by name, sometimes not");

const ok = tokenRead(v, { ...c, verdict: "OK", score: 0, flags: [], sim: null }, { kind: "channel", url });
check(/OK/.test(ok) && /0\/100/.test(ok) && /guarantee|promise|not that nothing can go wrong/i.test(ok), `OK read keeps its not-a-guarantee line: ${ok.split("\n").pop()}`);
check(tokenRead(v, c, { kind: "mention", who: "x", opener: "fair question, let me dig in.", url }).startsWith("fair question, let me dig in.\n"), "a model-written opener goes first");

const leads = Array.from({ length: 12 }, () => lookupLead(v, { sym: "BNKR", chain: "base", addr: "0x22af33fe49fd1fa80c7149773dde5890d3c76f3b", others: 0 }));
check(new Set(leads).size >= 3 && leads.every((l) => /0x22af33fe49fd1fa80c7149773dde5890d3c76f3b/.test(l) && /base/.test(l) && /(myself|my own|going by the ticker)/.test(l)), "ticker lookups vary but always name the address, the chain, and that it's my own lookup");
const many = lookupLead(v, { sym: "MUSEBOOK", chain: "robinhood", addr: "0x91a2", others: 7, canon: true });
check(/8/.test(many) && /the one the town knows/.test(many), `several same-ticker tokens: count and which one: ${many.trim()}`);

const d1 = digestText(v, ["row a", "row b"], "pretrade"), d2 = digestText(v, ["row a", "row b"], "pretrade");
check(d1 !== d2 && /row a\nrow b/.test(d1) && /\(2\)|\b2\b/.test(d1.split("\n")[0]), "digests vary around the same rows and count");
const al = launchAlertText(v, { sym: "X", addr: "0xabc", age: "40m", simLine: "sell reverted", me: "pretrade" });
check(/sell reverted/.test(al) && /0xabc/.test(al) && /not advice/.test(al), "launch alert keeps the evidence line and the address");

check(acceptOpener("sounds like you're weighing this one up, let me show you.") !== null, "opener filter: a friendly line passes");
for (const bad2 of ["looks safe to me!", "this one is a rug", "check 0x1234", "up 20% today", "buy the dip", "@Monty hi", "see https://x.y", "the verdict is caution", "SKIP, nothing to add", "a line that is far too long to be an opener because it keeps going and going well past any sensible length for one"])
  check(acceptOpener(bad2) === null, `opener filter rejects: "${bad2.slice(0, 40)}"`);
check(fill("{a} and {b}.", { a: 1 }) === "1 and.", "fill drops missing slots cleanly");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
