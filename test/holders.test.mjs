// Holder concentration. Run: node test/holders.test.mjs
import { top10Share, holderKind } from "../bot/holders.mjs";
import { codeKind } from "../bot/archive.mjs";

let bad = 0;
const check = (ok, label) => { console.log(`${ok ? "PASS" : "FAIL"}  ${label}`); if (!ok) bad++; };

// $MDOG on robinhood as GoPlus returned it (2026-09-25): the v4 pool manager first, then mostly contract wallets
const pm = "0x8366a39CC670B4001A1121B8F6A443A643e40951";
const mdog = [[pm, 1, 0.108794], ["0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952", 1, 0.081633], ["0x676C240e33A100F59b64Ac03058695D839C5Ce8e", 1, 0.050616], ["0xec21f1D1aF91F821B03DC6AdFFe115886c8e15a3", 1, 0.048699], ["0xFcDE40257f71fCA2586368DE911db231879BBF3e", 1, 0.036479], ["0x0d359d1c73A0Be602BFd4c3028B2545c06CE2Bce", 1, 0.035936], ["0x067A0F68d45B05cd9F864c1b8cf9bB55ebc8b8f1", 1, 0.030469], ["0x1b97d73585491F9ED247dE561ee64e8a5a84e5ff", 1, 0.024531], ["0x09278F0a4bC120f3F6baca779284c74a8784C963", 0, 0.020204], ["0x7CC9630a67F1200AF3F8af072f72242048AC398B", 1, 0.018347]]
  .map(([address, is_contract, percent]) => ({ address, is_contract, percent: String(percent), tag: "", is_locked: 0 }));
const share = top10Share(mdog, [pm.toLowerCase()]);
check(Math.abs(share - 34.7) < 0.1, `$MDOG: contract wallets count, the pool manager doesn't (${share}%, chiefofstaff re-walked 34.1%)`);
check(top10Share(mdog, []) > 45, "without the pool list the pool manager would count");
check(top10Share([{ address: "0x000000000000000000000000000000000000dEaD", percent: "0.5" }, { address: "0x" + "1".repeat(40), percent: "0.1" }]) === 10, "burned supply is not a holder");
check(top10Share([{ address: "0x" + "2".repeat(40), percent: "0.4", is_locked: 1 }, { address: "0x" + "3".repeat(40), percent: "0.3", tag: "UniswapV2 pair" }, { address: "0x" + "4".repeat(40), percent: "0.05" }]) === 5, "locked and pool-tagged holders are left out");

const locker = "0x267444D099b10fB5Ed7c3Cc7B7c767AdcA574952".toLowerCase();
const noLock = top10Share(mdog, [pm.toLowerCase(), locker]);
check(Math.abs(noLock - 26.5) < 0.1, `$MDOG without the PonsV2LaunchLocker (8.2%) reads ${noLock}%, under the 30% flag`);
// classifying holders by their code and verified name
check(holderKind(codeKind("0x")) === "wallet", "no code: a plain wallet");
check(holderKind(codeKind("0xef0100e6cae83bde06e4c305530e199d7217f42808555b")) === "smart wallet (7702)", "a 7702 delegation: a smart wallet (0xFcDE)");
check(holderKind(codeKind("0x6080"), "GnosisSafeProxy").startsWith("multisig"), "a Safe proxy: multisig");
check(holderKind(codeKind("0x6080"), "TokenVesting").startsWith("lock or vesting"), "a vesting contract: lock or vesting");
check(holderKind(codeKind("0x6080"), "RelayRouterV3").startsWith("pool or router"), "a router: pool or router");
// permanent vs releasable locks, from the verified source (Turbo's bucket, #lobby 77392)
const pons = "contract PonsV2LaunchLocker { function setFactory(address f) external {} function lockPosition(uint id) external {} function lockTokenSupply(uint a) external {} function isLocked(uint id) view returns (bool) {} }";
check(holderKind(codeKind("0x6080"), "PonsV2LaunchLocker", pons).startsWith("permanent lock"), "a locker with no release function: permanent lock");
check(holderKind(codeKind("0x6080"), "TokenVesting", "contract TokenVesting { function release(address t) public {} }").includes("releasable: release"), "a vesting contract with release(): releasable, and says which function");
check(holderKind(codeKind("0x6080"), "TeamLock").startsWith("lock or vesting"), "no source in hand: plain lock, no claim either way");
const withIface = pons + " interface ILaunchpadV2 { function claim() external returns (uint256 amount); function claimToken(address token) external returns (uint256); function sweepFees(uint256 minOut) external; }";
check(holderKind(codeKind("0x6080"), "PonsV2LaunchLocker", withIface).startsWith("permanent lock"), "functions only declared in a bundled interface don't make a lock releasable");
check(holderKind(codeKind("0x6080"), "Treasury", "contract Treasury {\n  function withdraw(\n    uint256 amount\n  ) external onlyOwner {\n    token.transfer(msg.sender, amount);\n  }\n}").startsWith("contract"), "a non-lock name stays a plain contract");
check(holderKind(codeKind("0x6080"), "TeamLock", "contract TeamLock {\n  function withdraw(\n    uint256 amount\n  ) external onlyOwner {\n  }\n}").includes("releasable: withdraw"), "an implemented multi-line withdraw() makes a lock releasable");
check(holderKind(codeKind("0x6080")) === "contract (unverified)", "unknown code and no name: unverified contract");
console.log(bad ? `\n${bad} FAILED` : "\nall passed");
process.exit(bad ? 1 : 0);
