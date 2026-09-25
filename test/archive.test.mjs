// Archive reads, verified sources, keys. Run: node test/archive.test.mjs
import { writeFileSync, mkdtempSync } from "node:fs";
import { join } from "node:path";
import { tmpdir } from "node:os";
import { codeKind, loadKeysFile, archiveUrl, redact, etherscanSource } from "../bot/archive.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

const t = "3be8b97fd0e713b5abe0649fa830223b6b4bc599";
check(codeKind("0x").kind === "no code", "an empty account has no code");
check(codeKind("0xef0100e6cae83bde06e4c305530e199d7217f42808555b").kind === "EIP-7702 wallet", "a 7702 delegation reads as a wallet (0xFcDE, report #4)");
check(codeKind(`0x363d3d373d3d3d363d73${t}5af43d82803e903d91602b57fd5bf3`).target === "0x" + t, "a standard EIP-1167 clone gives its target");
const town = `0x363d3d373d3d3d363d73${t}5af43d82803e903d91602b57fd5bf3`.replace("363d3d373d3d3d363d73", "3d3d3d3d363d3d37363d73").slice(0, 2 + 88);
const k = codeKind(town);
check(k.kind === "minimal proxy (non-standard)" && k.target === "0x" + t, `a 44-byte non-standard proxy still gives its target (${k.kind})`);
check(codeKind("0x6080604052" + "00".repeat(200)).kind === "contract", "ordinary bytecode is a contract");

const dir = mkdtempSync(join(tmpdir(), "keys-"));
writeFileSync(join(dir, "keys.env"), "# keys\nNODEFLARE_KEY=nf_test_123\nETHERSCAN_KEY = \"ES456\"\nlower=ignored\n");
delete process.env.NODEFLARE_KEY; delete process.env.ETHERSCAN_KEY;
const loaded = loadKeysFile(join(dir, "keys.env"));
check(loaded.join() === "NODEFLARE_KEY,ETHERSCAN_KEY" && process.env.ETHERSCAN_KEY === "ES456", "keys.env loads KEY=value lines, quotes stripped");
check(archiveUrl() === "https://rpc.nodeflare.app/robinhood/nf_test_123", "the NodeFlare key makes the archive URL");
check(!redact(`GET ${archiveUrl()} failed, key ES456`).includes("nf_test_123") && !redact("ES456").includes("ES456"), "keys never reach printed text");
check(loadKeysFile(join(dir, "missing.env")).length === 0, "a missing keys file is fine");

const ok = await etherscanSource("0xabc", { key: "k", fetchJson: async () => ({ status: "1", result: [{ SourceCode: "contract X {}", ContractName: "Router", CompilerVersion: "v0.8.26", Proxy: "0", Implementation: "" }] }) });
check(ok.verified && ok.name === "Router", "verified source is read");
const none = await etherscanSource("0xabc", { key: "k", fetchJson: async () => ({ status: "1", result: [{ SourceCode: "", ContractName: "" }] }) });
check(none.ok && !none.verified, "an unverified contract says so");
check((await etherscanSource("0xabc", { key: "", fetchJson: async () => ({}) })) === null, "no key, no call");

console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
