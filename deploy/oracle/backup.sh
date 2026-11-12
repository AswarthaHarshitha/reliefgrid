#!/usr/bin/env bash
# Daily verified backup (run by cron); keeps 14 days of backups on the data volume.
set -euo pipefail
cd "$(dirname "$0")"
sudo docker compose exec -T app node scripts/backup-database.js /data/reliefgrid.sqlite /data/backups
sudo docker compose exec -T app sh -c 'find /data/backups -name "reliefgrid-*.sqlite*" -mtime +14 -delete'
