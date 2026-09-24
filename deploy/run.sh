#!/usr/bin/env bash
# What pretrade.service runs, once per 5-minute segment. Exactly one bot may be live: deploy/host in the repo says which
# ("actions" = the GitHub Actions bot, "server" = this machine). On the switch to "server" it waits 7 minutes so the
# Actions bot can finish its last segment and push its memory, then takes that memory over and starts.
set -uo pipefail
APP="${PRETRADE_APP:-/opt/pretrade/app}" DATA="${PRETRADE_DATA:-/var/lib/pretrade}"
cd "$APP"
HOST=$(git show origin/main:deploy/host 2>/dev/null | tr -d '[:space:]'); HOST=${HOST:-actions}
if [ "$HOST" != "server" ]; then
  rm -f "$DATA/.took-over" "$DATA/.flip-seen"
  echo "deploy/host is '$HOST': the GitHub Actions bot is in charge, standing by"; sleep 60; exit 0
fi
if [ ! -f "$DATA/.took-over" ]; then
  [ -f "$DATA/.flip-seen" ] || date +%s > "$DATA/.flip-seen"
  WAIT=$(( $(cat "$DATA/.flip-seen") + 420 - $(date +%s) ))
  if [ "$WAIT" -gt 0 ]; then echo "taking over from GitHub Actions in ${WAIT}s"; sleep $(( WAIT < 60 ? WAIT : 60 )); exit 0; fi
  # the freshest memory is what the Actions bot pushed on its way out
  TMP=$(mktemp -d)
  for p in bot/.state.json bot/ledger bot/radar bot/mentions.log; do git archive origin/main "$p" 2>/dev/null | tar -x -C "$TMP" 2>/dev/null; done
  if [ -s "$TMP/bot/.state.json" ]; then cp -a "$TMP/bot/." "$DATA/" && echo "memory taken over from the repo: $(ls -A "$TMP/bot" | tr '\n' ' ')"; fi
  rm -rf "$TMP"; date +%s > "$DATA/.took-over"
fi
if [ -n "${MUSE_IDENTITY_B64:-}" ]; then MUSE_IDENTITY="$(printf %s "$MUSE_IDENTITY_B64" | base64 -d)"; export MUSE_IDENTITY; fi
[ -n "${MUSE_IDENTITY:-}" ] || { echo "no identity in /etc/pretrade/env yet"; sleep 60; exit 0; }
exec /usr/local/bin/node bot/musebot.mjs serve --live --segment 5 --poll 20
