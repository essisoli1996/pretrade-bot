// Lean desk: the engine does the rule checks a reviewer used to do by hand, so reports stay short and only the
// judgment calls reach a person. Pure functions; musebot.mjs wires them to the board and desk.json.
import { unbackedNumbers, ownerTalk } from "./addrctx.mjs";
import { findSecrets } from "./sentinel.mjs";

const ASK = /\?|\b(what|how|why|when|which|who|is it|is this|are they|can you|could you|should i|would you|check|read|look at|thoughts|opinion|safe|legit|rug|scam|explain|help|wdyt)\b/i;
const NOISE = /^[\s\p{Extended_Pictographic}\p{P}]*(gm|gn|lol|lmao|haha|nice|thanks|thank you|thx|ty|lfg|based|wagmi|ngmi|ok|okay|cool|wow|fire|same|this|facts|true|agreed|\+1)?[\s\p{Extended_Pictographic}\p{P}]*$/iu;

/** Does an inbox item need pretrade's answer? { reply, why }. Conservative: anything that asks, reply-worthy. */
export function needsReply(text) {
  const t = String(text ?? "").replace(/@\w+/g, " ").replace(/https?:\/\/\S+/g, " ").trim();
  if (!t || NOISE.test(t)) return { reply: false, why: "reaction, no ask" };
  if (ASK.test(t)) return { reply: true, why: "asks something" };
  if (t.length < 40) return { reply: false, why: "short remark, no ask" };
  return { reply: true, why: "long remark: judge it" };
}

const CANT = /\b(i|we)\s+(can['’]?t|cannot|can not|am unable|are unable|don['’]?t have (the )?(access|ability|tool))\b/i;
const NARRATION = /\b(held for (approval|review)|pending (approval|review)|awaiting (approval|review)|after review|once approved|nothing posts unless)\b/i;
const OWN_TOKEN = /\$?\bPTRD\b/i;
const CORRECTION = /\b(correction|i was wrong|earlier (post|reply) (was|is) wrong|to correct my|update to my (last|earlier))\b/i;
const PAID = /\b(paid (work|report|service)|pay me|my (rate|fee|price)|offer (you|to)|partner(ship)?|dm me|invoice)\b/i;

/** The rule checks, on a draft. facts = tool output from the last 2 hours. → [problem, ...]; [] means machine-clean. */
export function lintDraft(text, { facts = "", names = [], maxChars = 500 } = {}) {
  const t = String(text ?? ""), out = [];
  const missing = unbackedNumbers(t, facts);
  if (missing.length) out.push(`numbers not in a tool run from the last 2h: ${missing.join(", ")}`);
  const owner = ownerTalk(t, names);
  if (owner) out.push(`points at the owner: "${owner}"`);
  const narr = t.match(NARRATION);
  if (narr) out.push(`approval narration: "${narr[0]}"`);
  if (findSecrets(t).length) out.push("looks like a key or seed phrase");
  const cant = t.match(CANT);
  if (cant) out.push(`says "${cant[0]}" in public: put it under Needs`);
  if (OWN_TOKEN.test(t)) out.push("mentions $PTRD: leave it out of posts");
  const corr = t.match(CORRECTION);
  if (corr) out.push(`corrects an old post ("${corr[0]}"): not until the new-version post`);
  const paid = t.match(PAID);
  if (paid) out.push(`"${paid[0]}" may need approval: Needs, not the post`);
  if ([...t].length > maxChars) out.push(`${[...t].length} chars (max ${maxChars})`);
  return out;
}

/** One report, short. r = { n, key, where, ask, read, draft, hash, problems, doubts, needs, skip } */
export function reportLines(r) {
  if (r.skip) return [`#${r.n} ${r.key} ${r.where}: no reply (${r.skip}) ✓`];
  const lines = [
    `#${r.n} ${r.key} ${r.where}`,
    `  ask: ${r.ask}`,
    `  read: ${r.read || "-"}`,
    `  draft: ${r.draft}`,
    `  hash: ${r.hash}   check: ${r.problems.length ? `✗ ${r.problems.join("; ")}` : "✓ clean"}`,
  ];
  if (r.doubts) lines.push(`  doubts: ${r.doubts}`);
  if (r.needs) lines.push(`  needs: ${r.needs}`);
  return lines;
}

/** Machine streak over saved reports, newest last: clean skips and clean drafts count, a flagged draft resets. */
export function machineStreak(reports) {
  let s = 0;
  for (const r of reports ?? []) s = r.skip || !(r.problems ?? []).length ? s + 1 : 0;
  return s;
}
