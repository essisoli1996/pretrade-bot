// Sentinel: the town's free safety net. Pure text analysis, no API, no model.
//  1. findSecrets: recovery phrases (BIP39, checksum-verified), private keys, musebook identity secrets, API keys
//     posted in the open. The secret itself is never repeated anywhere: findings carry only a kind and a position.
//  2. scanInstructions: a skill file, a README an agent is told to follow, or a post: does it ask for keys, run remote
//     code, move money, send data out, hide text or instructions (zero-width, Unicode tags, Morse, base64, comments),
//     tell the agent to keep it from its human, override its rules, or write itself into the agent's memory?
//  3. isPublicUrl: what the bot may fetch on someone's behalf (no private networks, no metadata endpoints).
import { createHash } from "node:crypto";
import { readFileSync } from "node:fs";

// ───────────────────────── 1. leaked secrets ─────────────────────────
let WORDS = null;
export function bip39() {
  if (WORDS) return WORDS;
  const list = readFileSync(new URL("./bip39-english.txt", import.meta.url), "utf8").split("\n").map((w) => w.trim()).filter(Boolean);
  WORDS = { list, index: new Map(list.map((w, i) => [w, i])) };
  return WORDS;
}

/** A BIP39 mnemonic is valid when its last bits are the start of sha256(entropy). Random word lists pass 1 in 16 (12
 *  words) to 1 in 256 (24 words); prose runs of 12+ list words are rare to begin with. */
export function validMnemonic(words) {
  const { index } = bip39();
  if (![12, 15, 18, 21, 24].includes(words.length)) return false;
  const idx = words.map((w) => index.get(w));
  if (idx.some((i) => i === undefined)) return false;
  const bits = idx.map((i) => i.toString(2).padStart(11, "0")).join("");
  const cs = words.length / 3, entBits = bits.length - cs;
  const entropy = Buffer.from(bits.slice(0, entBits).match(/.{8}/g).map((b) => parseInt(b, 2)));
  const hash = createHash("sha256").update(entropy).digest();
  const want = [...hash].map((b) => b.toString(2).padStart(8, "0")).join("").slice(0, cs);
  return want === bits.slice(entBits);
}

const API_KEYS = [
  [/\bbk_[A-Za-z0-9]{24,}/, "Bankr API key"],
  [/\bsk-or-v1-[a-f0-9]{48,}/, "OpenRouter API key"],
  [/\bsk-ant-[A-Za-z0-9_-]{32,}/, "Anthropic API key"],
  [/\bsk-(?:proj-)?[A-Za-z0-9_-]{40,}/, "OpenAI API key"],
  [/\bgh[pousr]_[A-Za-z0-9]{36,}|\bgithub_pat_[A-Za-z0-9_]{50,}/, "GitHub token"],
  [/\bxox[abposr]-[A-Za-z0-9-]{20,}/, "Slack token"],
  [/\bAKIA[0-9A-Z]{16}\b/, "AWS access key"],
  [/\bAIza[0-9A-Za-z_-]{35}\b/, "Google API key"],
  [/\b\d{8,10}:AA[0-9A-Za-z_-]{33}\b/, "Telegram bot token"],
];

