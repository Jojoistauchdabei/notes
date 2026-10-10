#!/usr/bin/env bash
# Legt die systemd-Units und das Backup-Skript auf dem LXC ab.
# Aufruf aus einem Repo-Checkout:
#   bash deploy/lxc/install-units.sh
# oder aus einem anderen Verzeichnis:
#   bash deploy/lxc/install-units.sh /pfad/zum/deploy/lxc
#
# Idempotent. Der App-Dienst wird bewusst NICHT gestartet - er braucht
# /srv/federwerk/app/server/index.js, das es erst mit dem Server-Stand gibt.
set -euo pipefail

# Quelle: Argument, dann SRC-Env, dann das Verzeichnis dieses Scripts.
# Beim Pipen via stdin (cat install-units.sh | bash -) gibt es kein
# BASH_SOURCE - deshalb die Reihenfolge und kein set -u-Fehlschlag.
if [ $# -ge 1 ]; then
  SRC="$(cd "$1" && pwd)"
elif [ -n "${SRC:-}" ]; then
  SRC="$(cd "$SRC" && pwd)"
elif [ -n "${BASH_SOURCE[0]:-}" ]; then
  SRC="$(cd "$(dirname "${BASH_SOURCE[0]}")" && pwd)"
else
  echo "FEHLER: Quelle nicht ermittelbar - mit Argument oder SRC= aufrufen." >&2
  exit 1
fi
APP_ROOT="${APP_ROOT:-/srv/federwerk}"
APP_USER="${APP_USER:-federwerk}"

log() { printf '== %s\n' "$*"; }

[ -f "$SRC/federwerk.service" ] || { echo "FEHLER: $SRC/federwerk.service nicht gefunden"; exit 1; }

install -d -m 755 /etc/federwerk
install -d -m 750 -o "$APP_USER" -g "$APP_USER" "$APP_ROOT/backups"
install -d -m 755 "$APP_ROOT/bin"

log "Installiere Units nach /etc/systemd/system"
install -m 644 "$SRC/federwerk.service"           /etc/systemd/system/
install -m 644 "$SRC/federwerk-backup.service"    /etc/systemd/system/
install -m 644 "$SRC/federwerk-backup.timer"      /etc/systemd/system/
log "Installiere backup.js nach $APP_ROOT/bin"
install -m 755 "$SRC/backup.js"                   "$APP_ROOT/bin/backup.js"

# ---- App-Env ----
# Das Session-Secret wird hier einmalig erzeugt und danach nicht mehr
# angefasst: ein Neustart darf keine laufenden Sessions entwerten.
if [ ! -f /etc/federwerk/env ]; then
  log "Erzeuge /etc/federwerk/env mit neuem Session-Secret"
  SECRET="$(head -c 48 /dev/urandom | base64 | tr -d '\n/+=' | head -c 48)"
  cat > /etc/federwerk/env <<EOF
# Federwerk App-Konfiguration. 0600, enthaelt Geheimnisse.
NODE_ENV=production
FW_DATA_DIR=$APP_ROOT/data
FW_FILES_DIR=$APP_ROOT/files
FW_BACKUP_DIR=$APP_ROOT/backups
# Ohne vorgeschalteten Proxy muss der Dienst auf der Netzwerkschnittstelle
# lauschen, sonst erreicht ihn kein Geraet im LAN. Wer nur lokal arbeitet oder
# einen Proxy davorstellt, setzt 127.0.0.1.
FW_HOST=0.0.0.0
FW_PORT=8080
FW_SESSION_SECRET=$SECRET
# TLS uebernimmt ein Reverse-Proxy davor (nginx/Caddy). Dann hier dessen
# oeffentliche Adresse eintragen: sie ist die einzige zusaetzlich erlaubte
# Herkunft fuer CORS und schaltet das Secure-Flag am Session-Cookie ein.
# FW_PUBLIC_URL=https://notes.example.org
EOF
  chmod 600 /etc/federwerk/env
  log "Session-Secret erzeugt (nicht ausgegeben)"
else
  log "/etc/federwerk/env existiert bereits - Secret bleibt unangetastet"
fi

# ---- Backup-Env ----
# Ohne FW_BACKUP_REMOTE bleiben die Snapshots lokal; backup.js warnt dann
# und spiegelt nicht. Nach dem Mounten des QNAP-Shares hier eintragen:
#   FW_BACKUP_REMOTE=/mnt/qnap/federwerk-backups
if [ ! -f /etc/federwerk/backup.env ]; then
  log "Lege /etc/federwerk/backup.env an (QNAP-Ziel noch leer)"
  cat > /etc/federwerk/backup.env <<'EOF'
# Ziel auf der QNAS. Erst ausfuellen, wenn das Share wirklich gemountet ist:
FW_BACKUP_KEEP_DAYS=14
# FW_BACKUP_REMOTE=/mnt/qnap/federwerk-backups
EOF
  chmod 600 /etc/federwerk/backup.env
fi

systemctl daemon-reload
systemctl enable --now federwerk-backup.timer
log "Backup-Timer aktiv: $(systemctl list-timers federwerk-backup.timer --no-pager --no-legend | head -1)"

# App-Dienst: installiert, aber nicht gestartet (kein Server-Code vorhanden).
systemctl enable federwerk.service >/dev/null 2>&1 || true

log "Fertig. Naechster Schritt: QNAP-Share mounten, dann GitHub-Runner."