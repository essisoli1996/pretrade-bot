// The approval outbox: drafts the engine leaves for the Muse. Run: node test/outbox.test.mjs
import { toDraft, parseOutbox, appendDraft, pendingDrafts, draftId } from "../bot/outbox.mjs";
import { normalize, needsApproval } from "../bot/control.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

const body = { muse_id: "m", timestamp: "1", nonce: "n", signature: "SIG", channel: "lobby", name: "pretrade", parent_post_id: 42, text: "hello\n- pretrade" };
const d = toDraft(body, "mentions", new Date("2026-09-25T10:00:00Z"));
check(d.channel === "lobby" && d.reply_to === 42 && d.feature === "mentions" && d.text === body.text, "a draft keeps channel, parent and text");
check(!JSON.stringify(d).includes("SIG") && !("nonce" in d), "a draft never stores the signature");
check(d.id === draftId(d) && d.id.length === 10, "the id is derived from the content");

let file = appendDraft("", d);
file = appendDraft(file, d);
check(parseOutbox(file).length === 1, "the same post queued twice is one draft");
const d2 = toDraft({ channel: "memecoins", text: "launch report" }, "launchReport", new Date("2026-09-25T09:00:00Z"));
file = appendDraft(file + "not json\n", d2);
const all = parseOutbox(file);
check(all.length === 2 && d2.reply_to === null, "bad lines are skipped; a new post has no parent");
check(pendingDrafts(all).map((x) => x.id).join() === [d2.id, d.id].join(), "waiting drafts come oldest first");
check(pendingDrafts(all, { [d.id]: { decision: "approved" } }).length === 1, "a decided draft no longer waits");
check(pendingDrafts(all, {}, Date.parse("2026-09-25T09:30:00Z")).length === 1, "drafts older than the window are left out");
let big = ""; for (let i = 0; i < 10; i++) big = appendDraft(big, toDraft({ channel: "c", text: `t${i}` }, null), 5);
check(parseOutbox(big).length === 5 && parseOutbox(big).pop().text === "t9", "the file keeps only its newest lines");

const on = normalize({ approval: true, approvalExempt: ["leakWatch", "nonsense"] });
check(needsApproval(on, "mentions") && needsApproval(on, null) && !needsApproval(on, "leakWatch"), "approval holds every feature except the exempt ones");
check(on.approvalExempt.join() === "leakWatch", "unknown exempt names are dropped");
check(!needsApproval(normalize({}), "mentions") && !needsApproval(normalize({ approval: "yes" }), "mentions"), "approval is off unless it is exactly true");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
