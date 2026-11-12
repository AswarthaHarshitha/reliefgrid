#!/usr/bin/env bash
# Deploys the current main branch: verified backup first, then build and restart, then a health check.
set -euo pipefail
cd "$(dirname "$0")"
test -f secrets.env || { echo "secrets.env is missing (user accounts as CDS_CONFIG)"; exit 1; }
test -f .env || { echo ".env is missing (DOMAIN, RELIEFGRID_TIME_ZONE)"; exit 1; }

# a verified backup of the existing database before any change
if sudo docker compose ps --status running app | grep -q app; then
  sudo docker compose exec -T app node scripts/backup-database.js /data/reliefgrid.sqlite /data/backups
fi

git -C ../.. pull --ff-only
sudo docker compose build --pull app
sudo docker compose up -d
for i in $(seq 1 60); do
  if sudo docker compose exec -T app wget -qO- http://127.0.0.1:4004/ready 2>/dev/null | grep -q ready; then
    echo "ReliefGrid is ready: https://$(grep ^DOMAIN= .env | cut -d= -f2)"
    exit 0
  fi
  sleep 2
done
echo "ReliefGrid did not become ready; see: sudo docker compose logs app"; exit 1
