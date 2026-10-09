#!/usr/bin/env bash
# Federwerk: Grundinstallation im LXC (Proxmox). Idempotent.
#
#   ssh root@<lxc> 'bash -s' < deploy/lxc/bootstrap.sh
#
# Legt Node 24 (fuer node:sqlite ohne Flag), den System-User und die
# Verzeichnisstruktur an. Der Dienst startet bewusst noch nicht - es gibt
# bis zum Schritt "server/" keinen Anwendungscode.
set -euo pipefail

APP_USER="${APP_USER:-federwerk}"
APP_ROOT="${APP_ROOT:-/srv/federwerk}"

log() { printf '== %s\n' "$*"; }

# ---------- Node 24 ----------
if [ "$(node -v 2>/dev/null || true)" != "" ]; then
  log "Node vorhanden: $(node -v)"
else
  log "Installiere Node 24 (NodeSource)"
  export DEBIAN_FRONTEND=noninteractive
  curl -fsSL https://deb.nodesource.com/setup_24.x | bash - >/tmp/nodesource.log 2>&1
  apt-get install -y nodejs >>/tmp/nodesource.log 2>&1
  log "Node installiert: $(node -v)"
fi

# node:sqlite ist ab 23.4 ohne Flag verfuegbar - ohne das geht der ganze
# Zero-Dependency-Ansatz nicht (kein better-sqlite3, kein Compile-Step).
node -e 'const { DatabaseSync } = require("node:sqlite");
const d = new DatabaseSync(":memory:");
d.exec("create table t(a)");
console.log("== node:sqlite verfuegbar");'

# ---------- System-User ----------
if ! id -u "$APP_USER" >/dev/null 2>&1; then
  log "Lege System-User '$APP_USER' an"
  useradd --system --home-dir "$APP_ROOT" --shell /usr/sbin/nologin "$APP_USER"
fi

# ---------- Verzeichnisse ----------
# data/         SQLite pro Nutzer + Dateien (NFS-Mount fuer files/)
# app/          ausgechecktes dist/ aus dem Deploy
# backups/      SQLite-Snapshots, gehen spaeter auf die QNAP
log "Lege Verzeichnisse unter $APP_ROOT an"
install -d -m 750 -o "$APP_USER" -g "$APP_USER" \
  "$APP_ROOT" \
  "$APP_ROOT/app" \
  "$APP_ROOT/data" \
  "$APP_ROOT/data/users" \
  "$APP_ROOT/files" \
  "$APP_ROOT/backups"

# Auf QNAP gemountet: der lokale Mountpoint muss existieren, bevor der
# NFS-Mount darue gelegt wird, und darf nicht mehr Daten enthalten.
if mountpoint -q "$APP_ROOT/files"; then
  log "files/ ist bereits gemountet: $(findmnt -no SOURCE,FSTYPE "$APP_ROOT/files")"
else
  log "files/ ist kein Mountpunkt - NFS-Mount folgt (QNAP-Daten noetig)"
fi

log "Fertig. Naechster Schritt: QNAP-Share mounten, dann systemd-Units."