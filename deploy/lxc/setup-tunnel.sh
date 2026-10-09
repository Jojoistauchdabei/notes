#!/usr/bin/env bash
# Richtet den Cloudflare-Tunnel ein.
#
#   sudo bash deploy/lxc/setup-tunnel.sh
#   sudo nano /etc/federwerk/tunnel.env      # TUNNEL_TOKEN eintragen
#   sudo systemctl enable --now federwerk-tunnel.service
#
# ---- Warum kein "Quick Tunnel" ----
# `cloudflared tunnel --url http://127.0.0.1:8080` waere die Abkuerzung ohne
# Konto. Sie funktioniert hier nicht: der lokale DNS-Server 192.168.1.88
# (vermutlich Pi-hole/AdGuard) liefert fuer api.trycloudflare.com 0.0.0.0
# zurueck, also:
#   failed to request quick Tunnel: dial tcp 0.0.0.0:443: connect: connection refused
#
# Das ist kein Zufallsfehler, sondern eine bewusste Blockliste. Ein Quick
# Tunnel haette ausserdem keine feste Adresse und keine Uptime-Garantie - fuer
# den Produktivbetrieb ohnehin der falsche Weg. Die Endpunkte eines benannten
# Tunnels (region*.v2.argotunnel.com) sind nicht blockiert.
#
# Den Token holst du im Dashboard:
#   Zero Trust -> Networks -> Tunnels -> <Tunnel> -> Configure
#   dort steht ein fertiges Kommando mit dem Token.
set -euo pipefail

ENV=/etc/federwerk/tunnel.env
log() { printf '== %s\n' "$*"; }

command -v cloudflared >/dev/null || { log "FEHLER: cloudflared fehlt"; exit 1; }
log "cloudflared $(cloudflared --version 2>&1 | head -1)"

install -d -m 700 /etc/federwerk
if [ ! -f "$ENV" ]; then
  log "Lege $ENV an"
  cat > "$ENV" <<'EOF'
# Cloudflare-Tunnel-Token. 0600, niemals ins Repo.
# Zero Trust -> Networks -> Tunners -> "federwerk" -> Configure
TUNNEL_TOKEN=
EOF
  chmod 600 "$ENV"
  log ">>> Token eintragen:  nano $ENV"
  log ">>> Danach:            systemctl enable --now federwerk-tunnel.service"
  exit 0
fi

TOKEN="$(sed -n 's/^TUNNEL_TOKEN=//p' "$ENV" | tr -d '"\r\n ')"
if [ -z "$TOKEN" ]; then
  log "FEHLER: TUNNEL_TOKEN ist leer in $ENV"
  exit 1
fi
log "Token gefunden (${#TOKEN} Zeichen)"

install -m 644 "${SRC:-/tmp}/federwerk-tunnel.service" /etc/systemd/system/
systemctl daemon-reload
systemctl enable --now federwerk-tunnel.service

sleep 6
if systemctl is-active --quiet federwerk-tunnel.service; then
  log "Tunnel laeuft"
  journalctl -u federwerk-tunnel -n 12 --no-pager | sed 's/^/   /'
else
  log "FEHLER: Tunnel startet nicht"
  journalctl -u federwerk-tunnel -n 20 --no-pager | sed 's/^/   /'
  exit 1
fi