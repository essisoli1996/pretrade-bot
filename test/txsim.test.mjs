// Offline test for pre-signing simulation (bot/txsim.mjs): parsing, log → wallet effects, and findings.
// The live path (eth_simulateV1 and the eth_call fallback) was checked on a local chain: unlimited approve,
// a fake "claim" that forwards ETH to a thief, a normal purchase, a revert with its reason, a plain send.
// Run: node test/txsim.test.mjs
import { parseTx, effectsFor, describeTxSim, NATIVE } from "../bot/txsim.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };
const w = (v) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
const t = (a) => "0x" + a.replace(/^0x/, "").padStart(64, "0");
const ME = "0x1111111111111111111111111111111111111111", BAD = "0x000000000000000000000000000000000000bad1", DEX = "0x2222222222222222222222222222222222222222";
const TOK = "0x3333333333333333333333333333333333333333", NFT = "0x4444444444444444444444444444444444444444";
const T = { transfer: "0xddf252ad1be2c89b69c2b068fc378daa952ba7f163c4a11628f55a4df523b3ef", approval: "0x8c5be1e5ebec7d5bd14f71427d1e84f3dd0314c0f7b2291e5b200ac8c7c3b925", all: "0x17307eab39ab6107e8899845ad3d59bd9653f200f220920489ca2b5937696c31", batch: "0x4a39dc06d4c0dbc64b70af90fd698a233a518aa5d07e595d983b8c0526c8f7fb" };

// parsing
const p1 = parseTx(`sign this pls {"method":"eth_sendTransaction","params":[{"from":"${ME}","to":"${TOK}","data":"0xa9059cbb","value":"0x10","chainId":"0x2105"}]}`, { 8453: "base" });
check(p1?.from === ME && p1.to === TOK && p1.value === 16n && p1.chain === "base", "parses an eth_sendTransaction request, hex value and chainId");
const p2 = parseTx(`{"from":"${ME}","to":"${TOK}","input":"0x","value":"1000000000000000000","chainId":4663}`, { 4663: "robinhood" });
check(p2?.value === 10n ** 18n && p2.data === "0x" && p2.chain === "robinhood", "parses decimal value, input field, numeric chainId");
check(parseTx(`{"to":"nope"}`) === null && parseTx("no json here") === null, "rejects text without a transaction");

// logs → effects
const logs = [
  { address: NATIVE, topics: [T.transfer, t(ME), t(DEX)], data: "0x" + w(10n ** 18n) },
  { address: TOK, topics: [T.transfer, t(DEX), t(ME)], data: "0x" + w(5_000_000n) },
  { address: TOK, topics: [T.approval, t(ME), t(BAD)], data: "0x" + "f".repeat(64) },
  { address: NFT, topics: [T.all, t(ME), t(BAD)], data: "0x" + w(1) },
  { address: NFT, topics: [T.transfer, t(ME), t(BAD), t(w(7))], data: "0x" },
  { address: NATIVE, topics: [T.transfer, t(DEX), t(BAD)], data: "0x" + w(10n ** 17n) }, // DEX forwards some ETH on
  { address: NFT, topics: [T.batch, t(ME), t(ME), t(BAD)], data: "0x" + w(64) + w(160) + w(2) + w(1) + w(2) + w(2) + w(10) + w(20) },
];
const e = effectsFor(logs, ME);
const eth = e.moves.find((m) => m.token === NATIVE), tok = e.moves.find((m) => m.token === TOK);
check(eth.out === 10n ** 18n && tok.in === 5_000_000n, "ETH out and token in are measured");
check(e.moves.some((m) => m.kind === "erc721" && m.id === "7" && m.out === 1n), "ERC-721 transfer out with its id");
check(e.moves.filter((m) => m.kind === "erc1155").map((m) => `${m.id}:${m.out}`).join(",") === "1:10,2:20", "ERC-1155 batch decoded");
check(e.approvals.length === 2 && e.approvals.some((a) => a.kind === "all" && a.approved), "approve + setApprovalForAll found");
check(e.forwards.length === 1 && e.forwards[0].to === BAD, "follows ETH one hop further");

const info = { [NATIVE]: { symbol: "ETH", decimals: 18 }, [TOK]: { symbol: "USDC", decimals: 6 }, [NFT]: { symbol: "PUNK", decimals: 0 } };
const d = describeTxSim({ ok: true, chain: "base", block: 9, ...e, info });
check(d.lines.some((l) => /you receive: 5 \$USDC/.test(l)), "amounts use token decimals");
check(d.findings.some((f) => f.crit && /every item in \$PUNK/.test(f.why)), "setApprovalForAll: critical");
check(d.findings.some((f) => /unlimited \$USDC/.test(f.why)), "unlimited approval: flagged");
check(d.findings.some((f) => f.crit && /sweep shape/.test(f.why)), "3+ assets out to 2+ addresses: sweep shape, critical");
check(d.counterparties.some((c) => c.addr === BAD && c.role === "spender"), "spenders go to the reputation checks");

const WETH = "0x4200000000000000000000000000000000000006";
const wrap = effectsFor([
  { address: NATIVE, topics: [T.transfer, t(ME), t(WETH)], data: "0x" + w(10n ** 16n) },
  { address: WETH, topics: ["0xe1fffcc4923d04b559f4d29a8bfc6cda04eb5b0d3c460751c2402c5c5cc9109c", t(ME)], data: "0x" + w(10n ** 16n) },
], ME);
const wrapD = describeTxSim({ ok: true, chain: "base", block: 9, ...wrap, info: { ...info, [WETH]: { symbol: "WETH", decimals: 18 } } });
check(wrapD.lines.some((l) => /you receive: 0.01 \$WETH/.test(l)) && wrapD.findings.length === 0, "WETH wrap: Deposit event counts as receiving WETH, no false 'nothing back'");
const claim = describeTxSim({ ok: true, chain: "base", block: 9, moves: [{ token: NATIVE, kind: "native", id: null, out: 10n ** 18n, in: 0n, counterparties: [DEX] }], approvals: [], forwards: [{ token: NATIVE, via: DEX, to: BAD, amount: 10n ** 18n }], info });
check(claim.findings.some((f) => /nothing comes back/.test(f.why)) && claim.counterparties.some((c) => c.role === "forwarded to" && c.nothingBack), "value out, nothing back, forwarded: flagged and handed on");
const send = describeTxSim({ ok: true, chain: "base", block: 9, moves: [{ token: NATIVE, kind: "native", id: null, out: 1n, in: 0n, counterparties: [DEX] }], approvals: [], forwards: [], info }, { plainSend: true });
check(send.findings.length === 0, "plain send to a friend: nothing flagged");
check(describeTxSim({ ok: false, chain: "base", block: 9, revert: "sale closed" }).lines[0].includes("FAIL right now (sale closed)"), "revert reason shown");
check(describeTxSim({ ok: true, chain: "base", block: 9, moves: null }).lines[0].includes("can't show asset changes"), "eth_call fallback says what it can't see");
check(describeTxSim({ error: "no RPC configured for x" }).findings.length === 0, "no simulation: no findings");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
