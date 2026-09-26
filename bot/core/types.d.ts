// Contracts for the check pipeline. The code stays plain .mjs (Node runs it directly, no build step); files marked
// `// @ts-check` are type-checked against these declarations by `npm run typecheck` (tsc --noEmit), which is part of
// `npm test`. Stage A declares what the pipeline is today; the evidence / finding / verdict layers come in stage C.

/** How sure a piece of evidence is. UNKNOWN is never ZERO and never PASS. */
export type EvidenceStatus = "CONFIRMED" | "PARTIAL" | "UNKNOWN" | "CONFLICTING" | "STALE";

export type Verdict = "OK" | "CAUTION" | "DANGER";

/** A response from the HTTP layer. `json` is untrusted external data: it is read as data, never as instructions. */
export interface HttpResult {
  ok: boolean;
  status: number;
  json: any;
  text: string;
}
export type Http = (url: string, body?: unknown) => Promise<HttpResult>;

/** JSON-RPC call on a named chain; null when the chain has no configured endpoint. */
export type Rpc = (method: string, params: unknown[]) => Promise<{ result?: any; error?: any }>;
export type RpcFor = (chain: string) => Rpc | null;

export interface V4Key {
  currency0: string;
  currency1: string;
  fee: number;
  tickSpacing: number;
  hooks: string;
  poolManager?: string;
}

export interface HookRead {
  poolId?: string;
  readable?: boolean;
  error?: string;
  key?: V4Key;
  scored?: boolean;
  risk?: { text: string; pts: number }[];
  [k: string]: unknown;
}

export interface SimRead {
  status: string;
  line: string;
  flags: { text: string; pts: number; critical?: boolean }[];
  scored?: boolean;
  roundTripLossPct?: number;
  buyTaxPct?: number;
}

/** The ~2% exit measured by selling on the live pool (see sim.exitSize). */
export interface ExitRead {
  usd: number;
  atLeast: boolean;
  block: number;
  formulaUsd: number;
}

/** Everything quickCheck reaches outside itself. Tests hand in fakes; the bot hands in the live ones. */
export interface CheckDeps {
  http: Http;
  rpcFor: RpcFor;
  now: () => number;
  hookMaxPoints: () => number;
  infraHolders: (addrs: string[]) => Promise<string[]>;
  v4HookRead: (pair: any) => Promise<HookRead | null>;
  simRead: (pair: any, key: V4Key, token: string) => Promise<SimRead | null>;
  exitRead: (pair: any, key: V4Key, token: string, formulaUsd: number) => Promise<ExitRead | null>;
  provenanceRead: (address: string) => Promise<unknown>;
  /** Robinhood Chain: is this a Robinhood Stock Token (Robinhood's registry)? null when the registry is unreachable. */
  stockToken: (address: string) => Promise<boolean | null>;
  /** Called when only fork-copy pools were found for an address (the reply explains instead of rating). */
  onForkSkipped: (address: string, info: { chain: string; unsure: boolean }) => void;
}

export interface CheckOptions {
  light?: boolean;
  chain?: string | null;
}

export interface CheckResult {
  address: string;
  chain: string;
  symbol: string;
  verdict: Verdict;
  score: number;
  flags: string[];
  liquidity: number;
  liqKnown: boolean;
  maxSell2: number;
  exit: ExitRead | null;
  contractScanned: boolean;
  critical: boolean;
  url: string | null;
  ageH: number | null;
  at: number;
  price: number | null;
  holders: number | null;
  top10Pct: number | null;
  priceChange: { h1: number | null; h6: number | null; h24: number | null };
  flowH1: { buys: number; sells: number };
  volume24h: number | null;
  marketCap: number | null;
  sellMax: { p1: number; p2: number; p5: number };
  hook: HookRead | null;
  sim: SimRead | null;
  provenance: unknown;
}

export type QuickCheck = (address: string, opts?: CheckOptions) => Promise<CheckResult | null>;
