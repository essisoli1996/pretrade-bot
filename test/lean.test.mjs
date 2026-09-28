// Lean desk: triage, rule checks, short reports. Run: node test/lean.test.mjs
import { needsReply, lintDraft, reportLines, machineStreak } from "../bot/lean.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

check(!needsReply("gm @pretrade 🔥").reply && !needsReply("lol").reply && !needsReply("thanks!").reply, "reactions need no reply");
check(needsReply("@pretrade is 0xabc safe to ape?").reply && needsReply("can you read this one").reply, "asks need a reply");
check(!needsReply("cool chart man").reply, "a short remark with no ask needs no reply");
check(needsReply("I think the liquidity on this pool is thinner than the dashboard claims because most of it sits out of range").reply, "a long remark goes to judgment");

check(lintDraft("liquidity $8,532, top10 41%", { facts: "liq $8,532 top10 41%" }).length === 0, "backed numbers: clean");
check(/8532/.test(lintDraft("liquidity $8,532", { facts: "" })[0] ?? ""), "unbacked number flagged");
check(lintDraft("my human says hold").some((p) => /owner/.test(p)), "owner talk flagged");
check(lintDraft("held for approval, back soon").some((p) => /narration/.test(p)), "approval narration flagged");
check(lintDraft("i can't see that chain").some((p) => /Needs/.test(p)), "\"i can't\" flagged");
check(lintDraft("$PTRD looks fine").some((p) => /PTRD/.test(p)), "$PTRD mention flagged");
check(lintDraft("correction: i was wrong earlier").some((p) => /old post/.test(p)), "corrections flagged");
check(lintDraft("dm me for a paid report").some((p) => /approval/.test(p)), "paid offers flagged");
check(lintDraft("x".repeat(501)).some((p) => /chars/.test(p)), "long drafts flagged");
check(lintDraft("price impact looks thin on the fee tier").length === 0, "ordinary words about price and fees are fine");

const r = { n: 3, key: "post9", where: "#lobby ↳9 bob", ask: "safe?", read: "wants a risk read", draft: "hi", hash: "abc", problems: [] };
check(reportLines(r).length === 5 && /✓ clean/.test(reportLines(r)[4]), "clean report is five short lines");
check(reportLines({ n: 4, key: "post10", where: "#lobby", skip: "reaction" }).length === 1, "no-reply report is one line");
check(machineStreak([{ skip: "x" }, { problems: ["bad"] }, { problems: [] }, { skip: "y" }]) === 2, "streak resets on a flagged draft");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
