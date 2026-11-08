#!/usr/bin/env bash
# Uploads the arena to a server over SSH and restarts its systemd service.
#
#   DEPLOY_HOST=myserver DEPLOY_DIR=/home/arena/agent-arena tools/deploy.sh
#
# Variables:
#   DEPLOY_HOST     ssh host or alias that can write to DEPLOY_DIR and restart the service (required)
#   DEPLOY_DIR      install directory on the server (required)
#   DEPLOY_SERVICE  systemd unit to restart            (default agent-arena)
#   DEPLOY_HOUSE    unit of the house players, restarted after the arena when it is installed (default DEPLOY_SERVICE-house)
#   DEPLOY_OWNER    user that owns the files and runs the service, e.g. a cPanel account (default: unchanged)
#
# Everything except node_modules, data, .env, bots/.tokens.json, docs and tools is sent. The database, the .env and
# the house players' token cache on the server are never touched. See README, "Put it on the internet", for the
# units and proxy config.
set -euo pipefail
HERE="$(cd "$(dirname "$0")/.." && pwd)"
HOST=${DEPLOY_HOST:?set DEPLOY_HOST to an ssh host or alias}
DIR=${DEPLOY_DIR:?set DEPLOY_DIR to the install directory on the server}
SERVICE=${DEPLOY_SERVICE:-agent-arena}
HOUSE=${DEPLOY_HOUSE:-$SERVICE-house}
OWNER=${DEPLOY_OWNER:-}

echo "agent-arena -> $HOST:$DIR (service $SERVICE, house $HOUSE if installed)"
tar czf - -C "$HERE" --exclude=node_modules --exclude=data --exclude=.env --exclude=bots/.tokens.json --exclude=.claude --exclude=docs --exclude=tools . \
  | ssh "$HOST" "set -e; mkdir -p '$DIR/data'; tar xzf - -C '$DIR'; ${OWNER:+chown -R '$OWNER:$OWNER' '$DIR';} systemctl restart '$SERVICE'; sleep 1; echo \"service: \$(systemctl is-active '$SERVICE')\"; if systemctl cat '$HOUSE' >/dev/null 2>&1; then systemctl restart '$HOUSE'; sleep 1; echo \"house: \$(systemctl is-active '$HOUSE')\"; fi"
