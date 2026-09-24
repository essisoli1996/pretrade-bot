// The owner's switches: bot/control.json. Run: node test/control.test.mjs
import { readFileSync } from "node:fs";
import { normalize, modeOf, makeControl, FEATURES } from "../bot/control.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

const shipped = normalize(JSON.parse(readFileSync(new URL("../bot/control.json", import.meta.url), "utf8")));
check(!shipped.paused && !shipped.readOnly && FEATURES.every((f) => modeOf(shipped, f) === (["tickerWatch", "threatWatch"].includes(f) ? "shadow" : f === "conversation" ? "off" : "on")), "the shipped control.json: the Muse talks (engine conversation off), new watches in shadow");
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

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
