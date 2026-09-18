# pretrade

Check a token before you trade it. Five pay-per-call [x402](https://www.x402.org/) endpoints for trading agents, plus an always-on bot on [musebook.lol](https://musebook.lol/muse/muse_d2pa9v3lqo).

No account. No API key. Pay per call in USDC on Base. Invalid requests and upstream outages return 4xx/5xx and are **never charged**.

## Endpoints

Base URL: `https://x402.bankr.bot/0xf4a46667d75fa9663ab7a297af20d3623aaa8b52`

| Endpoint | Price | What you get |
|---|---|---|
| `GET /token-check?address=…` | $0.01 | Verdict (`OK` / `CAUTION` / `DANGER`), 0-100 risk score, ranked flags, taxes, holders, market snapshot, max sell sizes |
| `GET /exit-check?address=…&usd=500` | $0.01 | Can you get out? Estimated price impact, sell tax, total exit cost and proceeds for your size, plus the largest sell under 1 / 2 / 5% impact |
| `GET /momentum?address=…` | $0.005 | Signal (`STRONG_UP` … `STRONG_DOWN`), buy/sell flow, volume acceleration, manipulation warnings |
| `GET or POST /batch-check` | $0.05 | Up to 10 tokens ranked safest first |
| `GET /twin-check?symbol=TICKER` | $0.03 | Every token using that ticker, ranked by market evidence, with the likely original. Pass `&address=` to learn if yours is a likely copycat |

**Chains:** Base (default), Solana (auto-detected from the address), Robinhood Chain, Ethereum, BSC, Arbitrum, Optimism, Polygon.

```bash
bankr x402 call "https://x402.bankr.bot/0xf4a46667d75fa9663ab7a297af20d3623aaa8b52/token-check?address=0x4200000000000000000000000000000000000006" --max-payment 0.02
```

### What is checked

- **EVM:** honeypot simulation, buy/sell tax, owner privileges (mint, pause, blacklist, tax changes, balance edits, reclaimable ownership), proxy, self-destruct, creator honeypot history, holder concentration, LP lock, liquidity, pair age.
- **Solana:** mint and freeze authority, mutable balances, non-transferable or default-frozen accounts, transfer fees and hooks, flagged creators, RugCheck danger flags, holder concentration.
- A new pair with thin liquidity reads `CAUTION`, not `DANGER`. `DANGER` needs a critical contract flag or a score of 60+.

Sources: GoPlus, DexScreener, RugCheck. The value added here is one call, one normalized verdict, exit sizing, and a public track record.

## The bot on musebook

Write in any thread:

| Command | Cost | Result |
|---|---|---|
| `@pretrade <token address>` | free | Verdict, risk score, flags, biggest sell for ~2% impact. Replies within about a minute, around the clock |
| `@pretrade record` | free | The bot's hit rate. See below |
| `@pretrade price` | free | Menu, current prices, how to pay |
| `@pretrade deep <token> <payment tx>` | ~$0.25 in $PTRD | Safety + exit sizes + momentum + copycat scan + holder spread + an analyst note that answers your question about the token |
| `@pretrade watch <token> <payment tx>` | ~$0.50 in $PTRD | 24h watch. Pings you if liquidity drops 30%+, the verdict worsens or a critical flag appears |

Payments are verified on-chain (right token, right recipient, enough value, under 24h old, each tx usable once).

## Track record

Every verdict the bot gives, free or paid, is logged and scored 24 hours later: what happened to liquidity and price, and did the token collapse (liquidity −80% or price −90%). Nothing is ever removed. Hit rates are published once 10+ reads are scored, not before.

A checker is only worth paying for if its `DANGER` calls collapse far more often than its `OK` calls. Judge this one on that gap. The raw ledger lives in [`bot/.state.json`](bot/.state.json).

## Disclosures

- **$PTRD** (`0x2DC2614F99139C1342ACc585515d6862a854fBa3`, Robinhood Chain) is this bot's own token. It pays for deep reports and watches, and nothing else. No promises about price. The bot never rates, watches or comments on its own token.
- The analyst note is written by an LLM that only sees computed numbers. It cannot change a verdict, predict price or recommend buying or selling.
- Everything here is automated heuristics over public data. **Not financial advice. `OK` is never a guarantee.**

## Repo layout

| Path | What |
|---|---|
| `x402/*/index.ts` | The five endpoint handlers (self-contained, deployed to Bankr x402 Cloud) |
| `bankr.x402.json` | Prices, schemas and discovery metadata |
| `bot/musebot.mjs` | The musebook bot. Zero dependencies |
| `.github/workflows/live.yml` | Always-on runner |
| `skill/pretrade/SKILL.md` | Agent skill: when and how to call the endpoints |
| `test/` | Offline tests (`npm test`) and a live test against the real data sources |
