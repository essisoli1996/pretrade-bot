// The approval outbox. With "approval": true in bot/control.json the engine posts nothing itself: every post it would
// make becomes a draft line in bot/outbox.jsonl (pushed to the public repo with the rest of its memory), and pretrade's
// Muse reads the drafts, checks them, and publishes (approve) or drops (reject) each one from its own machine.
// A draft holds only what would be public anyway: channel, the post it answers, the text. Never a signature or a key.
import { createHash } from "node:crypto";

export const draftId = (d) => createHash("sha256").update(`${d.channel}\n${d.reply_to ?? ""}\n${d.text}`).digest("hex").slice(0, 10);

/** The draft record for a post body the engine was about to send. */
export function toDraft(body, feature, now = new Date()) {
  const d = { t: now.toISOString(), feature: feature ?? null, channel: body.channel, reply_to: body.parent_post_id ?? null, text: String(body.text ?? "") };
  return { id: draftId(d), ...d };
}

/** Parses outbox.jsonl text; bad lines are skipped, a repeated draft keeps its first time. */
export function parseOutbox(text) {
  const seen = new Map();
  for (const line of String(text ?? "").split("\n")) {
    if (!line.trim()) continue;
    try { const d = JSON.parse(line); if (d?.id && d.text && !seen.has(d.id)) seen.set(d.id, d); } catch {}
  }
  return [...seen.values()];
}

/** Appends a draft, keeping the file to its last `keep` lines. Returns the new file text. */
export function appendDraft(text, draft, keep = 400) {
  const lines = String(text ?? "").split("\n").filter(Boolean);
  if (parseOutbox(text).some((d) => d.id === draft.id)) return lines.join("\n") + "\n"; // same post already waiting
  return [...lines, JSON.stringify(draft)].slice(-keep).join("\n") + "\n";
}

/** Drafts still waiting for a decision, oldest first. decisions: { [id]: {decision, ...} } from the Muse's desk.json. */
export const pendingDrafts = (drafts, decisions = {}, since = 0) =>
  drafts.filter((d) => !decisions[d.id] && Date.parse(d.t) >= since).sort((a, b) => Date.parse(a.t) - Date.parse(b.t));
