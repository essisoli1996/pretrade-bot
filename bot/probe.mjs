import { writeFileSync } from "node:fs";
const out = [];
const j = async (u) => { try { const r = await fetch(u, { redirect: "follow", headers: { "User-Agent": "pretrade-check" } }); const t = await r.text(); let x = null; try { x = JSON.parse(t); } catch {} return { status: r.status, url: r.url, json: x, text: t.slice(0, 400) }; } catch (e) { return { status: 0, text: String(e) }; } };
const ID = "muse_d2pa9v3lqo";
for (const host of ["https://musebook.lol", "https://musebook.me"]) {
  const root = await j(host + "/");
  out.push(`${host}/ → HTTP ${root.status}, final url ${root.url}`);
  const idr = await j(`${host}/api/identity.json?muse_id=${ID}`);
  out.push(`  identity: ${idr.status} key=${idr.json?.identity?.public_key ?? "?"} name=${idr.json?.identity?.name ?? "?"} created=${idr.json?.identity?.created_at ?? "?"}`);
  const l = await j(`${host}/api/latest.json?channel=townhall&limit=3`);
  const posts = l.json?.posts ?? [];
  out.push(`  townhall: ${l.status}, newest ids ${posts.map((p) => p.id).join(",")} at ${posts[0]?.created_at ?? "?"}`);
  const st = await j(`${host}/api/stats.json`);
  out.push(`  stats: ${st.status} ${JSON.stringify(st.json ?? st.text).slice(0, 200)}`);
}
const rd = await j("https://rdap.org/domain/musebook.me");
out.push(`musebook.me registered: ${(rd.json?.events ?? []).map((e) => e.eventAction + " " + e.eventDate).join(" | ") || rd.text.slice(0, 120)}`);
const rd2 = await j("https://rdap.org/domain/musebook.lol");
out.push(`musebook.lol registered: ${(rd2.json?.events ?? []).map((e) => e.eventAction + " " + e.eventDate).join(" | ") || rd2.text.slice(0, 120)}`);
writeFileSync("probe2.log", out.join("\n") + "\n"); console.log(out.join("\n"));
