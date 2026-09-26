// Launch provenance. Fixtures are real musepad directory rows (musepad.lol/api/tokens, 2026-09-24): the second
// $PORCH whose fee wallet is the first $PORCH's token contract, and two $NEWS launches by the same muse.
// Run: node test/provenance.test.mjs
import { indexLaunches, feeRecipient, siblingsOf, provenanceLines, tickerReport, reuseAlert, makeProvenance } from "../bot/provenance.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };
const REAL_PORCH = "0x4b434541873f171ab70d7d2f3a48b0f0b0f13ba3", PORCH2 = "0x655d23cad9a3db8f730696efd0f94e3b2c662c97";
const items = [
  { sourceThreadUrl: "https://musebook.me/p/65291", symbol: "PORCH", name: "PORCH", wallet: "0x4B434541873f171aB70D7d2F3a48b0f0b0f13ba3", paypal: null, launchpad: "muse-launchpad", platform: "#musemoneychallenge", contractAddress: "0x655D23cAd9a3DB8F730696efD0F94E3b2C662c97", launchedBy: { handle: "Pip" }, launchedAt: "2026-09-24T06:09:13.066Z" },
  { sourceThreadUrl: "https://musebook.me/p/60001", symbol: "PORCH", name: "Porch", wallet: "0x1111111111111111111111111111111111111111", paypal: null, launchpad: "muse-launchpad", contractAddress: REAL_PORCH, launchedBy: { handle: "Mikey" }, launchedAt: "2026-09-23T18:07:53.000Z" },
  { sourceThreadUrl: "https://musebook.me/p/64391", symbol: "NEWS", name: "MuseNews", wallet: "0x58449dCb17773d31fa96e92983162cbB9f16c474", paypal: null, contractAddress: "0x43922A8718EAc5e867F346e2C77A8e5B43481207", launchedBy: { handle: "Flash" }, launchedAt: "2026-09-24T03:57:52.058Z" },
  { sourceThreadUrl: "https://musebook.me/p/64312", symbol: "NEWS", name: "MuseNews", wallet: "0x58449dCb17773d31fa96e92983162cbB9f16c474", paypal: null, contractAddress: "0xE6b18Dc965939D0A2bEeDcf77249048E4684e592", launchedBy: { handle: "Flash" }, launchedAt: "2026-09-24T03:42:31.610Z" },
  { sourceThreadUrl: "https://musebook.me/p/58171", symbol: "MPTEST3411", name: "Musepad E2E Test 3411", wallet: "0x9999999999999999999999999999999999999999", paypal: "david.smith@gmail.com", contractAddress: "0x2222222222222222222222222222222222222222", launchedBy: { handle: "Musepad Tester" }, launchedAt: "2026-09-23T06:46:00.000Z" },
  { symbol: "BAD", contractAddress: "not-an-address" },
];
const reg = indexLaunches(items);
const now = Date.parse("2026-09-24T08:10:00Z");
check(reg.size === 5 && reg.bySymbol.get("PORCH")[0].launcher === "Mikey", "indexed by address and ticker, oldest first; junk rows skipped");

const p2 = reg.byAddr.get(PORCH2);
const fee = feeRecipient(p2, reg, "0x6080");
check(fee.kind === "token-contract" && fee.token.symbol === "PORCH", "the second $PORCH pays its fees into the first $PORCH's token contract");
check(fee.sameTicker === true && /a different contract that also calls itself \$PORCH/.test(fee.text) && /not to this token/.test(fee.text), "a same-ticker recipient is named as a different contract, never as this token ($MDOG, 79724)");
check(feeRecipient(reg.byAddr.get("0x2222222222222222222222222222222222222222"), reg, null).kind === "custodial", "paypal launch: custodial fee wallet");
check(feeRecipient(reg.byAddr.get(REAL_PORCH), reg, "0x").kind === "wallet", "plain wallet (no code)");
check(feeRecipient(reg.byAddr.get(REAL_PORCH), reg, "0xef0100" + "ab".repeat(20)).kind === "wallet", "EIP-7702 delegated wallet is still a wallet");
check(feeRecipient(reg.byAddr.get(REAL_PORCH), reg, "0x6080604052").kind === "contract", "some other contract: named as a contract, not judged");
// the real $PORCH was launched outside musepad: the directory doesn't know it, symbol() does
const outside = indexLaunches(items.filter((x) => x.contractAddress !== REAL_PORCH.replace(/^0x4b43/, "0x4B43") && String(x.contractAddress).toLowerCase() !== REAL_PORCH));
const p2o = outside.byAddr.get(PORCH2);
check(feeRecipient(p2o, outside, "0x6080", "PORCH").kind === "token-contract", "fee wallet is a token musepad didn't launch: recognised by its symbol()");
const outsideMarket = [{ address: REAL_PORCH, liq: 14109, trades: 610, created: Date.parse("2026-09-23T18:07:53Z") }, { address: PORCH2, liq: 0, trades: 0, created: Date.parse("2026-09-24T06:09:30Z") }];
const oa = reuseAlert(p2o, outside, outsideMarket, feeRecipient(p2o, outside, "0x6080", "PORCH"));
check(oa && /already trading: 0x4b43.*a launch outside musepad/.test(oa.join(" ")), "reuse alert also counts an earlier token launched outside musepad");

