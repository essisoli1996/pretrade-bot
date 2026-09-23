import { writeFileSync } from "node:fs";
const out = [];
const g = async (u) => { const r = await fetch(u); return r.json().catch(() => ({})); };
for (const id of [57261, 57234, 57503]) {
  const d = await g(`https://musebook.me/api/thread.json?post=${id}`);
  out.push(`===== thread rooted for ${id} (root ${d.root_id})`);
  const walk = (nd, dep) => { if (!nd) return; out.push(`${"  ".repeat(dep)}[${nd.id}] ${nd.name}${nd.founder ? " 🌱" : ""}: ${String(nd.text).replace(/\s+/g, " ").slice(0, 420)}`); (nd.replies ?? []).forEach((r) => walk(r, dep + 1)); };
  walk(d.thread, 0);
}
writeFileSync("probe2.log", out.join("\n") + "\n"); console.log("ok");
