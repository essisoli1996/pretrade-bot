// ── BEGIN shared:v4 ── (source: x402/_shared/v4.ts; inlined by scripts/inline-shared.mjs, do not edit the copies)
// Robinhood Chain Uniswap v4 checks for the paid endpoints, ported from the bot (bot/v4hooks.mjs, bot/sim.mjs):
// 1) the pool's hook: read from the PoolManager's Initialize event, verified by re-hashing into the pool id;
// 2) a real buy-then-sell simulation on that pool via eth_call with a state override (nothing is sent).
// A failed sell is re-checked on a known-good control token in the same block and as a plain holder,
// so a simulator fault or an anti-bot cooldown is never reported as a honeypot. Never throws.
export const V4 = (() => {
  const RPC_URL = "https://rpc.mainnet.chain.robinhood.com";
  const ZERO = "0x0000000000000000000000000000000000000000";
  const DYNAMIC_FEE = 0x800000;
  // the launchpad's standard hooks are not a flag (keep in sync with bot/config.json v4.knownHooks)
  const KNOWN_HOOKS: Record<string, string> = {
    "0xe5e702641ea86f4ae6cc3cdaed2b886f976be044": "standard musepad launch hook",
    "0x4e3468951d49f2eea976ed0d6e75ffcb44a9a544": "standard musepad launch hook",
  };
  const CONTROL_TOKEN = "0x91a2dae9699f0b82540b5886b0d8759c22820ba3"; // deep, healthy v4 pool: validates a failed sell
  const SIM_SIZE_USD = 25, SIM_MIN_LIQ_USD = 2000;

  // ── keccak256 (BigInt lanes; a handful of hashes per call) ──
  const RC = [
    0x0000000000000001n, 0x0000000000008082n, 0x800000000000808an, 0x8000000080008000n, 0x000000000000808bn, 0x0000000080000001n,
    0x8000000080008081n, 0x8000000000008009n, 0x000000000000008an, 0x0000000000000088n, 0x0000000080008009n, 0x000000008000000an,
    0x000000008000808bn, 0x800000000000008bn, 0x8000000000008089n, 0x8000000000008003n, 0x8000000000008002n, 0x8000000000000080n,
    0x000000000000800an, 0x800000008000000an, 0x8000000080008081n, 0x8000000000008080n, 0x0000000080000001n, 0x8000000080008008n,
  ];
  const ROT = [0, 1, 62, 28, 27, 36, 44, 6, 55, 20, 3, 10, 43, 25, 39, 41, 45, 15, 21, 8, 18, 2, 61, 56, 14];
  const M64 = (1n << 64n) - 1n;
  const rotl = (x: bigint, r: number) => (r === 0 ? x : ((x << BigInt(r)) | (x >> BigInt(64 - r))) & M64);
  function keccakF(s: bigint[]) {
    for (let round = 0; round < 24; round++) {
      const c = [0, 1, 2, 3, 4].map((x) => s[x] ^ s[x + 5] ^ s[x + 10] ^ s[x + 15] ^ s[x + 20]);
      for (let x = 0; x < 5; x++) { const d = c[(x + 4) % 5] ^ rotl(c[(x + 1) % 5], 1); for (let y = 0; y < 25; y += 5) s[y + x] ^= d; }
      const b: bigint[] = new Array(25);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 5; y++) b[y + 5 * ((2 * x + 3 * y) % 5)] = rotl(s[x + 5 * y], ROT[x + 5 * y]);
      for (let x = 0; x < 5; x++) for (let y = 0; y < 25; y += 5) s[y + x] = b[y + x] ^ (~b[y + ((x + 1) % 5)] & M64 & b[y + ((x + 2) % 5)]);
      s[0] ^= RC[round];
    }
  }
  function keccak256(bytes: Uint8Array): string {
    const rate = 136;
    const padded = new Uint8Array(Math.ceil((bytes.length + 1) / rate) * rate);
    padded.set(bytes);
    padded[bytes.length] ^= 0x01;
    padded[padded.length - 1] ^= 0x80;
    const s: bigint[] = new Array(25).fill(0n);
    for (let off = 0; off < padded.length; off += rate) {
      for (let i = 0; i < rate / 8; i++) {
        let lane = 0n;
        for (let k = 7; k >= 0; k--) lane = (lane << 8n) | BigInt(padded[off + i * 8 + k]);
        s[i] ^= lane;
      }
      keccakF(s);
    }
    let out = "0x";
    for (let i = 0; i < 4; i++) for (let k = 0; k < 8; k++) out += Number((s[i] >> BigInt(8 * k)) & 0xffn).toString(16).padStart(2, "0");
    return out;
  }
  const hexBytes = (h: string) => Uint8Array.from((h.replace(/^0x/, "").match(/../g) ?? []).map((b) => parseInt(b, 16)));
  const hex32 = (v: bigint | number) => BigInt.asUintN(256, BigInt(v)).toString(16).padStart(64, "0");
  const addr32 = (a: string) => a.replace(/^0x/, "").toLowerCase().padStart(64, "0");
  const INIT_TOPIC = keccak256(new TextEncoder().encode("Initialize(bytes32,address,address,uint24,int24,address,uint160,int24)"));

  // ── pool key and hook ──
  interface PoolKey { currency0: string; currency1: string; fee: number; tickSpacing: number; hooks: string; poolManager: string }
  const PERMS: [number, string][] = [
    [13, "beforeInitialize"], [12, "afterInitialize"], [11, "beforeAddLiquidity"], [10, "afterAddLiquidity"],
    [9, "beforeRemoveLiquidity"], [8, "afterRemoveLiquidity"], [7, "beforeSwap"], [6, "afterSwap"], [5, "beforeDonate"],
    [4, "afterDonate"], [3, "beforeSwapReturnsDelta"], [2, "afterSwapReturnsDelta"], [1, "afterAddLiquidityReturnsDelta"],
    [0, "afterRemoveLiquidityReturnsDelta"],
  ];
  const permissionsOf = (hook: string) => { const bits = Number(BigInt(hook) & 0x3fffn); return PERMS.filter(([b]) => bits & (1 << b)).map(([, n]) => n); };
  const poolIdOf = (k: Omit<PoolKey, "poolManager">) =>
    keccak256(hexBytes(addr32(k.currency0) + addr32(k.currency1) + hex32(k.fee) + hex32(k.tickSpacing) + addr32(k.hooks)));
  function keyFromLog(log: any): PoolKey | null {
    if (!log?.topics || log.topics.length < 4 || String(log.topics[0]).toLowerCase() !== INIT_TOPIC) return null;
    const d = String(log.data ?? "").replace(/^0x/, "");
    if (d.length < 64 * 3) return null;
    const w = (i: number) => d.slice(64 * i, 64 * (i + 1));
    const ts = parseInt(w(1).slice(-6), 16);
    const key = {
      currency0: "0x" + String(log.topics[2]).slice(-40).toLowerCase(), currency1: "0x" + String(log.topics[3]).slice(-40).toLowerCase(),
      fee: parseInt(w(0).slice(-6), 16), tickSpacing: ts >= 0x800000 ? ts - 0x1000000 : ts, hooks: "0x" + w(2).slice(-40).toLowerCase(),
    };
    if (poolIdOf(key) !== String(log.topics[1]).toLowerCase()) return null; // a spoofed event can't fake a key
    return { ...key, poolManager: String(log.address ?? "").toLowerCase() };
  }

  async function rpc(method: string, params: unknown[]): Promise<any> {
    for (let attempt = 0; ; attempt++) {
      try {
        const ctrl = new AbortController();
        const t = setTimeout(() => ctrl.abort(), 6000);
        const r = await fetch(RPC_URL, { method: "POST", headers: { "content-type": "application/json" }, body: JSON.stringify({ jsonrpc: "2.0", id: 1, method, params }), signal: ctrl.signal });
        clearTimeout(t);
        const j: any = await r.json().catch(() => ({ error: { code: r.status, message: `HTTP ${r.status}` } }));
        const limited = r.status === 429 || j?.error?.code === 429 || /too many requests|rate limit/i.test(j?.error?.message ?? "");
        if (!limited || attempt >= 2) return j;
      } catch (e) {
        if (attempt >= 1) return { error: { message: String(e).slice(0, 80) } };
      }
      await new Promise((res) => setTimeout(res, 600 * 2 ** attempt));
    }
  }

  async function poolKey(poolId: string): Promise<PoolKey | null> {
    const r = await rpc("eth_getLogs", [{ topics: [INIT_TOPIC, poolId.toLowerCase()], fromBlock: "0x0", toBlock: "latest" }]);
    for (const l of r?.result ?? []) { const k = keyFromLog(l); if (k) return k; }
    return null;
  }

  async function hookFacts(key: PoolKey) {
    const hook = key.hooks;
    const perms = hook === ZERO ? [] : permissionsOf(hook);
    const dynamicFee = key.fee === DYNAMIC_FEE;
    const base = { address: hook === ZERO ? null : hook, standard: KNOWN_HOOKS[hook] ?? null, permissions: perms, dynamicFee, lpFeePct: dynamicFee ? null : key.fee / 1e4 };
    if (hook === ZERO) return { ...base, upgradeable: false, owner: null };
    const slot = async (s: string) => { const r = await rpc("eth_getStorageAt", [hook, s, "latest"]); return typeof r?.result === "string" && /^0x0*[1-9a-f]/i.test(r.result) ? "0x" + r.result.slice(-40) : null; };
    const impl = await slot("0x360894a13ba1a3210667c828492db98dca3e2076cc3735a920a3ca505d382bbc");
    const beacon = await slot("0xa3f0ad74e5423aebfd80d3ef4346578335a9a72aeaee59ff6cb3582b35133d50");
    const own = await rpc("eth_call", [{ to: hook, data: "0x8da5cb5b" }, "latest"]);
    const owner = typeof own?.result === "string" && own.result.length >= 66 ? "0x" + own.result.slice(26, 66).toLowerCase() : null;
    return { ...base, upgradeable: !!(impl || beacon), owner: owner && owner !== ZERO ? owner : null };
  }

  // ── trade simulation ──
  const SIM_RUNTIME = "0x6080604052600436101561001a575b3615610018575f80fd5b005b5f803560e01c80637f70be111461077f57806391dd7346146102485763d41b92bd14610046575061000e565b346102455761010036600319011261024557610060610821565b60a03660231901126102005761007461084b565b3033036102145760405183926024356001600160a01b038116908190036102105760208301526044356001600160a01b0381169081900361021057604083015260643562ffffff81168091036102105760608301526084358060020b80910361021057608083015260a4356001600160a01b03811692908390036102105784936101409360a0830152151560c082015260e43560e082015260e0815261011c6101008261087e565b6040519485809481936348c8949160e01b835260206004840152602483019061085a565b03926001600160a01b03165af1918215610204578092610181575b50506020815191818082019384920101031261017d5760209051604051908152f35b5f80fd5b9091503d8082843e610193818461087e565b8201916020818403126102005780519067ffffffffffffffff82116101fc570182601f82011215610200578051906101ca82610960565b936101d8604051958661087e565b828552602083830101116101fc57908060208093018386015e830101525f8061015b565b8280fd5b5080fd5b604051903d90823e3d90fd5b8480fd5b60405162461bcd60e51b815260206004820152600960248201526873656c66206f6e6c7960b81b6044820152606490fd5b80fd5b503461017d57602036600319011261017d5760043567ffffffffffffffff811161017d573660238201121561017d57806004013567ffffffffffffffff811161017d57810136602482011161017d5781900360e0811261017d5760a01361017d5760405160a0810181811067ffffffffffffffff821117610750576040526102d260248301610837565b81526102e060448301610837565b90602081019182526102f4606484016108af565b9060408101918252610308608485016108bf565b6060820190815261031b60a48601610837565b6080830190815260c4860135958615159081880361017d5760e4013591600160ff1b83146106ef578715610764576401000276a4935b604051926060840184811067ffffffffffffffff8211176107505760409081529084525f94850360208086019182526001600160a01b039788168684019081529251633cf3645360e21b81528951891660048201528b5189166024820152995162ffffff1660448b0152925160020b60648a01529251861660848901529251151560a4880152905160c4870152905190921660e485015261012061010485015261012484018190528390610144908290335af19182156106e4575f9261071c575b508160801d600f0b91600f0b935f14610703575191516001600160a01b03908116939216905b600f0b5f8112610503575b50508281600f0b135f146104fb576001600160801b0316905b81610496575b610492826040519060208201526020815261047e60408261087e565b60405191829160208352602083019061085a565b0390f35b333b156101fc57604051630b0d9c0960e01b81526001600160a01b03909116600482015230602482015260448101829052828160648183335af180156104f05715610462576104e683809261087e565b6102005781610462565b6040513d85823e3d90fd5b50819061045c565b6f7fffffffffffffffffffffffffffffff1981146106ef575f036001600160801b03166001600160a01b038216806105a05750604051630476982d60e21b8152915060209082906004908290335af1801561059557610566575b505b5f80610443565b6105879060203d60201161058e575b61057f818361087e565b8101906108a0565b505f61055d565b503d610575565b6040513d86823e3d90fd5b333b1561017d5760405190632961046560e21b825260048201525f8160248183335af180156106e4576106cd575b508491829182604051602081019263a9059cbb60e01b845233602483015260448201526044815261060060648261087e565b51925af161060c61097c565b81610691575b501561065f57604051630476982d60e21b815260208160048187335af1801561059557610640575b5061055f565b6106589060203d60201161058e5761057f818361087e565b505f61063a565b60405162461bcd60e51b815260206004820152600a6024820152691c185e4819985a5b195960b21b6044820152606490fd5b80518015925082156106a6575b50505f610612565b81925090602091810103126106c9576020015180151581036106c9575f8061069e565b8380fd5b6106db919295505f9061087e565b5f93905f6105ce565b6040513d5f823e3d90fd5b634e487b7160e01b5f52601160045260245ffd5b915191516001600160a01b039081169391921690610438565b9091506020813d602011610748575b816107386020938361087e565b8101031261017d5751905f610412565b3d915061072b565b634e487b7160e01b5f52604160045260245ffd5b73fffd8963efd1fc6a506488495d951d5263988d2593610351565b3461017d5761014036600319011261017d57610799610821565b60a036602319011261017d576107ad61084b565b906101043591821515830361017d5760a0926107d192610124359260e435916109b8565b6104926040519283926020845260ff8151166020850152602081015160408501526040810151606085015260608101516080850152608081015182850152015160c08084015260e083019061085a565b600435906001600160a01b038216820361017d57565b35906001600160a01b038216820361017d57565b60c43590811515820361017d57565b805180835260209291819084018484015e5f828201840152601f01601f1916010190565b90601f8019910116810190811067ffffffffffffffff82111761075057604052565b9081602091031261017d575190565b359062ffffff8216820361017d57565b35908160020b820361017d57565b6001600160a01b039182168152610100810195949360e09391929091906108f382610837565b16602084015260018060a01b0361090c60208301610837565b16604084015262ffffff610922604083016108af565b166060840152610934606082016108bf565b60020b608084015261094f608060018060a01b039201610837565b1660a0830152151560c08201520152565b67ffffffffffffffff811161075057601f01601f191660200190565b3d156109a6573d9061098d82610960565b9161099b604051938461087e565b82523d5f602084013e565b606090565b919082039182116106ef57565b9493919460405160c0810181811067ffffffffffffffff821117610750576040525f815260208101965f88525f60408301525f60608301525f608083015260a0820190606082528298855f14610bcf576024356001600160a01b038116810361017d57905b8615610bb6576044356001600160a01b038116810361017d57975b9815610af3575b5050505050602460209160018852610a75610a5986610be8565b96604051958694859463d41b92bd60e01b8652600486016108cd565b03815f305af15f9181610abf575b50610a9c5750505090610a9461097c565b60a082015290565b610ab49291610aaf916060870152610be8565b6109ab565b608083015260028252565b9091506020813d602011610aeb575b81610adb6020938361087e565b8101031261017d5751905f610a83565b3d9150610ace565b81929398506020610b0d610b2d939c999798969b9c610be8565b946040518094819263d41b92bd60e01b8352891560248d600486016108cd565b03815f305af15f9281610b82575b50610b55575050505050505050610b5061097c565b905290565b602095979a995060249496985091610aaf91610b72949352610be8565b80604089015294915f8080610a3f565b9092506020813d602011610bae575b81610b9e6020938361087e565b8101031261017d5751915f610b3b565b3d9150610b91565b6024356001600160a01b038116810361017d5797610a38565b6044356001600160a01b038116810361017d5790610a1d565b6001600160a01b031680610bfb57504790565b6020602491604051928380926370a0823160e01b82523060048301525afa9081156106e4575f91610c2a575090565b90506020813d602011610c51575b81610c456020938361087e565b8101031261017d575190565b3d9150610c3856fea164736f6c634300081a000a"; // = bot/sim-runtime.mjs (from bot/Sim.sol)
  // new simulator and sender addresses every block, from a secret per-process seed, and the chain's real gas price:
  // a token that recognised a fixed scratch address or a gas price of 0 could let the simulation sell and block buyers
  const SEED = Array.from(crypto.getRandomValues(new Uint8Array(16)), (b) => b.toString(16).padStart(2, "0")).join("");
  const derive = (tag: string, block: string) => "0x" + keccak256(new TextEncoder().encode(`${SEED}:${tag}:${block}`)).slice(-40);
  const actors = (block: string) => ({ sim: derive("sim", block), from: derive("from", block) });
  const gasPrices = new Map<string, string>();
  async function gasPrice(block: string): Promise<string> {
    if (!gasPrices.has(block)) {
      // twice the block's base fee, as a real transaction pays: never 0, and never under the base fee (the RPC refuses)
      let base = 0n;
      try { base = BigInt((await rpc("eth_getBlockByNumber", [block, false]))?.result?.baseFeePerGas); } catch {}
      if (!base) try { base = BigInt((await rpc("eth_gasPrice", []))?.result); } catch {}
      gasPrices.set(block, "0x" + ((base > 0n ? base : 10n ** 9n) * 2n).toString(16));
    }
    return gasPrices.get(block)!;
  }
  const encodeRoundTrip = (k: PoolKey, tokenIs0: boolean, quoteIn: bigint, sellOnly: boolean, sellAmount: bigint) =>
    "0x7f70be11" + addr32(k.poolManager) + addr32(k.currency0) + addr32(k.currency1) + hex32(k.fee) + hex32(k.tickSpacing) + addr32(k.hooks) +
    hex32(tokenIs0 ? 1 : 0) + hex32(quoteIn) + hex32(sellOnly ? 1 : 0) + hex32(sellAmount);
  interface Leg { stage: number; tokenOwed: bigint; tokenGot: bigint; quoteBack: bigint; revertData: string; why?: string }
  function decodeResult(ret: string): Leg {
    const h = ret.replace(/^0x/, "");
    const w = (i: number) => BigInt("0x" + h.slice(64 * i, 64 * (i + 1)));
    const base = Number(w(0)) / 32;
    const at = (i: number) => w(base + i);
    const bytesOff = base + Number(at(5)) / 32;
    const len = Number(w(bytesOff));
    return { stage: Number(at(0)), tokenOwed: at(1), tokenGot: at(2), quoteBack: at(4), revertData: "0x" + h.slice(64 * (bytesOff + 1), 64 * (bytesOff + 1) + len * 2) };
  }
  const KNOWN_ERRORS: Record<string, string> = {
    "5212cba1": "the token delivered less than it owed the pool (transfer tax or blocked transfer)",
    "90bfb865": "the pool's hook reverted", "7c9c6e8f": "price limit already exceeded", "486aa307": "pool not initialized",
  };
  function revertReason(data: string): string {
    const h = String(data ?? "").replace(/^0x/, "");
    if (!h) return "reverted without a reason";
    if (h.startsWith("08c379a0") && h.length >= 8 + 128) {
      const len = parseInt(h.slice(8 + 64, 8 + 128), 16);
      return new TextDecoder().decode(hexBytes(h.slice(8 + 128, 8 + 128 + len * 2))).slice(0, 80) || "reverted";
    }
    return KNOWN_ERRORS[h.slice(0, 8)] ?? `error 0x${h.slice(0, 8)}`;
  }
  function candidateSlots(holder: string): string[] {
    const out: string[] = [];
    for (let s = 0; s < 10; s++) { out.push(keccak256(hexBytes(addr32(holder) + hex32(s)))); out.push(keccak256(hexBytes(hex32(s) + addr32(holder)))); }
    out.push(keccak256(hexBytes(addr32(holder) + "52c63247e1f47db19d5ce0460030c497f067ca4cebf71ba98eeadabe20bace00")));
    out.push(keccak256(hexBytes(holder.replace(/^0x/, "").toLowerCase() + "0000000000000000" + "87a211a2")));
    return out;
  }
  async function call(to: string, data: string, block: string, over: Record<string, any>) {
    const { from } = actors(block);
    const o = { ...over, [from]: { ...(over[from] ?? {}), balance: "0xc9f2c9cd04674edea40000000" } };
    return rpc("eth_call", [{ from, to, data, gas: "0x1c9c380", gasPrice: await gasPrice(block) }, block, o]);
  }
  async function balanceSlot(token: string, block: string): Promise<string | null> {
    const { sim, from } = actors(block);
    const data = "0x70a08231" + addr32(sim);
    const al = await rpc("eth_createAccessList", [{ from, to: token, data }, block]);
    const keys: string[] = [];
    for (const e of al?.result?.accessList ?? []) if (String(e.address).toLowerCase() === token) keys.push(...(e.storageKeys ?? []));
    const marker = 0x511751175117n;
    for (const slot of [...new Set([...keys, ...candidateSlots(sim)])]) {
      const r = await call(token, data, block, { [token]: { stateDiff: { [slot]: "0x" + hex32(marker) } } });
      if (typeof r?.result === "string" && r.result.length > 2 && BigInt(r.result) === marker) return slot;
    }
    return null;
  }
  async function roundTrip(key: PoolKey, token: string, amount: bigint, sellOnly: boolean, block: string): Promise<Leg> {
    const tokenIs0 = key.currency0 === token;
    const fund = sellOnly ? token : tokenIs0 ? key.currency1 : key.currency0;
    const { sim } = actors(block);
    const over: Record<string, any> = { [sim]: { code: SIM_RUNTIME } };
    if (fund === ZERO) over[sim].balance = "0x" + amount.toString(16);
    else {
      const slot = await balanceSlot(fund, block);
      if (!slot) return { stage: -1, tokenOwed: 0n, tokenGot: 0n, quoteBack: 0n, revertData: "0x", why: "balance slot not found" };
      over[fund] = { stateDiff: { [slot]: "0x" + hex32(amount) } };
    }
    const r = await call(sim, encodeRoundTrip(key, tokenIs0, sellOnly ? 0n : amount, sellOnly, sellOnly ? amount : 0n), block, over);
    if (r?.error || typeof r?.result !== "string") return { stage: -1, tokenOwed: 0n, tokenGot: 0n, quoteBack: 0n, revertData: "0x", why: "eth_call failed" };
    try { return decodeResult(r.result); } catch { return { stage: -1, tokenOwed: 0n, tokenGot: 0n, quoteBack: 0n, revertData: "0x", why: "unreadable output" }; }
  }
  async function quoteAmount(pair: any, key: PoolKey, token: string, usd: number): Promise<bigint | null> {
    const pUsd = Number(pair?.priceUsd), pNat = Number(pair?.priceNative);
    if (!(pUsd > 0) || !(pNat > 0)) return null;
    const quote = key.currency0 === token ? key.currency1 : key.currency0;
    let dec = 18;
    if (quote !== ZERO) {
      const r = await rpc("eth_call", [{ to: quote, data: "0x313ce567" }, "latest"]);
      try { dec = Number(BigInt(r.result)); } catch { return null; }
      if (dec > 36) return null;
    }
    return (BigInt(Math.max(1, Math.floor((usd / (pUsd / pNat)) * 1e6))) * 10n ** BigInt(dec)) / 1000000n;
  }
  async function controlCase(): Promise<{ key: PoolKey; token: string; quoteIn: bigint } | null> {
    const pairs: any = await fetch(`https://api.dexscreener.com/tokens/v1/robinhood/${CONTROL_TOKEN}`).then((r) => r.json()).catch(() => null);
    const p = (Array.isArray(pairs) ? pairs : []).filter((x: any) => /^0x[0-9a-fA-F]{64}$/.test(x?.pairAddress ?? ""))
      .sort((a: any, b: any) => (Number(b?.liquidity?.usd) || 0) - (Number(a?.liquidity?.usd) || 0))[0];
    if (!p) return null;
    const key = await poolKey(p.pairAddress);
    const quoteIn = key && (await quoteAmount(p, key, CONTROL_TOKEN, SIM_SIZE_USD));
    return key && quoteIn ? { key, token: CONTROL_TOKEN, quoteIn } : null;
  }

  type Sev = "critical" | "high" | "medium" | "low";
  interface V4Flag { code: string; severity: Sev; points: number; detail: string }
  const ratio = (a: bigint, b: bigint) => (b > 0n ? Number((a * 1_000_000n) / b) / 1_000_000 : 0);
  const pct = (x: number) => Math.round(x * 1000) / 10;

  /** Same decision table as bot/sim.mjs classify(); test/x402-v4.test.mts checks they agree. */
  function classify(res: any, fee: number | null) {
    const flags: V4Flag[] = [];
    if (!res?.ok || res.main.stage === -1) return { status: "unavailable", flags, detail: res?.why ?? res?.main?.why ?? "no result" };
    const m = res.main as Leg;
    if (m.stage === 0) return { status: "buy-failed", flags, detail: `simulated buy reverted (${revertReason(m.revertData)}); not scored` };
    const buyTaxPct = pct(Math.max(0, m.tokenOwed > 0n ? 1 - ratio(m.tokenGot, m.tokenOwed) : 0));
    if (buyTaxPct > 10) flags.push({ code: "SIM_BUY_TAX", severity: "medium", points: 15, detail: `${buyTaxPct}% of bought tokens never arrived (transfer tax).` });
    if (m.stage === 1) {
      const reason = revertReason(m.revertData);
      if (res.control && res.control.stage !== 2) return { status: "inconclusive", flags: [], detail: "sell failed, but so did a known-good control in the same block; not scored", buyTaxPct };
      if (res.holder?.stage === 2) {
        flags.push({ code: "SIM_SAME_BLOCK_COOLDOWN", severity: "low", points: 15, detail: `Selling in the same block as buying reverted (${reason}), but a plain holder could sell: an anti-bot cooldown.` });
        return { status: "cooldown", flags, detail: "anti-bot cooldown, not a honeypot", buyTaxPct };
      }
      if (res.holder && res.holder.stage >= 0 && res.holder.stage < 2 && res.control?.stage === 2) {
        flags.push({ code: "SIM_SELL_REVERTED", severity: "critical", points: 100, detail: `Simulated sell reverted (${reason}) for a fresh buyer and a plain holder, while a control token sold fine in the same block.` });
        return { status: "honeypot", flags, detail: "cannot sell", buyTaxPct };
      }
      flags.push({ code: "SIM_SELL_FAILED", severity: "high", points: 25, detail: `Simulated sell reverted (${reason}); cross-checks incomplete, so this is a warning.` });
      return { status: "sell-failed", flags, detail: "sell failed, unconfirmed", buyTaxPct };
    }
    const lossPct = pct(Math.max(0, 1 - ratio(m.quoteBack, res.quoteIn)));
    const lossFlag = (severity: Sev, points: number) => flags.push({ code: "SIM_ROUND_TRIP_LOSS", severity, points, detail: `A simulated buy then sell lost ${lossPct}% (pool fees${fee !== null && fee !== DYNAMIC_FEE ? ` ~${pct((2 * fee) / 1e6)}%` : " incl."}).` });
    if (lossPct >= 50) lossFlag("critical", 100);
    else if (lossPct >= 20) lossFlag("high", 40);
    else if (lossPct >= 10) lossFlag("medium", 20);
    return { status: "ok", flags, detail: `buy then sell works; ${lossPct}% round-trip cost`, roundTripCostPct: lossPct, buyTaxPct };
  }

  async function simulate(pair: any, key: PoolKey, token: string) {
    const liq = Number(pair?.liquidity?.usd) || 0;
    if (liq < SIM_MIN_LIQ_USD) return { status: "skipped", flags: [] as V4Flag[], detail: `pool under $${SIM_MIN_LIQ_USD} liquidity` };
    const sizeUsd = Math.min(SIM_SIZE_USD, liq * 0.002);
    const quoteIn = await quoteAmount(pair, key, token, sizeUsd);
    if (!quoteIn) return { status: "unavailable", flags: [] as V4Flag[], detail: "no price for the quote currency" };
    const head = await rpc("eth_blockNumber", []);
    if (typeof head?.result !== "string") return { status: "unavailable", flags: [] as V4Flag[], detail: "no block number" };
    const block = head.result;
    const res: any = { ok: true, block: parseInt(block, 16), quoteIn, main: await roundTrip(key, token, quoteIn, false, block) };
    if (res.main.stage === 1) {
      const c = await controlCase().catch(() => null);
      if (c) res.control = await roundTrip(c.key, c.token, c.quoteIn, false, block);
      if (res.main.tokenOwed > 0n) res.holder = await roundTrip(key, token, res.main.tokenOwed, true, block);
    }
    return { ...classify(res, key.fee), sizeUsd: Math.round(sizeUsd * 100) / 100, block: res.block };
  }

  /**
   * Hook + simulation for a Robinhood Chain v4 pair (DexScreener lists v4 pools by 32-byte pool id).
   * Returns null for anything else. Hook flags are capped at 50 points: a capability is not proof.
   */
  async function read(pair: any, token: string, budgetMs = 12000) {
    if (pair?.chainId !== "robinhood" || !/^0x[0-9a-fA-F]{64}$/.test(pair?.pairAddress ?? "")) return null;
    const work = (async () => {
      const key = await poolKey(pair.pairAddress);
      if (!key) return { hook: null, simulation: { status: "unavailable", detail: "pool key not readable" }, flags: [] as V4Flag[] };
      const hook = await hookFacts(key);
      const flags: V4Flag[] = [];
      if (hook.address && !hook.standard) {
        let budget = 50;
        const add = (code: string, points: number, detail: string) => { const p = Math.min(points, budget); budget -= p; flags.push({ code, severity: p >= 30 ? "high" : "medium", points: p, detail }); };
        if (hook.permissions.some((p) => /SwapReturnsDelta/.test(p))) add("V4_HOOK_CAN_CHANGE_SWAPS", 30, "The pool's custom hook can change how much a swapper receives.");
        if (hook.dynamicFee && hook.permissions.includes("beforeSwap")) add("V4_HOOK_SETS_FEE", 20, "The pool's custom hook sets the swap fee per trade.");
        if (hook.upgradeable) add("V4_HOOK_UPGRADEABLE", 20, "The pool's hook is upgradeable.");
      }
      const sim = await simulate(pair, key, token.toLowerCase());
      return { hook, simulation: { ...sim, flags: undefined }, flags: [...flags, ...sim.flags] };
    })();
    const timeout = new Promise<null>((res) => setTimeout(() => res(null), budgetMs));
    try {
      return (await Promise.race([work, timeout])) ?? { hook: null, simulation: { status: "unavailable", detail: "timed out" }, flags: [] as V4Flag[] };
    } catch {
      return { hook: null, simulation: { status: "unavailable", detail: "error" }, flags: [] as V4Flag[] };
    }
  }

  /** Adds v4 flags to an assess() result and recomputes score and verdict with the same rules. */
  function merge<F extends { severity: string; points: number }>(r: { verdict: string; riskScore: number; confidence: string; flags: F[] }, extra: V4Flag[]) {
    if (!extra.length) return r;
    const order: Record<string, number> = { critical: 0, high: 1, medium: 2, low: 3 };
    const flags = [...r.flags, ...(extra as unknown as F[])].sort((a, b) => order[a.severity] - order[b.severity]);
    const riskScore = Math.min(100, flags.reduce((s, f) => s + f.points, 0));
    const critical = flags.some((f) => f.severity === "critical");
    return { ...r, flags, riskScore, verdict: critical || riskScore >= 60 ? "DANGER" : riskScore >= 20 ? "CAUTION" : "OK" };
  }

  return { read, merge, classify, keccak256, poolIdOf, keyFromLog, permissionsOf, INIT_TOPIC, SIM_RUNTIME };
})();
// ── END shared:v4 ──