const news1 = reg.byAddr.get("0xe6b18dc965939d0a2beedcf77249048e4684e592");
check(siblingsOf(news1, reg)[0].relation === "same-launcher", "two $NEWS by Flash: same launcher (a retry), not a copycat");
const lines = provenanceLines(p2, reg, fee, { now });
check(/launched 2h ago by Pip via musepad \(musebook\.me\/p\/65291\)/.test(lines[0]) && /a different contract that also calls itself/.test(lines[0]), `provenance line: ${lines[0]}`);
check(/1 by other launchers: 0x4b43…3ba3 by Mikey, earlier/.test(lines[1] ?? ""), `sibling line: ${lines[1]}`);
check(!/fake|scam|imposter/i.test(lines.join(" ")), "no accusations, only facts");

const market = [{ address: REAL_PORCH, liq: 14109, trades: 610 }, { address: PORCH2, liq: 0, trades: 0 }, { address: "0x93ab06a8467ca42a6177ebf52babdbdb17edaa5e", liq: 7458, trades: 1 }];
const rep = tickerReport("$porch", reg, market, new Map([[PORCH2, fee]]), { now });
check(rep.found === 3 && rep.first === REAL_PORCH && rep.deepest === REAL_PORCH, "real PORCH: the first launched and the most liquid");
check(/\[most liquid, first\]/.test(rep.lines[1]) && /not a musepad launch/.test(rep.lines.join("\n")) && /a different contract that also calls itself/.test(rep.lines.join("\n")), `ticker report:\n    ${rep.lines.join("\n    ")}`);
check(tickerReport("NOPE", reg, [], new Map(), { now }).found === 0, "unknown ticker: says so, invents nothing");

const alert = reuseAlert(p2, reg, market, fee, { minLiquidityUsd: 5000 });
check(alert && /not the \$PORCH already trading: 0x4b43/.test(alert.join(" ")) && /fee note/.test(alert.join(" ")), `reuse alert:\n    ${alert?.join("\n    ")}`);
const newsMarket = [{ address: news1.address, liq: 8000, trades: 50 }];
check(reuseAlert(reg.byAddr.get("0x43922a8718eac5e867f346e2c77a8e5b43481207"), reg, newsMarket, feeRecipient(reg.byAddr.get("0x43922a8718eac5e867f346e2c77a8e5b43481207"), reg, "0x")) === null, "a retry by the same launcher with a normal fee wallet: not news, no alert");

// the live directory: paginated, a failed read keeps the last good copy, first fresh() only primes
let calls = 0, fail = false;
const pages = { 1: items.slice(0, 3), 2: items.slice(3) };
const http = async (url) => { calls++; if (fail) return { ok: false, json: null }; const pg = Number(url.match(/page=(\d+)/)[1]); return { ok: true, json: { items: pages[pg] ?? [], totalPages: 2 } }; };
const sym = (t) => "0x" + (32).toString(16).padStart(64, "0") + t.length.toString(16).padStart(64, "0") + Buffer.from(t).toString("hex").padEnd(64, "0");
const P = makeProvenance({ http, rpc: async (m) => ({ result: m === "eth_getCode" ? "0x6080" : sym("PORCH") }) });
check((await P.fresh()).length === 0 && P.registry().size === 5, "first fresh() reads both pages and only primes");
pages[1] = [{ ...items[0], contractAddress: "0x3333333333333333333333333333333333333333", launchedAt: "2026-09-24T08:00:00Z" }, ...pages[1]];
check((await P.fresh()).map((r) => r.address).join() === "0x3333333333333333333333333333333333333333", "the next fresh() returns only the new launch");
fail = true;
check((await P.refresh(true)).size === 6, "a failed directory read keeps the last good copy");
check((await P.lookup(PORCH2)).fee.kind === "token-contract", "lookup: record plus fee recipient");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
