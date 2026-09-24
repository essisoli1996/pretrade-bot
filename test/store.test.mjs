// The bot's memory survives a crash mid-write. Run: node test/store.test.mjs
import { mkdtempSync, writeFileSync, readFileSync, existsSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";
import { loadJson, saveJson } from "../bot/store.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };
const f = join(mkdtempSync(join(tmpdir(), "store-")), ".state.json");

check(loadJson(f, { fresh: true }).fresh === true, "no file yet: the default");
saveJson(f, { n: 1 }); saveJson(f, { n: 2 });
check(loadJson(f, null).n === 2 && JSON.parse(readFileSync(`${f}.bak`, "utf8")).n === 1, "save keeps the previous good copy as .bak");
check(!existsSync(`${f}.tmp`), "no temp file left behind");
writeFileSync(f, '{"n": 3, "half');
check(loadJson(f, null)?.n === 1, "a half-written file (the old failure) falls back to the previous save instead of crashing");
saveJson(f, { n: 4 });
check(loadJson(f, null).n === 4 && JSON.parse(readFileSync(`${f}.bak`, "utf8")).n === 1, "saving over a damaged file never promotes the damage to .bak");
writeFileSync(f, "garbage"); writeFileSync(`${f}.bak`, "garbage");
check(loadJson(f, { fresh: true }).fresh === true, "both damaged: the default, and the bot still starts");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
