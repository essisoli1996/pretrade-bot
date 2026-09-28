// The owner's switches: bot/control.json. Run: node test/control.test.mjs
import { readFileSync } from "node:fs";
import { normalize, modeOf, makeControl, FEATURES, autoPostAllowed, digestLines } from "../bot/control.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

const shipped = normalize(JSON.parse(readFileSync(new URL("../bot/control.json", import.meta.url), "utf8")));
// the owner flips these switches at will, so the test only checks the file is well-formed, never which way they point
const raw = JSON.parse(readFileSync(new URL("../bot/control.json", import.meta.url), "utf8"));
check(["paused", "readOnly", "approval"].every((k) => typeof raw[k] === "boolean") && Object.entries(raw.features ?? {}).every(([f, v]) => FEATURES.includes(f) && [true, false, "shadow"].includes(v)) && FEATURES.every((f) => f in (raw.features ?? {})),
  "the shipped control.json is well-formed: every switch set, every feature known, every value true / false / \"shadow\"");
check(typeof shipped.paused === "boolean", "the shipped control.json normalizes");
check(modeOf(normalize({ paused: true }), "mentions") === "off", "paused: everything off");
check(FEATURES.every((f) => modeOf(normalize({ readOnly: true }), f) === "shadow"), "readOnly: everything runs in shadow");
check(modeOf(normalize({ readOnly: true, features: { radar: false } }), "radar") === "off", "readOnly keeps a feature that is switched off, off");
const mixed = normalize({ features: { conversation: false, launchReport: "shadow", guard: "yes please", nonsense: false } });
check(modeOf(mixed, "conversation") === "off" && modeOf(mixed, "launchReport") === "shadow" && modeOf(mixed, "guard") === "on", "per feature: false = off, \"shadow\" = shadow, anything else = on");
check(modeOf(normalize(null), "mentions") === "on" && modeOf(normalize("garbage"), "channels") === "on", "an unreadable file means on, never a silent shutdown");

let t = 0, gh = '{"readOnly":true}', local = '{"paused":true}';
const src = makeControl({ fetchText: async () => { if (gh === null) throw new Error("offline"); return gh; }, readLocal: async () => local, now: () => t });
check((await src.get()).readOnly && src.source() === "github", "reads GitHub first");
gh = '{"paused":true}';
check((await src.get()).readOnly, "cached for a minute");
t += 61_000;
check((await src.get()).paused, "re-read after a minute");
gh = null; local = '{"features":{"radar":false}}'; t += 61_000;
check(modeOf(await src.get(), "radar") === "off" && src.source() === "local", "GitHub unreachable: falls back to the local file");
local = null; t += 61_000;
check(modeOf(await src.get(), "radar") === "off", "both unreachable: keeps the last known switches");

const NOW = Date.parse("2026-09-28T12:00:00Z");
check(normalize({}).autonomy === "off" && normalize({}).maxAutoPostsPer8h === 6 && normalize({ autonomy: "yes" }).autonomy === "off" && normalize({ autonomy: "full" }).autonomy === "full", "autonomy is off unless set to \"full\"; the cap defaults to 6");
const alog = [{ at: "2026-09-28T11:00:00Z" }, { at: "2026-09-28T10:00:00Z" }, { at: "2026-09-27T01:00:00Z" }];
check(!autoPostAllowed(alog, 2, NOW).ok && autoPostAllowed(alog, 3, NOW).ok, "the autonomous post cap counts only the last 8 hours");
const dl = digestLines({ log: [{ id: 9, at: "2026-09-28T11:00:00Z", ch: "lobby", hash: "abc" }], drafts: { d1: { decision: "rejected", at: "2026-09-28T10:00:00Z", why: "stale" } } }, 8, NOW);
check(dl.length === 2 && /rejected.*d1.*stale/.test(dl[0]) && /posted +9 #lobby hash abc/.test(dl[1]), "digest lists posts with hashes and decisions, oldest first");

{
  const now = Date.parse("2026-09-28T12:00:00Z"), at = "2026-09-28T11:00:00Z";
  const log = [{ at }, { at, replyTo: 5 }, { at, replyTo: 6 }, { at, replyTo: 7 }];
  check(autoPostAllowed(log, 1, now, "post").used === 1 && autoPostAllowed(log, 3, now, "reply").used === 3 && !autoPostAllowed(log, 3, now, "reply").ok, "new posts and replies count against separate caps");
  const n = normalize({});
  check(n.maxAutoPostsPer8h === 6 && n.maxAutoRepliesPer8h === 24 && n.maxRepliesPerThread8h === 3, "cap defaults: 6 posts, 24 replies, 3 per thread");
}
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);

