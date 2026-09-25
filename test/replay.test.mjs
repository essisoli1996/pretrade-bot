// Replays recorded checks offline (no network): same recorded answers + same clock must give the same result, byte
// for byte. A change in bot/core that alters a verdict, a flag or a number shows up here as a diff. Record new
// fixtures with the hooks workflow's "recordcheck" (scripts/recordcheck.sh), never by hand.
import { readdirSync, readFileSync, existsSync, mkdtempSync } from "node:fs";
import { execFileSync } from "node:child_process";
import { tmpdir } from "node:os";
import { join } from "node:path";

const DIR = "test/fixtures/replay";
let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

const names = existsSync(DIR) ? readdirSync(DIR).filter((f) => f.endsWith(".expected.json")).map((f) => f.replace(/\.expected\.json$/, "")) : [];
const now = existsSync(join(DIR, "NOW")) ? readFileSync(join(DIR, "NOW"), "utf8").match(/PRETRADE_NOW=(\d+)/)?.[1] : null;
if (!names.length || !now) console.log("no replay fixtures yet: nothing to replay");

for (const name of names) {
  const expected = readFileSync(join(DIR, `${name}.expected.json`), "utf8");
  const address = JSON.parse(expected)?.address;
  const env = {
    ...process.env,
    PRETRADE_DATA: mkdtempSync(join(tmpdir(), "replay-")),
    PRETRADE_NOW: now,
    PRETRADE_HTTP_FIXTURE: join(DIR, `${name}.http.json`),
    PRETRADE_HTTP_MODE: "replay",
    ETHERSCAN_KEY: "FIXTUREKEY00000000", // scrubbed to <key>, like the real one was when recording
    NODEFLARE_KEY: "",
  };
  delete env.MUSE_IDENTITY;
  let out = "", err = "";
  try { out = execFileSync("node", ["bot/musebot.mjs", "checkjson", address], { env, encoding: "utf8", stdio: ["ignore", "pipe", "pipe"], timeout: 120000 }); }
  catch (e) { out = String(e.stdout ?? ""); err = String(e.stderr ?? e); }
  check(out === expected, `${name}: offline replay reproduces the recorded check${out === expected ? "" : ` (differs${err ? `: ${err.slice(0, 200)}` : ""})`}`);
  const r = JSON.parse(expected);
  check(typeof r.verdict === "string" && ["OK", "CAUTION", "DANGER"].includes(r.verdict), `${name}: recorded verdict is one of OK / CAUTION / DANGER (${r.verdict})`);
  const raw = readFileSync(join(DIR, `${name}.http.json`), "utf8");
  check(!/apikey=(?!<key>)[A-Za-z0-9]{8,}/.test(raw) && !/rpc\.nodeflare\.app\/robinhood\/v1\/(?!<key>)[A-Za-z0-9]{8,}/.test(raw), `${name}: no API key inside the fixture`);
}

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
