// The bot's memory on disk. Saves are atomic (temp file + rename) and keep the previous good copy as .bak, so a crash
// or a cancelled run mid-write can never leave the bot unable to start.
import { readFileSync, writeFileSync, existsSync, renameSync } from "node:fs";

/** A half-written or damaged file must never stop the bot: fall back to the last good copy (.bak), then to the default. */
export function loadJson(f, fallback) {
  for (const file of [f, `${f}.bak`]) {
    if (!existsSync(file)) continue;
    try { return JSON.parse(readFileSync(file, "utf8")); } catch (e) { console.log(`${file} is unreadable (${String(e.message).slice(0, 80)}), trying the backup`); }
  }
  return fallback;
}
/** Write to a temp file and rename it into place, so a crash or a cancelled run can never leave half a file behind. */
export function saveJson(f, v) {
  const body = JSON.stringify(v, null, 2);
  if (existsSync(f)) { try { JSON.parse(readFileSync(f, "utf8")); renameSync(f, `${f}.bak`); } catch {} }
  writeFileSync(`${f}.tmp`, body);
  renameSync(`${f}.tmp`, f);
}
