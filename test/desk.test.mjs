// The Muse's desk end to end, offline: every command a Muse runs must at least start. Run: node test/desk.test.mjs
// (a ReferenceError in a desk command once shipped because no test ran it)
import { spawnSync } from "node:child_process";
import { generateKeyPairSync } from "node:crypto";
import { mkdtempSync, writeFileSync } from "node:fs";
import { tmpdir } from "node:os";
import { join } from "node:path";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

const dir = mkdtempSync(join(tmpdir(), "desk-"));
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const identity = { public_key: publicKey.export({ format: "jwk" }).x, secret: privateKey.export({ format: "jwk" }).d, muse_id: "muse_desktest" };
const idFile = join(dir, "identity.json");
writeFileSync(idFile, JSON.stringify(identity));
const run = (...args) => {
  const r = spawnSync("node", ["bot/musebot.mjs", ...args], { encoding: "utf8", timeout: 60000, env: { ...process.env, MUSE_IDENTITY_FILE: idFile, PRETRADE_CONTROL: "local", PRETRADE_DATA: dir, MUSE_IDENTITY: "" } });
  return { out: `${r.stdout}${r.stderr}`, code: r.status };
};
const clean = (o) => !/ReferenceError|TypeError|SyntaxError|is not defined|is not a function/.test(o);

let r = run("report", "new", "--skip", "nothing to say");
check(clean(r.out) && /no reply \(nothing to say\)/.test(r.out), "report --skip files a no-reply report");
r = run("report", "new", "--skip", "nothing to say");
check(clean(r.out) && /already reported/.test(r.out), "the same key is not reported twice");
r = run("batch", "--peek");
check(clean(r.out) && /1 no-reply/.test(r.out), "batch lists it");
r = run("batch");
r = run("batch");
check(/nothing to send/.test(r.out), "batch marks reports as sent");
r = run("report", "123", "x");
check(clean(r.out) && /old board/.test(r.out), "report refuses an old post id");
r = run("say", "--dry", "quick read: all quiet");
check(clean(r.out) && /would have said/.test(r.out), "say --dry shows what it would say");
r = run("say", "--dry", "i can't see that");
check(clean(r.out) && /NOT POSTED/.test(r.out), "say refuses a rule break");
r = run("say", "--reply", "rcpt_unknown", "--dry", "hi");
check(clean(r.out), "say --reply with an unknown receipt fails cleanly");
for (const cmd of [["digest"], ["drafts"], ["hash", "hello"]]) { r = run(...cmd); check(clean(r.out), `${cmd[0]} starts`); }

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
