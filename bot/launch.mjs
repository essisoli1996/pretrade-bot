#!/usr/bin/env node
// One-off token launch through musepad (https://musepad.lol/skill.md). IRREVERSIBLE once posted.
//   node bot/launch.mjs precheck     look for existing tokens with the same ticker, post nothing
//   node bot/launch.mjs launch       post the !musepad request as the bot and wait for musepad's reply
import { createPrivateKey, sign, randomBytes } from "node:crypto";
import { readFileSync, writeFileSync, existsSync } from "node:fs";
import { dirname, join } from "node:path";
import { fileURLToPath } from "node:url";

const HERE = dirname(fileURLToPath(import.meta.url));
const ROOT = join(HERE, "..");
const CFG_FILE = join(HERE, "config.json");
const CFG = JSON.parse(readFileSync(CFG_FILE, "utf8"));
const L = CFG.launch;
const RESULT = join(ROOT, "launch-result.txt");
const mode = process.argv[2];
const out = [];
const say = (s) => { console.log(s); out.push(s); };
const save = () => writeFileSync(RESULT, out.join("\n") + "\n");

async function precheck() {
  const r = await fetch(`https://api.dexscreener.com/latest/dex/search?q=${encodeURIComponent(L.symbol)}`);
  const pairs = (await r.json())?.pairs ?? [];
  const same = new Map();
  for (const p of pairs) {
    if ((p?.baseToken?.symbol ?? "").toLowerCase() !== L.symbol.toLowerCase()) continue;
    const k = `${p.chainId}:${p.baseToken.address}`;
    same.set(k, (same.get(k) ?? 0) + (Number(p.liquidity?.usd) || 0));
  }
  say(`ticker $${L.symbol}: ${same.size} DEX-traded token(s) already use it`);
  for (const [k, liq] of same) say(`  ${k}  liquidity $${Math.round(liq)}`);
  return [...same.keys()].filter((k) => k.startsWith("robinhood:")).length;
}

function signPost(identity, museId, fields) {
  const key = createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: identity.public_key, d: identity.secret }, format: "jwk" });
  const timestamp = String(Date.now());
  const nonce = randomBytes(18).toString("base64url");
  const lines = ["musebook-v1", "post", timestamp, nonce, museId];
  for (const k of Object.keys(fields).sort()) { const v = String(fields[k]); lines.push(`${k}:${Buffer.byteLength(v, "utf8")}:${v}`); }
  const signature = sign(null, Buffer.from(lines.join("\n"), "utf8"), key).toString("base64url");
  return { muse_id: museId, timestamp, nonce, signature, ...fields };
}

const requestText = (image) => [
  "!musepad",
  `name: ${L.name}`,
  `symbol: ${L.symbol}`,
  `wallet: ${L.wallet}`,
  `description: ${L.description}`,
  ...(image ? [`image: ${image}`] : []),
  `platform: ${L.platform}`,
].join("\n");

if (mode === "precheck") {
  const clash = await precheck();
  say(clash ? "→ same ticker already exists on Robinhood Chain: pick another ticker." : "→ no clash on Robinhood Chain.");
  say("\nThe exact post that `launch` would publish:\n" + requestText("<uploaded logo url>"));
  writeFileSync(join(ROOT, "launch-precheck.txt"), out.join("\n") + "\n");
  process.exit(0);
}

if (mode !== "launch") { console.log("usage: precheck | launch"); process.exit(1); }
if (process.env.CONFIRM !== `LAUNCH ${L.symbol}`) { console.error(`Refusing: confirmation text must be exactly "LAUNCH ${L.symbol}".`); process.exit(1); }
if (CFG.token?.address || existsSync(RESULT)) { console.error("Refusing: a launch was already attempted (launch-result.txt exists or token.address is set). Never post twice."); process.exit(1); }
if (!/^0x[a-fA-F0-9]{40}$/.test(L.wallet)) { console.error("Refusing: wallet is not a valid EVM address."); process.exit(1); }

const identity = JSON.parse(process.env.MUSE_IDENTITY);
const museId = identity.muse_id || readFileSync(join(HERE, "muse_id.txt"), "utf8").trim();

if (await precheck()) { say("ABORTED: ticker clash on Robinhood Chain. Nothing was posted."); save(); process.exit(1); }

const image = (process.env.LOGO_URL ?? "").startsWith("https://") ? process.env.LOGO_URL : null;
say(image ? `logo: ${image}` : "logo: none (upload failed or skipped)");

const text = requestText(image);
const res = await fetch("https://musebook.me/api/post", {
  method: "POST", headers: { "Content-Type": "application/json" },
  body: JSON.stringify(signPost(identity, museId, { channel: L.channel, name: CFG.name, text })),
});
const posted = await res.json().catch(() => ({}));
const postId = posted.id ?? posted.post_id ?? posted.post?.id;
say(`request posted: HTTP ${res.status}, post id ${postId} → https://musebook.me/p/${postId}`);
if (!res.ok || postId == null) { say("Post failed. Nothing was deployed."); save(); process.exit(1); }
save(); // from here on a second attempt must never happen automatically

let token = null;
for (let i = 0; i < 28 && !token; i++) {
  await new Promise((r) => setTimeout(r, 15000));
  const t = await fetch(`https://musebook.me/api/thread.json?post=${postId}`).then((r) => r.json()).catch(() => null);
  const replies = t?.thread?.replies ?? [];
  for (const rep of replies) {
    if (!/deployed/i.test(rep.text ?? "")) continue;
    say(`\nmusepad replied:\n${rep.text}`);
    const addrs = (rep.text.match(/0x[a-fA-F0-9]{40}(?![a-fA-F0-9])/g) ?? []).filter((a) => a.toLowerCase() !== L.wallet.toLowerCase());
    token = addrs[0] ?? null;
  }
}

if (!token) { say("\nNo deploy reply within 7 minutes. Per musepad's docs silence means it did not deploy, but CHECK THE POST MANUALLY before any retry."); save(); process.exit(1); }

CFG.token.address = token;
CFG.bio = L.bioAfterLaunch;
writeFileSync(CFG_FILE, JSON.stringify(CFG, null, 2) + "\n");
say(`\nTOKEN: ${token}\nconfig updated: premium services are now ON, bio carries the disclosure.`);
save();
