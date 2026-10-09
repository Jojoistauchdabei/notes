#!/usr/bin/env bash
# Deploy des Anwendungsstands auf den LXC.
#
#   sudo bash deploy/lxc/deploy-app.sh [QUELLE]
#
# QUELLE ist ein ausgechecktes Repo (Standard: das Verzeichnis, in dem
# server/ und dist/ liegen). Ablauf:
#
#   1. Server-Dateien nach /srv/federwerk/app/server/
#   2. gebautes dist/ nach /srv/federwerk/app/dist/ (nur was wirklich neu ist)
#   3. Neustart, danach eine Health-Pruefung
#
# Schritt 2 ist additiv und ersetzt keine Dateien, die der Server zur Laufzeit
# nicht braucht - deshalb wird nicht blind rsync -a --delete verwendet: ein
# Tippfehler im Pfad wuerde sonst die komplette App-Schale loeschen, und der
# Dienst liefe bis zum naechsten Deploy ohne Oberflaeche.
set -euo pipefail

SRC="${1:-$(cd "$(dirname "${BASH_SOURCE[0]}")/../.." && pwd)}"
APP_ROOT="${APP_ROOT:-/srv/federwerk}"
APP_USER="${APP_USER:-federwerk}"
PORT="${FW_PORT:-8080}"

log() { printf '== %s\n' "$*"; }

[ -d "$SRC/server" ] || { echo "FEHLER: $SRC/server nicht gefunden - falsche Quelle?"; exit 1; }
[ -f "$SRC/server/index.js" ] || { echo "FEHLER: $SRC/server/index.js fehlt"; exit 1; }

log "Quelle: $SRC"

# ---- 1. Server-Code ----
log "Installiere Server nach $APP_ROOT/app/server"
install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$APP_ROOT/app/server"
install -m 644 "$SRC"/server/*.js "$APP_ROOT/app/server/"
install -m 644 "$SRC/server/schema.sql" "$APP_ROOT/app/server/schema.sql"
# gc.js und schema.sql liegen zusaetzlich flach - so rufen es die Timer auf.
install -m 644 "$SRC/server/gc.js"      "$APP_ROOT/app/gc.js"
install -m 644 "$SRC/server/schema.sql" "$APP_ROOT/app/schema.sql"
chown -R "$APP_USER:$APP_USER" "$APP_ROOT/app"

# ---- 2. Statische App ----
if [ -d "$SRC/dist" ] && [ -f "$SRC/dist/index.html" ]; then
  log "Installiere dist/ nach $APP_ROOT/app/dist"
  install -d -m 755 -o "$APP_USER" -g "$APP_USER" "$APP_ROOT/app/dist"
  # Inhalt kopieren, ohne Zieldateien zu loeschen, die es im Build nicht gibt.
  (cd "$SRC/dist" && tar -cf - .) | (cd "$APP_ROOT/app/dist" && tar -xf -)
  chown -R "$APP_USER:$APP_USER" "$APP_ROOT/app/dist"
  echo "  $(find "$APP_ROOT/app/dist" -type f | wc -l) Dateien"
else
  log "WARNUNG: kein dist/ in der Quelle - es bleibt der bisherige Stand."
  log "  Bauen mit:  npm run build"
fi

# ---- 3. Neustart + Pruefung ----
log "Neustart"
systemctl restart federwerk.service

# Warten, bis der Dienst wirklich antwortet. Ein Restart, der zurueckkommt,
# bevor der Prozess den Port belegt, wuerde als Erfolg durchgehen.
for i in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then break; fi
  sleep 0.5
done

if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
  log "Health ok: $(curl -fsS "http://127.0.0.1:${PORT}/api/health")"
  log "Fertig."
else
  log "FEHLER: Dienst antwortet nicht. Journal:"
  journalctl -u federwerk -n 25 --no-pager
  exit 1
fi