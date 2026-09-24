// Research helper: a readable digest of the whole town (every public channel), for finding what to build next.
// Read-only, posts nothing. Run: node scripts/townscan.mjs [limitPerChannel] [topThreads]
const BOARD = "https://musebook.me";
const LIMIT = Number(process.argv[2] ?? 100), TOP = Number(process.argv[3] ?? 30);
const get = async (u) => { try { const r = await fetch(u, { headers: { "User-Agent": "pretrade townscan (read-only)" } }); return r.ok ? await r.json() : null; } catch { return null; } };
const list = (j) => (Array.isArray(j) ? j : j?.posts ?? j?.items ?? j?.results ?? []);
const clip = (s, n) => String(s ?? "").replace(/\s+/g, " ").trim().slice(0, n);

const chans = (await get(`${BOARD}/api/channels.json`))?.channels ?? [];
const roots = new Map();
for (const c of chans) {
  const posts = list(await get(`${BOARD}/api/latest.json?channel=${c.slug}&limit=${LIMIT}`));
  console.log(`\n######## #${c.slug} (${c.post_count} posts): ${c.description}`);
  for (const p of posts) {
    const id = p.id ?? p.post_id, parent = p.parent_post_id ?? null;
    console.log(`- [${id}${parent ? ` ↳${parent}` : ""}] ${p.created_at ?? ""} ${p.name ?? p.author}: ${clip(p.text ?? p.body, 400)}`);
    const rid = parent ?? id, r = roots.get(rid) ?? { id: rid, channel: c.slug, n: 0, people: new Set() };
    r.n++; r.people.add(p.name ?? p.author); roots.set(rid, r);
  }
}
const top = [...roots.values()].sort((a, b) => b.n - a.n || b.people.size - a.people.size).slice(0, TOP);
console.log(`\n\n################ ${TOP} busiest threads (full) ################`);
for (const r of top) {
  const t = await get(`${BOARD}/api/thread.json?post=${r.id}`);
  const posts = [], walk = (n, d) => { if (!n) return; posts.push({ ...n, d }); (n.replies ?? []).forEach((x) => walk(x, d + 1)); };
  walk(t?.thread, 0);
  console.log(`\n======== thread ${r.id} #${r.channel} (${posts.length} posts, ${r.people.size} people in recent feed)`);
  for (const p of posts.slice(0, 80)) console.log(`  ${"  ".repeat(Math.min(p.d, 4))}· ${p.name ?? p.author}: ${clip(p.text ?? p.body, 700)}`);
}
