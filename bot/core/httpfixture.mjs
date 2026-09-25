// @ts-check
// Record / replay for the HTTP layer. Every external read the check pipeline makes (DexScreener, GoPlus, Etherscan,
// JSON-RPC incl. the trade simulation's eth_calls) goes through one `http(url, body)` function, so capturing that one
// function captures a whole check. A recorded file replays the check offline, byte for byte, with no network.
//
//   record:  PRETRADE_HTTP_FIXTURE=f.json PRETRADE_HTTP_MODE=record node bot/musebot.mjs checkjson <addr>
//   replay:  PRETRADE_HTTP_FIXTURE=f.json PRETRADE_HTTP_MODE=replay node bot/musebot.mjs checkjson <addr>
//
// Keys never enter a fixture: URLs and bodies pass through `scrub` (the bot's own redact) before they are stored.
import { readFileSync, writeFileSync, existsSync } from "node:fs";

/** The request's identity: method, URL and body, with JSON-RPC ids dropped (they don't change the answer). */
export function requestKey(/** @type {string} */ url, /** @type {unknown} */ body) {
  const strip = (/** @type {any} */ b) => (Array.isArray(b) ? b.map(strip) : b && typeof b === "object" && "jsonrpc" in b ? { ...b, id: 0 } : b);
  return `${body === undefined ? "GET" : "POST"} ${url}${body === undefined ? "" : " " + JSON.stringify(strip(body))}`;
}

/**
 * Wraps a live http function. mode "record" calls through and stores every answer; mode "replay" answers only from the
 * file and never touches the network (a request it has no answer for comes back as a failed request, and is counted).
 * Repeated requests replay their answers in the order they were recorded; the last one repeats after that.
 * @param {string} file
 * @param {"record" | "replay"} mode
 * @param {import("./types").Http} live
 * @param {{ scrub?: (s: string) => string }} [opts]
 */
export function httpFixture(file, mode, live, { scrub = (s) => s } = {}) {
  /** @type {Record<string, import("./types").HttpResult[]>} */
  const store = mode === "replay" && existsSync(file) ? JSON.parse(readFileSync(file, "utf8")).requests ?? {} : {};
  /** @type {Record<string, number>} */
  const cursor = {};
  const misses = /** @type {string[]} */ ([]);
  const save = () => writeFileSync(file, JSON.stringify({ recordedAt: new Date().toISOString(), requests: store }, null, 1) + "\n");

  /** @type {import("./types").Http & { misses: string[] }} */
  const http = Object.assign(async (/** @type {string} */ url, /** @type {unknown} */ body) => {
    const key = scrub(requestKey(url, body));
    if (mode === "replay") {
      const list = store[key];
      if (!list?.length) { misses.push(key); return { ok: false, status: 0, json: null, text: "fixture: no recorded answer" }; }
      const i = Math.min(cursor[key] ?? 0, list.length - 1);
      cursor[key] = i + 1;
      return list[i];
    }
    const r = await live(url, body);
    const clean = { ok: r.ok, status: r.status, json: r.json === null ? null : JSON.parse(scrub(JSON.stringify(r.json))), text: r.json === null ? scrub(r.text).slice(0, 4000) : "" };
    (store[key] ??= []).push(clean);
    save();
    return r;
  }, { misses });
  return http;
}
