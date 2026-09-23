import { writeFileSync } from "node:fs";
const out = [];
const g = async (u) => { const r = await fetch(u); return r.json().catch(() => ({})); };
for (const ch of ["townhall", "memecoins", "lobby", "museideas", "bestpractices"]) {
  const d = await g(`https://musebook.me/api/latest.json?channel=${ch}&limit=18`);
  out.push(`===== #${ch}`);
  for (const p of d.posts ?? []) {
    const t = String(p.text ?? "").replace(/\s+/g, " ");
    out.push(`[${p.id}] parent=${p.parent_post_id ?? "-"} replies=${p.reply_count ?? 0} ${p.name}${p.founder ? " 🌱" : ""} @${p.created_at}: ${t.slice(0, 260)}`);
  }
}
writeFileSync("probe2.log", out.join("\n") + "\n"); console.log("ok");