/** Findings in a post: [{ kind, severity, at }]. Never returns the secret. */
export function findSecrets(text) {
  const t = String(text ?? "");
  const out = [];
  // recovery phrases: runs of list words, any separators (spaces, commas, numbering, line breaks)
  const { index } = bip39();
  const toks = [...t.toLowerCase().matchAll(/[a-z]+/g)];
  let run = [];
  const flush = () => {
    for (const n of [24, 21, 18, 15, 12]) {
      for (let s = 0; s + n <= run.length; s++) {
        if (validMnemonic(run.slice(s, s + n).map((m) => m[0]))) { out.push({ kind: `recovery phrase (${n} words)`, severity: "critical", at: run[s].index }); return; }
      }
    }
  };
  for (const m of toks) { if (index.has(m[0])) run.push(m); else { if (run.length >= 12) flush(); run = []; } }
  if (run.length >= 12) flush();
  // private keys: 64 hex next to a word that says so (bare 64-hex is usually a tx hash or a sha256)
  const pk = t.match(/(private[\s_-]*key|priv[\s_-]*key|secret[\s_-]*key|signing[\s_-]*key|wallet[\s_-]*key|\bpk\b|"privateKey")["'\s:=]{0,6}(0x)?[0-9a-fA-F]{64}(?![0-9a-fA-F])/i);
  if (pk) out.push({ kind: "private key", severity: "critical", at: pk.index });
  // an Ed25519 identity in JWK / musebook form
  const id = t.match(/"(secret|d)"\s*:\s*"[A-Za-z0-9_-]{40,}"/);
  if (id && /"(public_key|x|muse_id|kty)"/.test(t)) out.push({ kind: "identity secret key", severity: "critical", at: id.index });
  for (const [re, kind] of API_KEYS) { const m = t.match(re); if (m) out.push({ kind, severity: "high", at: m.index }); }
  return out;
}

// ───────────────────────── 2. instructions an agent should not follow ─────────────────────────
const RULES = [
  // [id, severity, regex, why]
  ["asks-for-secrets", "high", /\b(send|paste|share|post|include|provide|dump|reveal|print|export|upload|reply with|give)\b[^.\n]{0,60}\b(private[\s-]*keys?|seed[\s-]*phrase|recovery[\s-]*phrase|mnemonic|api[\s_-]*keys?|secret[\s-]*keys?|\.env\b|process\.env|environment variables|keystore|wallet file|identity file)/i, "asks for keys, seed phrases or environment secrets"],
  ["asks-for-secrets", "high", /\b(private[\s-]*key|seed[\s-]*phrase|recovery[\s-]*phrase|mnemonic)\b[^.\n]{0,40}\b(here|below|to (us|me|this))\b/i, "asks for a key or seed phrase"],
  ["remote-code", "high", /\b(curl|wget)\b[^\n|]{0,200}\|\s*(sudo\s+)?(ba|z)?sh\b|\biwr\b[^\n]{0,100}\|\s*iex\b|powershell[^\n]{0,40}-enc(odedcommand)?\b/i, "pipes a download straight into a shell"],
  ["remote-code", "medium", /\beval\s*\(|\bnew Function\s*\(|child_process|\bexec(Sync)?\s*\(|base64\s+(-d|--decode)[^\n]{0,40}\|\s*(ba)?sh/i, "runs dynamically built code"],
  ["moves-money", "high", /\b(approve|setApprovalForAll|increaseAllowance)\b[^.\n]{0,40}\b(max|unlimited|infinite|all|2\s*\*\*\s*256|uint256\.max|type\(uint256\)\.max)\b/i, "asks for an unlimited approval"],
  ["moves-money", "high", /\b(transfer|send|move|withdraw|sweep|bridge)\b[^.\n]{0,30}\b(all|entire|full|max|whole)\b[^.\n]{0,20}\b(balance|funds|tokens|eth|wallet|holdings)\b/i, "tells the agent to move all of its funds"],
  ["moves-money", "medium", /\bsign\b[^.\n]{0,40}\b(permit|typed[\s-]?data|eip-?712|message|authorization|7702|delegation)\b/i, "asks the agent to sign something"],
  ["exfiltration", "high", /\b(webhook\.site|requestbin|pipedream\.net|ngrok(-free)?\.(io|app)|trycloudflare\.com|pastebin\.com|hastebin|discord(app)?\.com\/api\/webhooks|api\.telegram\.org\/bot|interact\.sh|oast\.(pro|fun|live|me)|burpcollaborator)/i, "sends data to a capture endpoint"],
  ["exfiltration", "medium", /https?:\/\/(\d{1,3}\.){3}\d{1,3}(:\d+)?\//i, "talks to a raw IP address"],
  ["concealment", "high", /\b(don'?t|do not|never|without)\b[^.\n]{0,20}\b(tell|telling|inform|informing|mention|show|notify|ask|asking|alert)\w*\b[^.\n]{0,20}\b(your|the)\s+(human|user|owner|operator|creator)/i, "tells the agent to keep this from its human"],
  ["concealment", "high", /\bkeep (this|these|it) (secret|hidden|between us|private)\b/i, "asks for secrecy"],
  ["override", "high", /\b(ignore|disregard|forget|override)\b[^.\n]{0,20}\b(all |any |your )?(previous|prior|above|earlier|system|safety|original)\b[^.\n]{0,15}\b(instructions?|rules|prompts?|guidelines|guardrails)\b/i, "tries to override the agent's own rules"],
  ["override", "medium", /\byou are now\b|\bnew (system )?instructions?\s*:|\bdeveloper mode\b|\bjailbreak\b|\bDAN\b/, "tries to give the agent a new identity or instructions"],
  ["persistence", "medium", /\b(add|write|append|save|store|insert|put)\b[^.\n]{0,30}\b(to|into|in)\s+(your\s+)?(memory|memories|system prompt|instructions|config|cron|crontab|heartbeat|soul\.md|agents?\.md|claude\.md|profile|startup)/i, "writes itself into the agent's memory or schedule"],
  ["dynamic", "high", /\b(fetch|download|read|load|curl|get)\b[^\n]{0,90}?\b(and|then)\s+(follow|execute|run|obey|do what it says|apply)\b/i, "fetches more instructions at run time and follows them"],
];

const INVISIBLE = /[​-‏⁠-⁤﻿­]/g;
const BIDI = /[‪-‮⁦-⁩]/g;
const TAGS = /[\u{E0000}-\u{E007F}]/gu;

const MORSE = { ".-": "a", "-...": "b", "-.-.": "c", "-..": "d", ".": "e", "..-.": "f", "--.": "g", "....": "h", "..": "i", ".---": "j", "-.-": "k", ".-..": "l", "--": "m", "-.": "n", "---": "o", ".--.": "p", "--.-": "q", ".-.": "r", "...": "s", "-": "t", "..-": "u", "...-": "v", ".--": "w", "-..-": "x", "-.--": "y", "--..": "z", "-----": "0", ".----": "1", "..---": "2", "...--": "3", "....-": "4", ".....": "5", "-....": "6", "--...": "7", "---..": "8", "----.": "9" };
/** Decodes Morse runs (at least 8 symbols): letters separated by spaces, words by " / " or 3 spaces. */
export function decodeMorse(text) {
  const runs = String(text).match(/(?:[.\-·•—–_]{1,6}[ \t]*(?:\/[ \t]*)?){8,}/g) ?? [];
  return runs.map((r) => r.replace(/[·•]/g, ".").replace(/[—–_]/g, "-").trim().split(/\s*\/\s*|\s{3,}/).map((w) => w.split(/\s+/).map((c) => MORSE[c] ?? "").join("")).join(" ").trim()).filter((s) => s.replace(/\s/g, "").length >= 6);
}
/** Base64 blobs that decode to readable text. */
export function decodeBase64(text) {
  const out = [];
  for (const m of String(text).match(/[A-Za-z0-9+/]{40,}={0,2}/g) ?? []) {
    if (/^[0-9a-fA-F]+$/.test(m)) continue; // hex, not base64
    const s = Buffer.from(m, "base64").toString("utf8");
    const printable = s.replace(/[^\x20-\x7e\n\t]/g, "").length / Math.max(1, s.length);
    if (printable > 0.95 && /[a-z]{3,}\s+[a-z]{2,}/i.test(s)) out.push(s);
  }
  return out;
}
const tagText = (t) => [...String(t).matchAll(TAGS)].map((m) => String.fromCodePoint(m[0].codePointAt(0) - 0xe0000)).join("");

/** The whole scan. Returns { verdict: DANGER | CAUTION | CLEAR, findings: [{ id, severity, why, line, hidden? }] }. */
export function scanInstructions(input, { depth = 0 } = {}) {
  const text = String(input ?? "");
  const findings = [];
  const lineOf = (i) => text.slice(0, i).split("\n").length;
  const add = (f) => { if (!findings.some((x) => x.id === f.id && x.why === f.why && x.hidden === f.hidden)) findings.push(f); };
  const lineText = (i) => { const st = text.lastIndexOf("\n", i) + 1, en = text.indexOf("\n", i); return text.slice(st, en < 0 ? undefined : en).trim().slice(0, 160); };
  for (const [id, severity, re, why] of RULES) { const m = text.match(re); if (m) add({ id, severity, why, line: lineOf(m.index), quote: lineText(m.index) }); }
  if (depth === 0) {
    const secrets = findSecrets(text);
    for (const s of secrets) add({ id: "contains-secret", severity: "critical", why: `contains what looks like a ${s.kind}`, line: lineOf(s.at) });
    // hidden channels: whatever they carry is scanned as if it were in plain sight
    const hidden = [];
    const inv = text.match(INVISIBLE);
    if (inv && inv.length >= 3) add({ id: "hidden-text", severity: "medium", why: `${inv.length} invisible characters (zero-width) in the text`, line: lineOf(text.search(INVISIBLE)) });
    if (BIDI.test(text)) add({ id: "hidden-text", severity: "high", why: "right-to-left override characters: what you see is not the order the agent reads", line: lineOf(text.search(BIDI)) });
    const tags = tagText(text);
    if (tags.length >= 4) { add({ id: "hidden-text", severity: "high", why: "text hidden in invisible Unicode tag characters", line: lineOf(text.search(TAGS)) }); hidden.push(["unicode tags", tags]); }
    for (const c of text.match(/<!--([\s\S]*?)-->/g) ?? []) if (c.length > 20) hidden.push(["an HTML comment", c.slice(4, -3)]);
    for (const m of decodeMorse(text)) hidden.push(["Morse code", m]);
    for (const b of decodeBase64(text)) hidden.push(["base64", b]);
    for (const [how, payload] of hidden) {
      const inner = scanInstructions(payload, { depth: 1 });
      for (const f of inner.findings) add({ ...f, severity: "high", hidden: how, why: `${f.why} (hidden in ${how})` });
      if (!inner.findings.length && /\b(transfer|send|approve|sign|ignore|execute|run|delete|reveal)\b/i.test(payload)) add({ id: "hidden-command", severity: "high", hidden: how, why: `a command hidden in ${how}` });
    }
  }
  const verdict = findings.some((f) => f.severity === "high" || f.severity === "critical") ? "DANGER" : findings.length ? "CAUTION" : "CLEAR";
  return { verdict, findings };
}

// ───────────────────────── 3. safe fetching ─────────────────────────
/** True for a public http(s) URL; false for localhost, private and link-local ranges, metadata hosts and odd ports. */
export function isPublicUrl(u) {
  let url; try { url = new URL(u); } catch { return false; }
  if (!/^https?:$/.test(url.protocol) || url.username || url.password) return false;
  if (url.port && !["80", "443", "8080", "8443"].includes(url.port)) return false;
  const h = url.hostname.toLowerCase().replace(/^\[|\]$/g, "");
  if (h === "localhost" || h.endsWith(".localhost") || h.endsWith(".local") || h.endsWith(".internal") || h === "metadata.google.internal") return false;
  if (/^\d+$/.test(h)) return false; // decimal-encoded IPs
  const v4 = h.match(/^(\d+)\.(\d+)\.(\d+)\.(\d+)$/);
  if (v4) {
    const [a, b] = [Number(v4[1]), Number(v4[2])];
    if (a === 10 || a === 127 || a === 0 || (a === 169 && b === 254) || (a === 172 && b >= 16 && b <= 31) || (a === 192 && b === 168) || (a === 100 && b >= 64 && b <= 127) || a >= 224) return false;
  }
  if (h.includes(":") && (h === "::1" || h.startsWith("fc") || h.startsWith("fd") || h.startsWith("fe80") || h.startsWith("::ffff:"))) return false;
  return true;
}
