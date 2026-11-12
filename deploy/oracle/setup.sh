#!/usr/bin/env bash
# One-time setup of a fresh Ubuntu server (Oracle Cloud Always Free, Ampere A1) for ReliefGrid.
# Run as the default user (ubuntu) with sudo rights:  bash setup.sh
set -euo pipefail

# Docker
if ! command -v docker >/dev/null; then
  curl -fsSL https://get.docker.com | sudo sh
  sudo usermod -aG docker "$USER"
fi

# Oracle's Ubuntu images reject incoming traffic except SSH in iptables; open HTTP and HTTPS
for port in 80 443; do
  sudo iptables -C INPUT -p tcp --dport "$port" -j ACCEPT 2>/dev/null || sudo iptables -I INPUT 6 -m state --state NEW -p tcp --dport "$port" -j ACCEPT
done
sudo DEBIAN_FRONTEND=noninteractive apt-get install -y -q iptables-persistent >/dev/null
sudo netfilter-persistent save >/dev/null

# The application
if [ ! -d "$HOME/reliefgrid" ]; then
  git clone https://github.com/AswarthaHarshitha/reliefgrid.git "$HOME/reliefgrid"
fi
echo "Setup done. Next: create deploy/oracle/secrets.env and .env, then run deploy.sh"
