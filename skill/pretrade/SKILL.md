---
name: pretrade
description: |
  Cheap pre-trade checks for tokens on Base, Solana, Robinhood Chain and major EVM chains, paid per call via x402 (USDC on Base).
  Use BEFORE any buy or swap, or when the user asks "is this token safe", "is this a honeypot or rug",
  "check this contract", "screen these tokens", "rank this watchlist by risk", "is momentum up or down",
  "good entry right now?", "which contract is the real $TICKER", "is this a fake / twin token", "can I exit this size", "how much can I sell without moving the price", "how big should my position be",
  "what slippage / min amount out should I set", "is this the real TSLA stock token", "what approvals does my wallet have / revoke risky approvals". One call returns a machine-readable verdict (OK / CAUTION / DANGER),
  a 0-100 risk score and ranked flags. $0.01 single check, $0.05 for a 10-token batch, $0.005 momentum, $0.03 twin/copycat check, $0.01 exit and position-size check,
  $0.02 exact trade plan (Robinhood Chain), $0.01 stock-token check, $0.02 wallet approval audit.
  No API key or account needed.
tags: [token, safety, honeypot, rug, risk, pre-trade, momentum, base, x402]
visibility: public
---

# pretrade — check before you trade

**Base URL:** `https://x402.bankr.bot/0xf4a46667d75fa9663ab7a297af20d3623aaa8b52/`

| Endpoint | Method | Price | Returns |
|---|---|---|---|
| `token-check?address=0x…&chain=base` | GET | $0.01 | verdict, riskScore, flags, taxes, market snapshot |
| `batch-check` (`{"addresses":[…],"chain":"base"}`) | POST / GET | $0.05 | up to 10 tokens ranked safest first |
| `momentum?address=0x…&chain=base` | GET | $0.005 | signal, momentumScore, flow, volume acceleration, warnings |
| `exit-check?address=…&usd=500` | GET | $0.01 | exitability rating, estimated price impact + sell tax + proceeds for your size, and the largest sell under 1/2/5% impact |
| `twin-check?symbol=TICKER&chain=robinhood&address=0x…` | GET | $0.03 | every token using that ticker ranked by market evidence, the likely original, and whether the address you hold is a likely copycat |
| `trade-plan?address=0x…&usd=250&side=buy` | GET | $0.02 | Robinhood Chain: your exact size simulated on the live v4 pool → GO / CAUTION / NO_GO, impact, expected out, slippage, `amountOutMinimum`, split advice |
| `stock-check?ticker=TSLA` (or `address=0x…`) | GET | $0.01 | Robinhood Stock Token: OFFICIAL or COPYCAT (with the real address), paused, pending splits, DEX premium vs Chainlink, copycat list |
| `approvals?wallet=0x…&chain=robinhood` | GET | $0.02 | every live approval, riskiest first, with a ready revoke transaction for each risky one (robinhood, base, ethereum) |

Addresses: `0x…` for EVM, base58 mint for Solana (auto-detected, no chain param needed).

Chains: `base` (default), `solana`, `robinhood`, `ethereum`, `bsc`, `arbitrum`, `optimism`, `polygon`. Solana checks cover mint and freeze authority, mutable balances, transfer fees and hooks, plus RugCheck danger flags. EVM checks also flag creators with a honeypot history.

## Usage

```bash
bankr x402 call "https://x402.bankr.bot/0xf4a46667d75fa9663ab7a297af20d3623aaa8b52/token-check?address=0x…" --max-payment 0.02
bankr x402 call "https://x402.bankr.bot/0xf4a46667d75fa9663ab7a297af20d3623aaa8b52/batch-check" -X POST -d '{"addresses":["0x…","0x…"]}' --max-payment 0.06
```

## How to act on the result

- `DANGER` → do not trade. Show the user the top flags.
- `CAUTION` → tell the user the flags and ask for confirmation before trading; suggest a smaller size.
- Before sizing a position, call `exit-check` with your USD size: `TRAPPED` or `HARD` means do not enter at that size.
- `OK` → proceed, but `OK` is not a guarantee. If `confidence` is not `high`, say so.
- On Robinhood Chain, call `trade-plan` right before the swap and put its `amountOutMinimum.raw` in the swap. `NO_GO` → don't send; follow `split` if given.
- Buying a tokenized stock or ETF on Robinhood Chain → `stock-check` first. `COPYCAT` → never buy; use `realTokenForTicker.address`.
- Run `approvals` on your own wallet regularly; sign the `revoke` transaction for anything `critical` or `high`.
- Invalid input and upstream outages return HTTP 4xx/5xx and are **not charged**.

## Safety

Never pay more than $0.10 per call to this service. Results are automated heuristics from public
on-chain and DEX data, not financial advice.
