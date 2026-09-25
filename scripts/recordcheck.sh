#!/usr/bin/env bash
# Records a check fixture per address (every HTTP/RPC answer + the expected result), then replays it offline right
# away and fails if the replay differs: a fixture is only kept if it is deterministic.
# usage: scripts/recordcheck.sh <name>=<address> ...   → test/fixtures/replay/<name>.http.json + <name>.expected.json
set -u
OUT=test/fixtures/replay; mkdir -p "$OUT"
NOW=${PRETRADE_NOW:-$(date +%s000)}
status=0
for pair in "$@"; do
  name=${pair%%=*}; addr=${pair#*=}
  for attempt in 1 2 3; do
    rm -f "$OUT/$name.http.json"
    PRETRADE_DATA=$(mktemp -d) PRETRADE_NOW=$NOW PRETRADE_HTTP_FIXTURE="$OUT/$name.http.json" PRETRADE_HTTP_MODE=record \
      node bot/musebot.mjs checkjson "$addr" > "$OUT/$name.expected.json"
    # replay with a stand-in key (scrubbed to <key> exactly like the real one)
    PRETRADE_DATA=$(mktemp -d) PRETRADE_NOW=$NOW PRETRADE_HTTP_FIXTURE="$OUT/$name.http.json" PRETRADE_HTTP_MODE=replay ETHERSCAN_KEY=FIXTUREKEY00000000 NODEFLARE_KEY= \
      node bot/musebot.mjs checkjson "$addr" > /tmp/replay.json 2>/tmp/replay.err
    if cmp -s "$OUT/$name.expected.json" /tmp/replay.json && [ -s "$OUT/$name.expected.json" ] && ! grep -q '^null$' "$OUT/$name.expected.json"; then
      echo "$name ($addr): recorded, replay matches ($(wc -c < "$OUT/$name.http.json") bytes, attempt $attempt)"; break
    fi
    echo "$name: replay differs on attempt $attempt"; diff "$OUT/$name.expected.json" /tmp/replay.json | head -20; cat /tmp/replay.err | head -5
    [ $attempt = 3 ] && status=1
  done
done
echo "PRETRADE_NOW=$NOW" > "$OUT/NOW"
exit $status
