#!/usr/bin/env bash
# GitHub-Actions-Runner im LXC einrichten.
#
#   sudo bash deploy/lxc/setup-runner.sh
#
# Legt User, sudo-Regel, Deploy-Einstieg und systemd-Unit an. Die
# Registrierung selbst macht NICHT dieses Skript - sie braucht ein einmaliges
# Token von GitHub und gehoert deshalb als eigener, sichtbarer Schritt:
#
#   cd /opt/actions-runner
#   ./config.sh --url https://github.com/Jojoistauchdabei/notes \
#               --token <TOKEN> --name lxc-federwerk \
#               --labels lxc --unattended --replace
#   systemctl enable --now actions-runner.service
#
# Warum --labels lxc: der Workflow deklariert runs-on: [self-hosted, lxc].
# Ohne das Label nimmt der Runner die Jobs nicht an.
set -euo pipefail

SRC="$(cd "$(dirname "${BASH_SOURCE[0]:-$0}")" && pwd)"
RUNNER_DIR=/opt/actions-runner
VERSION="${RUNNER_VERSION:-2.328.0}"
ARCH="$(dpkg --print-architecture)"

log() { printf '== %s\n' "$*"; }

# ---- Runner-Binary ----
if [ ! -x "$RUNNER_DIR/bin/Runner.Listener" ]; then
  log "Lade Runner $VERSION ($ARCH)"
  install -d -m 755 "$RUNNER_DIR"
  curl -fsSL -o /tmp/runner.tar.gz \
    "https://github.com/actions/runner/releases/download/v${VERSION}/actions-runner-linux-${ARCH}-${VERSION}.tar.gz"
  (cd "$RUNNER_DIR" && tar xzf /tmp/runner.tar.gz)
  rm -f /tmp/runner.tar.gz
fi
log "Runner: $("$RUNNER_DIR/bin/Runner.Listener" --version 2>&1 | head -1)"

# ---- User ----
id runner >/dev/null 2>&1 || useradd -m -s /bin/bash runner
chown -R runner:runner "$RUNNER_DIR"
chmod +x "$RUNNER_DIR/run.sh" "$RUNNER_DIR"/*.sh

# ---- sudo: genau eine Aufgabe ----
# Der Runner laeuft mit Repo-Code im Arbeitsverzeichnis. Ein pauschales
# NOPASSWD:ALL waere bei jeder Kompromittierung des Repos ein offener Weg
# auf die Maschine. Stattdessen darf er genau dieses Skript starten, und auch
# das nur fuer einen Pfad unter /home/runner/work/.
log "Installiere sudo-Regel"
install -m 440 "$SRC/sudoers-actions-runner" /etc/sudoers.d/actions-runner
visudo -c -f /etc/sudoers.d/actions-runner

log "Installiere Deploy-Einstieg nach /srv/federwerk/deploy.sh"
install -m 755 "$SRC/runner-deploy.sh" /srv/federwerk/deploy.sh

# ---- Unit ----
log "Installiere systemd-Unit"
install -m 644 "${RUNNER_UNIT:-/tmp/actions-runner.service}" /etc/systemd/system/actions-runner.service
systemctl daemon-reload

if [ -f "$RUNNER_DIR/.runner" ]; then
  log "Runner ist bereits registriert - Dienst starten:"
  systemctl enable --now actions-runner.service
  sleep 4
  systemctl is-active actions-runner.service | sed 's/^/   Status: /'
else
  log "Runner installiert, aber NICHT registriert."
  log "  Token holen:"
  log "    gh api -X POST repos/Jojoistauchdabei/notes/actions/runners/registration-token -q .token"
  log "  Dann:"
  log "    cd $RUNNER_DIR && ./config.sh --url https://github.com/Jojoistauchdabei/notes \\"
  log "      --token <TOKEN> --name lxc-federwerk --labels lxc --unattended --replace"
  log "    systemctl enable --now actions-runner.service"
fi