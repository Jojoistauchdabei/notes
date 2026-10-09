#!/usr/bin/env bash
# Aktiviert die QNAP-Spiegelung fuer Snapshots und den GC-Bericht.
# Idempotent.
set -euo pipefail

R=/mnt/qnap/federwerk/backups
log() { printf '== %s\n' "$*"; }

mountpoint -q /mnt/qnap/federwerk || { log "FEHLER: QNAP nicht gemountet"; exit 1; }
mkdir -p "$R"; chmod 0770 "$R"

log "Setze FW_BACKUP_REMOTE=$R"
cat > /etc/federwerk/backup.env <<EOF
FW_BACKUP_KEEP_DAYS=14
FW_BACKUP_REMOTE=$R
EOF
chmod 600 /etc/federwerk/backup.env

# GC-Konfiguration. GC_ACTION bleibt bewusst LEER - der Aufraeum-Job ist
# nicht per Timer aktiviert und wuerde beim ersten Start sonst sofort
# loeschen, ohne dass jemand den Bericht gelesen haette.
cat > /etc/federwerk/gc.env <<'EOF'
FW_ORPHAN_DAYS=90
FW_COLD_DAYS=180
# Leer lassen = gc.js meldet nur. Erst nach einem Blick in den Bericht:
# GC_ACTION=--delete --cold
GC_ACTION=
EOF
chmod 600 /etc/federwerk/gc.env

# gc.js und schema.sql gehoeren zum ausgelieferten Stand, nicht zum
# Arbeitsverzeichnis - sie werden beim Deploy mitdeployt.
install -d -m 755 /srv/federwerk/app
install -m 644 "${SRC:-/tmp}/gc.js"      /srv/federwerk/app/gc.js
install -m 644 "${SRC:-/tmp}/schema.sql" /srv/federwerk/app/schema.sql

systemctl daemon-reload
log "Backup-Timer neu starten"
systemctl restart federwerk-backup.timer

log "GC-Bericht-Timer aktivieren (meldet nur, loescht nichts):"
systemctl enable --now federwerk-gc-report.timer 2>&1 | sed 's/^/   /'
systemctl list-timers federwerk-backup.timer federwerk-gc-report.timer --no-pager --no-legend | sed 's/^/   /'

log "GC-Ausfuehrung ist bewusst NICHT aktiviert:"
printf '   %s\n' "$(systemctl is-enabled federwerk-gc-apply.service 2>&1)"

log "Fertig."