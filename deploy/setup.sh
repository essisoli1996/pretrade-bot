#!/usr/bin/env bash
# One-time (and safe to re-run) server setup for the pretrade bot. Ubuntu 22.04/24.04, run as root:
#   curl -fsSL https://raw.githubusercontent.com/essisoli1996/pretrade-bot/main/deploy/setup.sh | sudo bash
# Layout:  /opt/pretrade/app   code (a git checkout, replaced freely on updates)
#          /var/lib/pretrade   runtime data: state, ledger, radar, mentions (never touched by updates)
#          /etc/pretrade/env   secrets (MUSE_IDENTITY, BANKR_LLM_KEY, OPENROUTER_KEY), root-only, written by the server workflow
set -euo pipefail
REPO="${REPO:-https://github.com/essisoli1996/pretrade-bot.git}"
NODE_VERSION="${NODE_VERSION:-v22.20.0}"
APP=/opt/pretrade/app DATA=/var/lib/pretrade

echo "== packages"
export DEBIAN_FRONTEND=noninteractive
apt-get update -qq && apt-get install -y -qq git curl ca-certificates xz-utils >/dev/null

echo "== node"
if ! command -v node >/dev/null || [ "$(node -v)" != "$NODE_VERSION" ]; then
  ARCH=$(uname -m); case "$ARCH" in x86_64) A=x64;; aarch64) A=arm64;; *) echo "unsupported arch $ARCH"; exit 1;; esac
  curl -fsSL "https://nodejs.org/dist/$NODE_VERSION/node-$NODE_VERSION-linux-$A.tar.xz" | tar -xJ -C /usr/local --strip-components=1
fi
node -v

echo "== swap (the free 1 GB machines need it)"
if ! swapon --show | grep -q /swapfile; then
  fallocate -l 1G /swapfile && chmod 600 /swapfile && mkswap /swapfile >/dev/null && swapon /swapfile
  grep -q /swapfile /etc/fstab || echo "/swapfile none swap sw 0 0" >> /etc/fstab
fi

echo "== user and folders"
id pretrade >/dev/null 2>&1 || useradd --system --create-home --home-dir /opt/pretrade --shell /usr/sbin/nologin pretrade
mkdir -p "$DATA" /etc/pretrade
chown pretrade:pretrade "$DATA"; chmod 700 "$DATA"
touch /etc/pretrade/env; chown root:pretrade /etc/pretrade/env; chmod 640 /etc/pretrade/env

echo "== code"
mkdir -p /opt/pretrade && chown pretrade:pretrade /opt/pretrade
if [ ! -d "$APP/.git" ]; then sudo -u pretrade git clone -q "$REPO" "$APP"; else sudo -u pretrade git -C "$APP" fetch -q origin main && sudo -u pretrade git -C "$APP" reset -q --hard origin/main; fi

echo "== carry over the bot's memory from the repo on first install"
for f in .state.json mentions.log; do [ -e "$DATA/$f" ] || [ ! -e "$APP/bot/$f" ] || cp "$APP/bot/$f" "$DATA/$f"; done
for d in ledger radar; do [ -e "$DATA/$d" ] || [ ! -d "$APP/bot/$d" ] || cp -r "$APP/bot/$d" "$DATA/$d"; done
chown -R pretrade:pretrade "$DATA"

echo "== services"
install -m 644 "$APP/deploy/pretrade.service" /etc/systemd/system/pretrade.service
install -m 644 "$APP/deploy/pretrade-update.service" /etc/systemd/system/pretrade-update.service
install -m 644 "$APP/deploy/pretrade-update.timer" /etc/systemd/system/pretrade-update.timer
install -m 755 "$APP/deploy/update.sh" /usr/local/bin/pretrade-update
systemctl daemon-reload
systemctl enable -q pretrade-update.timer && systemctl start pretrade-update.timer
systemctl enable -q pretrade.service
if grep -q "^MUSE_IDENTITY" /etc/pretrade/env; then systemctl restart pretrade.service; echo "bot started"; else echo "secrets not written yet: the bot starts after the server workflow writes /etc/pretrade/env"; fi
echo "== done"
