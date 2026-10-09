#!/usr/bin/env bash
# Ausfuehrende Datei, die der Runner per sudo startet. Laeuft als root, nimmt
# aber KEIN Argument entgegen - sudoers-Regeln mit Argumenten verlangen eine
# exakte Uebereinstimmung der Kommandozeile und wuerden bei jeder kleinen
# Formatierungsabweichung aus GitHub ins Leere laufen.
#
# GITHUB_WORKSPACE erreicht uns nur, weil die sudoers-Regel genau diese eine
# Variable per env_keep durchlaesst.
set -euo pipefail

SRC="${GITHUB_WORKSPACE:-}"

if [ -z "$SRC" ] || [ ! -d "$SRC/deploy/lxc" ]; then
  echo "FEHLER: kein Checkout (GITHUB_WORKSPACE='${GITHUB_WORKSPACE:-}')"
  exit 1
fi

# Zweite Sperre: selbst wenn jemand GITHUB_WORKSPACE belegen koennte, darf der
# Pfad nicht aus dem Arbeitsverzeichnis des Runners herauszeigen. Ein Deploy
# aus einem fremden Verzeichnis wuerde beliebigen Code als root ausfuehren.
if [ "${SRC#/home/runner/work/}" = "$SRC" ]; then
  echo "FEHLER: Quelle $SRC liegt nicht im Runner-Arbeitsverzeichnis"
  exit 1
fi

echo "== Quelle: $SRC"
exec bash "$SRC/deploy/lxc/deploy-app.sh" "$SRC"