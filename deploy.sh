#!/usr/bin/env bash
# Deploy the Stocks Dashboard to the droplet.
#
# The droplet holds a git clone of the public repo at /var/www/stocksDashboard;
# deploying = push to GitHub, pull on the droplet, sync private files, restart.
# Usage: ./deploy.sh            (run from the repo root, e.g. in Git Bash)

set -euo pipefail

HOST="root@165.232.67.174"
KEY="$HOME/.ssh/polymarket_ed25519"
APP_DIR="/var/www/stocksDashboard"
SSH="ssh -i $KEY -o BatchMode=yes $HOST"

echo "==> Pushing to GitHub"
git push origin main

echo "==> Pulling on droplet"
$SSH "cd $APP_DIR && git pull --ff-only"

echo "==> Syncing private files"
scp -i "$KEY" config.json individual_holdings.json "$HOST:$APP_DIR/"

echo "==> Installing dependencies (if changed)"
$SSH "$APP_DIR/venv/bin/pip install -q -r $APP_DIR/requirements.txt"

echo "==> Restarting service"
$SSH "systemctl restart stocksdashboard && systemctl is-active stocksdashboard"

echo "==> Health check"
$SSH "curl -s -o /dev/null -w '%{http_code}\n' http://127.0.0.1:8600/healthz"
echo "Done: http://165.232.67.174/stocksDashboard.html"
