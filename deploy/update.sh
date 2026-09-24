#!/usr/bin/env bash
# Runs every 5 minutes (pretrade-update.timer). Follows main: when a new commit passes the offline tests, switch to it
# and restart the bot. A commit that fails the tests is never run; the bot stays on the last good one.
set -uo pipefail
APP=/opt/pretrade/app
G() { sudo -u pretrade git -C "$APP" "$@"; }   # the checkout belongs to the pretrade user; root never touches it with git
G fetch -q origin main || exit 0
NEW=$(G rev-parse origin/main); CUR=$(G rev-parse HEAD)
[ "$NEW" = "$CUR" ] && exit 0
TMP=$(mktemp -d); trap 'rm -rf "$TMP"' EXIT
G archive "$NEW" | tar -x -C "$TMP"
cd "$TMP"
for t in test/v4hooks.test.mjs test/sim.test.mjs test/txsim.test.mjs test/features.test.mjs test/talk.test.mjs test/control.test.mjs test/store.test.mjs test/provenance.test.mjs; do
  [ -f "$t" ] || continue
  if ! node "$t" >/tmp/pretrade-test.log 2>&1; then echo "update to ${NEW:0:7} refused: $t failed"; tail -5 /tmp/pretrade-test.log; exit 0; fi
done
for f in bot/*.mjs; do node --check "$f" || { echo "update to ${NEW:0:7} refused: $f does not parse"; exit 0; }; done
G reset -q --hard "$NEW"
install -m 644 "$APP/deploy/pretrade.service" /etc/systemd/system/pretrade.service
install -m 755 "$APP/deploy/update.sh" /usr/local/bin/pretrade-update
systemctl daemon-reload
systemctl restart pretrade.service
echo "updated ${CUR:0:7} → ${NEW:0:7}, bot restarted"
