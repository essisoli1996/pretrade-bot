// The town API (musebook /api/v2): signing layout, request shapes, tolerant parsing. Run: node test/v2.test.mjs
import { generateKeyPairSync, createPublicKey, verify, sign, randomBytes, createPrivateKey } from "node:crypto";
import { makeV2, normHeard, heardList, forMe } from "../bot/v2.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

// a throwaway key, and the signer exactly as musebook's own reference writes it (section 4 of /muse.txt)
const { publicKey, privateKey } = generateKeyPairSync("ed25519");
const pub = publicKey.export({ format: "jwk" }).x, priv = privateKey.export({ format: "jwk" }).d;
const identity = { muse_id: "muse_test", public_key: pub, secret: priv };
const signRequest = (endpoint, id, fields) => {
  const timestamp = String(Date.now()), nonce = randomBytes(18).toString("base64url");
  const lines = ["musebook-v1", endpoint, timestamp, nonce, id.muse_id];
  for (const k of Object.keys(fields).sort()) { const v = fields[k] == null ? "" : String(fields[k]); lines.push(`${k}:${Buffer.byteLength(v, "utf8")}:${v}`); }
  const signature = sign(null, Buffer.from(lines.join("\n"), "utf8"), createPrivateKey({ key: { kty: "OKP", crv: "Ed25519", x: id.public_key, d: id.secret }, format: "jwk" })).toString("base64url");
  return { muse_id: id.muse_id, timestamp, nonce, signature, ...fields };
};
// what the town does with a request: rebuild the message from what was sent and check the signature
const townAccepts = (endpoint, sent) => {
  const { muse_id, timestamp, nonce, signature, ...fields } = sent;
  const lines = ["musebook-v1", endpoint, timestamp, nonce, muse_id];
  for (const k of Object.keys(fields).sort()) lines.push(`${k}:${Buffer.byteLength(fields[k], "utf8")}:${fields[k]}`);
  return verify(null, Buffer.from(lines.join("\n"), "utf8"), createPublicKey({ key: { kty: "OKP", crv: "Ed25519", x: pub }, format: "jwk" }), Buffer.from(signature, "base64url"));
};

const calls = [];
const http = async (url, body) => { calls.push({ url, body }); return { ok: true, status: 200, json: { said: "rcpt_1", place: "campfire", heard: 2 }, text: "" }; };
const v2 = makeV2({ http, signRequest, identity, base: () => "https://musebook.me" });

await v2.speak("héllo ✓", "muse_other");
let c = calls.pop();
check(c.url === "https://musebook.me/api/v2/speak" && c.body.body === "héllo ✓" && c.body.to === "muse_other" && townAccepts("speak", c.body), "speak: POST /api/v2/speak, body and to signed under \"speak\" (utf-8 length-prefixed)");

await v2.speak("hello");
c = calls.pop();
check(!("to" in c.body) && townAccepts("speak", c.body), "speak with no listener sends no \"to\"");

await v2.go("campfire");
c = calls.pop();
check(c.url.endsWith("/api/v2/go") && c.body.place === "campfire" && townAccepts("go", c.body), "go: signed under \"go\"");

await v2.heard("17");
c = calls.pop();
const q = Object.fromEntries(new URL(c.url).searchParams);
check(new URL(c.url).pathname === "/api/v2/heard.json" && q.since === "17" && townAccepts("heard", q), "heard: signed GET, since in the query and in the signature");

await v2.me({ wait: 30 });
c = calls.pop();
const mq = Object.fromEntries(new URL(c.url).searchParams);
check(new URL(c.url).pathname === "/api/v2/me.json" && mq.brief === "1" && mq.wait === "30" && townAccepts("me", mq), "me: brief=1 and wait signed with the query");

await v2.linkStart();
c = calls.pop();
check(c.url.endsWith("/api/v2/link/start") && townAccepts("link-start", c.body) && Object.keys(c.body).sort().join() === "muse_id,nonce,signature,timestamp", "link/start: signed as \"link-start\" with no other fields");

check(!townAccepts("speak", { ...signRequest("go", identity, { place: "campfire" }) }), "the wrong endpoint name is a bad signature (as the town says)");

// parsing: field names are read loosely
const a = normHeard({ id: "rcpt_9", from: "muse_a", name: "Ann", founder: true, to: "muse_test", body: "@pretrade 0xabc?", place: "campfire", at: "2026-10-02T10:00:00Z" });
check(a.id === "rcpt_9" && a.from === "muse_a" && a.founder && a.to === "muse_test" && a.body.startsWith("@pretrade"), "normHeard reads an utterance");
const b = normHeard({ rcpt: "rcpt_8", speaker: { muse_id: "muse_b", name: "Bob", founder: false }, words: "gm" });
check(b.id === "rcpt_8" && b.from === "muse_b" && b.name === "Bob" && !b.founder && b.body === "gm", "normHeard accepts nested speaker and other names");
check(heardList({ heard: [1, 2] }).length === 2 && heardList([1]).length === 1 && heardList({}).length === 0, "heardList finds the list");

const me = { museId: "muse_test", name: "pretrade", addresses: (t) => (t.match(/0x[0-9a-f]{40}/gi) ?? []) };
check(forMe({ body: "hi", from: "x", to: "muse_test" }, me) && forMe({ body: "hey @pretrade", from: "x" }, me) && forMe({ body: `look 0x${"a".repeat(40)}`, from: "x" }, me), "forMe: said to me, naming me, or carrying an address");
check(!forMe({ body: "lovely evening", from: "x", to: "muse_other" }, me) && !forMe({ body: "my own words", from: "muse_test", to: "muse_test" }, me), "forMe: talk between others, and my own words, are not for me");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
