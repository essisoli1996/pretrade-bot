// The owner's switches for the live bot, kept in bot/control.json in the repo. The bot re-reads the file from GitHub
// every minute, so an edit on github.com (or the GitHub phone app) reaches it without touching code.
//   paused: true        → the bot does nothing at all (not even reading)
//   readOnly: true      → everything runs, nothing is posted: every post goes to shadow.log instead
//   features.<name>     → true (on), false (off), or "shadow" (runs, writes what it would post to shadow.log)
//   approval: true      → nothing is posted by the engine: each post waits in outbox.jsonl for the Muse (approve / reject)
//   approvalExempt: []  → features whose posts skip that wait (e.g. ["leakWatch"] if a leaked key must be flagged fast)
export const FEATURES = ["mentions", "channels", "conversation", "launches", "launchReport", "townWatch", "guard", "tickerWatch", "leakWatch", "threatWatch", "digest", "radar", "watches", "presence"];
export const DEFAULTS = Object.freeze({ paused: false, readOnly: false, features: {} });

/** Accepts whatever is in the file and keeps only what makes sense; anything unreadable means "on" (the default). */
export function normalize(raw) {
  const c = raw && typeof raw === "object" ? raw : {};
  const features = {};
  for (const f of FEATURES) {
    const v = c.features?.[f];
    if (v === false || v === "off") features[f] = false;
    else if (v === "shadow") features[f] = "shadow";
  }
  const approvalExempt = Array.isArray(c.approvalExempt) ? c.approvalExempt.filter((f) => FEATURES.includes(f)) : [];
  return { paused: c.paused === true, readOnly: c.readOnly === true, approval: c.approval === true, approvalExempt, features };
}

/** True when a post by this feature must wait in the outbox for the Muse's approval. */
export const needsApproval = (control, feature) => control.approval === true && !(control.approvalExempt ?? []).includes(feature);

/** "on", "off" or "shadow" for one feature. */
export function modeOf(control, feature) {
  if (control.paused) return "off";
  const v = control.features?.[feature];
  if (v === false) return "off";
  if (control.readOnly || v === "shadow") return "shadow";
  return "on";
}

/** Reads the switches at most once a minute: from GitHub first, the local copy if GitHub can't be reached, and the
 *  last known value if neither can (a network blip never flips the bot on or off). */
export function makeControl({ fetchText, readLocal, everyMs = 60_000, now = () => Date.now() }) {
  let current = null, at = 0, source = "defaults";
  return {
    async get() {
      if (current && now() - at < everyMs) return current;
      at = now();
      for (const [name, read] of [["github", fetchText], ["local", readLocal]]) {
        try {
          const text = await read();
          if (text) { current = normalize(JSON.parse(text)); source = name; return current; }
        } catch {}
      }
      return (current ??= normalize(DEFAULTS));
    },
    source: () => source,
  };
}
