// Explorer receipts: contract creator and an address's token transfers, offline with fake answers.  node test/explorer.test.mjs
import assert from "node:assert/strict";
import { parseCreation, summarizeTransfers, makeExplorer } from "../bot/explorer.mjs";

const TOKEN = "0x0379e228f6887c6f18bf394042ecaf81b308cb2e", FACTORY = "0x5f13c63a0000000000000000000000047fcb2dc6";
const WALLET = "0x1111111111111111111111111111111111111111", ESCROW = "0x2222222222222222222222222222222222222222";
const USDC = "0x833589fcd6edb6e08f4c7c32d4f71b54bda02913", CLAIMER = "0x3333333333333333333333333333333333333333";

// creation rows, both explorer spellings
assert.deepEqual(parseCreation([{ contractCreator: FACTORY.toUpperCase().replace("0X", "0x"), txHash: "0xabc", timestamp: "1790000000" }]), { creator: FACTORY, factory: null, txHash: "0xabc", timestamp: 1790000000 });
assert.equal(parseCreation([{ creatorAddress: WALLET, transactionHash: "0xdef" }]).txHash, "0xdef");
assert.equal(parseCreation([]), null);
assert.equal(parseCreation([{ contractCreator: "nope" }]), null);

// transfers: in and out of an escrow, exact amounts with the token's decimals, self-transfers ignored
const tx = (from, to, value, t, hash) => ({ from, to, value, timeStamp: String(t), hash, tokenSymbol: "USDC", tokenDecimal: "6" });
const rows = [tx(WALLET, ESCROW, "5000000", 1, "0x1"), tx(WALLET, ESCROW, "2500000", 2, "0x2"), tx(ESCROW, CLAIMER, "1000000", 3, "0x3"), tx(ESCROW, ESCROW, "7", 4, "0x4")];
const s = summarizeTransfers(rows, ESCROW);
assert.equal(s.in.count, 2); assert.equal(s.in.total, "7.5");
assert.equal(s.out.count, 1); assert.equal(s.out.total, "1"); assert.equal(s.out.rows[0].counterparty, CLAIMER); assert.equal(s.out.rows[0].hash, "0x3");
assert.equal(summarizeTransfers([], ESCROW).out.count, 0);

// the client: Etherscan first with the key, Blockscout when Etherscan fails, and the key never in a result
const seen = [];
const http = async (url) => {
  seen.push(url);
  if (url.includes("etherscan") && url.includes("getcontractcreation")) return { ok: true, json: { status: "0", message: "NOTOK", result: "Missing or unsupported chainid" } };
  if (url.includes("blockscout") && url.includes("getcontractcreation")) return { ok: true, json: { status: "1", result: [{ contractCreator: FACTORY, txHash: "0xtx" }] } };
  if (url.includes("tokentx") && url.includes("etherscan")) return { ok: true, json: { status: "0", message: "No transactions found", result: [] } };
  return { ok: false, json: null };
};
const rpc = async (m, p) => (m === "eth_getTransactionByHash" ? { result: { from: WALLET } } : m === "eth_getCode" ? { result: p[0] === FACTORY ? "0x6080" : "0x" } : {});
const X = makeExplorer({ http, rpcFor: () => rpc, key: "SECRETKEY123" });
const c = await X.creator(TOKEN, "robinhood");
assert.equal(c.ok, true); assert.equal(c.via, "blockscout");
assert.equal(c.creator, FACTORY); assert.equal(c.creatorKind, "contract");
assert.equal(c.sender, WALLET); assert.equal(c.senderKind, "no code", "the launch wallet behind a factory deploy is found");
assert.ok(seen[0].includes("api.etherscan.io") && seen[1].includes("blockscout"), "etherscan first, then blockscout");
assert.ok(!JSON.stringify(c).includes("SECRETKEY123"), "the key never appears in a result");
const t = await X.transfers(USDC, ESCROW, "base");
assert.equal(t.ok, true); assert.equal(t.out.count, 0, "no transfers found is an answer, not a failure");
assert.equal((await X.creator(TOKEN, "solana")).ok, false, "a chain with no explorer says so");

console.log("explorer: ok");

// fallback holder list: Blockscout balances as a share of on-chain supply, biggest first
{
  const { holdersShape, blockscoutHolders } = await import("../bot/explorer.mjs");
  const A = "0x" + "a".repeat(40), B = "0x" + "b".repeat(40);
  const h = holdersShape([{ address: A, value: "100" }, { address: B, value: "600" }, { address: "junk", value: "5" }], 1000n);
  assert.deepEqual(h, [{ address: B, percent: "0.6" }, { address: A, percent: "0.1" }]);
  assert.deepEqual(holdersShape([{ address: A, value: "1" }], 0n), []);
  const got = await blockscoutHolders("0x" + "c".repeat(40), "robinhood", {
    http: async () => ({ ok: true, json: { status: "1", result: [{ address: A, value: "250" }] } }),
    rpc: async () => ({ result: "0x3e8" }), // 1000
  });
  assert.deepEqual(got.holders, [{ address: A, percent: "0.25" }]);
  assert.equal(await blockscoutHolders("0x" + "c".repeat(40), "solana", { http: async () => ({}), rpc: async () => ({}) }), null);
  console.log("explorer holders: ok");
}
