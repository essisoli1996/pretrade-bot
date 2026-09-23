// Offline test for the v4 hook read: a mocked RPC, no network.  Run: node test/v4hooks.test.mjs
import { keccak256, INIT_TOPIC, poolIdOf, keyFromLog, permissionsOf, makeV4Hooks, isV4, hookLine } from "../bot/v4hooks.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

// known vectors: empty input, the event topic, and the real mainnet ETH/USDC 0.05% v4 pool id
check(keccak256(new Uint8Array()) === "0xc5d2460186f7233c927e7db2dcc703c0e500b653ca82273b7bfad8045d85a470", "keccak256 of empty input");
check(INIT_TOPIC === "0xdd466e674ea557f56295e2d0218a125ea4b4f0f6f3307b95f85e6110838d6438", "Initialize event topic");
const ZERO = "0x0000000000000000000000000000000000000000";
check(poolIdOf({ currency0: ZERO, currency1: "0xa0b86991c6218b36c1d19d4a2e9eb0ce3606eb48", fee: 500, tickSpacing: 10, hooks: ZERO }) === "0x21c67e77068de97969ba93d4aab21826d33ca12bb9f565d8496e8fda8a82ca27", "pool id of mainnet ETH/USDC v4");
check(JSON.stringify(permissionsOf("0x00000000000000000000000000000000000000cc")) === JSON.stringify(["beforeSwap", "afterSwap", "beforeSwapReturnsDelta", "afterSwapReturnsDelta"]), "permission bits decode");

const PM = "0x000000000004444c5dc75cb358380d2e3de08a90";
const STD_HOOK = "0x5555555555555555555555555555555555552cc8"; // launchpad hook: swap + delta bits
const EVIL_HOOK = "0x66666666666666666666666666666666666600cc"; // beforeSwap, afterSwap, both swap deltas
const TOKEN = "0x1111111111111111111111111111111111111111", OWN = "0x2dc2614f99139c1342acc585515d6862a854fba3", QUOTE = "0x9999999999999999999999999999999999999999";
const w = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
const mkKey = (token, hooks, fee = 0x800000) => ({ currency0: token < QUOTE ? token : QUOTE, currency1: token < QUOTE ? QUOTE : token, fee, tickSpacing: -200 + 400, hooks });
const mkLog = (key, emitter = PM, idOverride) => ({
  address: emitter, blockNumber: "0x10",
  topics: [INIT_TOPIC, idOverride ?? poolIdOf(key), "0x" + w(key.currency0), "0x" + w(key.currency1)],
  data: "0x" + w(key.fee) + w(key.tickSpacing) + w(key.hooks) + w(1n << 96n) + w(0),
});
check(keyFromLog(mkLog(mkKey(TOKEN, EVIL_HOOK)))?.hooks === EVIL_HOOK, "key decodes from a real-shaped log");
const negKey = { ...mkKey(TOKEN, EVIL_HOOK), tickSpacing: -60 };
check(keyFromLog(mkLog(negKey))?.tickSpacing === -60, "negative tick spacing survives the round trip");
const spoof = mkLog(mkKey(TOKEN, ZERO), "0xbad0000000000000000000000000000000000bad", poolIdOf(mkKey(TOKEN, EVIL_HOOK)));
check(keyFromLog(spoof) === null, "spoofed log (key doesn't hash to the id) is rejected");

const pools = {
  std: mkKey(OWN, STD_HOOK), stdOther: mkKey(TOKEN, STD_HOOK), evil: mkKey(TOKEN, EVIL_HOOK), plain: mkKey(TOKEN, ZERO, 3000),
};
const ids = Object.fromEntries(Object.entries(pools).map(([k, v]) => [poolIdOf(v), v]));
let failFullRange = false;
const calls = [];
const http = async (url, body) => {
  calls.push(body.method);
  const ok = (result) => ({ ok: true, status: 200, json: { jsonrpc: "2.0", id: 1, result } });
  const [p0] = body.params ?? [];
  switch (body.method) {
    case "eth_getLogs": {
      if (failFullRange && p0.fromBlock === "0x0") return { ok: true, status: 200, json: { error: { code: -32000, message: "block range too large" } } };
      const key = ids[p0.topics[1]];
      return ok(key ? [spoof, mkLog(key)] : []); // the spoofed log comes first and must be skipped
    }
    case "eth_blockNumber": return ok("0x" + (1000000).toString(16));
    case "eth_getBlockByNumber": return ok({ timestamp: "0x" + (1_700_000_000 + parseInt(p0, 16)).toString(16) });
    case "eth_getCode": return ok(p0 === EVIL_HOOK ? "0x6080604052" : p0 === STD_HOOK ? "0x6080" : "0x");
    case "eth_getStorageAt": return ok(p0 === EVIL_HOOK && body.params[1].startsWith("0x3608") ? "0x" + w("0x7777777777777777777777777777777777777777") : "0x" + w(0));
    case "eth_call": return ok("0x" + w("0x8888888888888888888888888888888888888888"));
  }
  return ok(null);
};
const pair = (key, token, symbol) => ({ chainId: "robinhood", dexId: "uniswap", pairAddress: poolIdOf(key), pairCreatedAt: 1_700_000_000_000 + 500_000_000, baseToken: { address: token, symbol } });
const pairsFor = async (a) => (a.toLowerCase() === OWN ? [pair(pools.std, OWN, "PTRD")] : []);

const v4 = makeV4Hooks({ http, rpcUrl: "https://rpc.invalid", baselineToken: OWN });
const state = {};
const standard = await v4.baselineHooks(pairsFor, state);
check(standard.get(STD_HOOK)?.includes("PTRD"), "baseline = the hook on the bot's own token pool");

const std = await v4.inspect(pair(pools.stdOther, TOKEN, "STD"), standard, state);
check(std.points === 0 && std.standard, "standard launchpad hook: reported, 0 points");
const evil = await v4.inspect(pair(pools.evil, TOKEN, "EVIL"), standard, state);
check(evil.points === 70 && evil.contract.upgradeable && evil.contract.owner, `custom delta hook, dynamic fee, upgradeable: 70 points (${evil.risk.map((r) => r.text).join("; ")})`);
const plain = await v4.inspect(pair(pools.plain, TOKEN, "PLAIN"), standard, state);
check(plain.none && plain.points === 0 && plain.feePct === 0.3, "no hook: 0 points, static fee read");
check(!isV4({ pairAddress: "0x" + "a".repeat(40) }) && (await v4.inspect({ pairAddress: "0x" + "a".repeat(40) }, standard)) === null, "v2/v3 pair address is skipped");

calls.length = 0;
await v4.inspect(pair(pools.evil, TOKEN, "EVIL"), standard, state);
check(!calls.includes("eth_getLogs"), "pool key is cached in state (no second log query)");

failFullRange = true;
const v4b = makeV4Hooks({ http, rpcUrl: "https://rpc.invalid" });
const viaWindow = await v4b.inspect(pair(pools.evil, TOKEN, "EVIL"), new Map(), null);
check(viaWindow.readable && viaWindow.hook === EVIL_HOOK, "RPC refuses a full-range query → walks forward from the pair's birth block");
const unknownPool = await v4b.inspect({ ...pair(pools.evil, TOKEN, "X"), pairAddress: "0x" + "ab".repeat(32) }, new Map(), null);
check(unknownPool.readable === false && hookLine(unknownPool).includes("not checked"), "unreadable pool → 'not checked', never a guess");

console.log("\n" + [hookLine(std), hookLine(evil), hookLine(plain)].join("\n"));
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
