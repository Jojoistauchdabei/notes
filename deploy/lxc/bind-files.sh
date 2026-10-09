#!/usr/bin/env bash
# Bindet die QNAP-Ablage unter /srv/federwerk/files ein.
#
# WICHTIG - wer den Mount macht:
# Der CIFS-Mount kommt vom Proxmox-Host (in der Container-Config per
# lxc.mount.entry) und ist im Container schon als /mnt/qnap/federwerk
# sichtbar. Dieses Script mountet NICHTS selbst und fasst die fstab des
# Containers nicht an: der Container hat weder Credentials noch die
# Rechte, einen zweiten CIFS-Mount zu verhandeln. Was hier passiert, ist
# ausschliesslich ein Bind-Mount des bereits vorhandenen Mounts.
#
# Das "Nur im Fehlerfall binden" ist der entscheidende Punkt. Faellt der
# Host-Mount aus, waere ein blinder Bind-Befehl ein Erfolg - er bindet
# schlicht das leere lokale Verzeichnis. Die App schreibt dann ihre Dateien
# auf die lokale Platte, sie sieht das nie, und beim naechsten Boot sind
# die echten Daten wieder da, die neuen aber nicht mehr. Deshalb: vorher
# pruefen, und im Zweifel abbrechen.
set -euo pipefail

SRC_ROOT="${SRC_ROOT:-/mnt/qnap/federwerk}"
SRC="${SRC_ROOT}/blobs"
DST="${DST:-/srv/federwerk/files}"

log() { printf '== %s\n' "$*"; }

# Bereits gebunden?
if mountpoint -q "$DST" && [ "$(readlink -f "$(findmnt -no SOURCE "$DST")")" = "$(readlink -f "$SRC")" ]; then
  log "$DST ist bereits von $SRC gebunden."
  exit 0
fi

if [ ! -d "$SRC_ROOT" ] || ! mountpoint -q "$SRC_ROOT"; then
  log "FEHLER: $SRC_ROOT ist kein Mountpoint."
  log "  Der Host-Mount fehlt. Abbruch, damit die App nicht auf die"
  log "  lokale Platte ausweicht. Auf dem Proxmox-Host pruefen:"
  log "    lxc.mount.entry in /etc/pve/lxc/<ctid>.conf"
  exit 1
fi

log "Quelle: $(findmnt -no SOURCE,FSTYPE "$SRC_ROOT")"
log "Optionen: $(findmnt -no OPTIONS "$SRC_ROOT" | tr ',' '\n' | grep -E 'cache|vers|soft' | tr '\n' ' ')"

mkdir -p "$SRC" "$DST"
mount --bind "$SRC" "$DST"
log "Gebunden: $SRC -> $DST"

# Gegenprobe: derselbe Mountpoint, nicht nur "etwas".
if ! mountpoint -q "$DST"; then
  log "FEHLER: $DST ist nach dem Bind kein Mountpoint."
  exit 1
fi

# Sichtbarkeitstest. Auf CIFS mit falschen Rechten sieht der Pfad
# vorhanden aus, ist aber nicht beschreibbar - das faellt sonst erst beim
# ersten echten Upload auf.
probe="$DST/.probe.$$"
if touch "$probe" 2>/dev/null; then
  rm -f "$probe"
  log "Schreibtest bestanden."
else
  log "FEHLER: $DST ist nicht beschreibbar (Rechte auf dem Share?)"
  exit 1
fi

log "Fertig. Abbau zum Zuruecksetzen:  umount $DST"