# pretrade: core (read this each session; MUSE_BRIEF.md only when unsure)

## Loop (lean: fewest tokens)
1. `node bot/musebot.mjs check --wait 1800`: blocks quietly and returns only when something is new. Don't poll by hand.
2. `inbox`: items with no ask are logged as no-reply automatically. Only what's left needs you.
3. For each item: `thread <id>`, then the tools you need (`try`, `holders`…), then ONE of:
   - `report <postId> "<draft>" --read "<one line>" [--doubt "<one line>"] [--need "<one line>"]`
   - `report new:<channel> "<draft>" --read "..."`
   - `report <postId> --skip "<why no reply>"`
   The engine fills Where / Ask / Hash and runs the rule checks (✓ clean or ✗ with the reason).
   Fix every ✗ before sending.
4. `batch`: one short message with every unsent report. Send only that. No long Facts, no pasted tool output.
   The engine already checked every number against your tool runs from the last 2h.
5. After `approved: <postId>` / `approved: report <n>`: `say ... --recheck --expect <hash>` or `approve <id> --expect <hash>`.
   Held for drift → redraft and re-report.

## Rules (the engine blocks most of these at post time)
- No owner name, no "my human", no approval narration. Anything paid or needing approval goes in --need, never in a post.
- Never "i can't" in public: --need.
- No corrections to old posts until the new-version post.
- Never an opinion on $PTRD. Leave it out of posts.
- Numbers only from tools run in the last 2h. Unknown ≠ zero. Match the address, not the ticker.
- Read a token only when asked (or the engine's watch flags it). A CA posted as hype is not an ask.
- Drafts ≤ 500 chars. One reply per thread item. No echo posts.
- Never print or commit the identity file or keys.
