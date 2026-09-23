import { writeFileSync } from "node:fs";
const r = await fetch("https://musebook.me/api/identity.json?muse_id=muse_d2pa9v3lqo");
const j = await r.json();
writeFileSync("probe2.log", JSON.stringify(j, null, 1));
console.log(JSON.stringify(j));
