#!/usr/bin/env bash
# Federwerk Auto-Update: holt Commits von Git, baut, testet, deployed.
#
#   bash deploy/lxc/auto-update.sh [--check] [--skip-tests] [--branch NAME]
#
# Ablauf je Lauf:
#
#   1. flock            nie zwei Laeufe gleichzeitig (Timer + manuell)
#   2. fetch            nur holen, nichts anwenden
#   3. Head vergleichen nichts tun, wenn nichts Neues da ist
#   4. checkout         auf den Ziel-Commit
#   5. build            dist/ neu bauen - ein Build-Fehler ist eine Sperre
#   6. Tests            dieselben, die in CI laufen
#   7. deploy           Server + dist/ austauschen, Dienst neu starten
#   8. Health           /api/health muss antworten
#   9. Rollback         antwortet es nicht, wird der letzte gute Stand
#                       zurueckgespielt und der Dienst neu gestartet
#
# Schritt 5 und 6 in dieser Reihenfolge, nicht umgekehrt: mehrere Tests
# pruefen das gebaute dist/ (Hash-Dateinamen, Theme-Assets). Ein Testlauf vor
# dem Bau wuerde ein leeres oder altes dist/ pruefen und damit nichts wert sein.
set -uo pipefail

REPO="${FW_REPO:-/srv/federwerk/repo}"
LIVE="${FW_APP_DIR:-/srv/federwerk/app}"
PREV="${FW_PREV_DIR:-/srv/federwerk/previous}"
STATE="${FW_STATE_FILE:-/srv/federwerk/deployed.json}"
BRANCH="${FW_BRANCH:-main}"
PORT="${FW_PORT:-8080}"
REMOTE="${FW_GIT_REMOTE:-origin}"
# Wird nur fuer den allerersten Lauf gebraucht, danach reicht der Remote aus
# der vorhandenen Arbeitskopie. Das Repo ist oeffentlich - anonymes Lesen
# genuegt, kein Token, kein Deploy-Key auf diesem Container.
REMOTE_URL="${FW_GIT_URL:-https://github.com/Jojoistauchdabei/notes.git}"

CHECK_ONLY=0
SKIP_TESTS=0
LOG_PREFIX="[autoupdate]"

while [ $# -gt 0 ]; do
  case "$1" in
    --check) CHECK_ONLY=1 ;;
    --skip-tests) SKIP_TESTS=1 ;;
    --branch) BRANCH="$2"; shift ;;
    *) echo "Unbekanntes Argument: $1" >&2; exit 2 ;;
  esac
  shift
done

log() { printf '%s %s\n' "$LOG_PREFIX" "$*"; }
warn() { printf '%s WARNUNG: %s\n' "$LOG_PREFIX" "$*"; }
fail() { printf '%s FEHLER: %s\n' "$LOG_PREFIX" "$*" >&2; }

# ---------------------------------------------------------------
# 1. Sperre. Der Timer laeuft alle 15 Minuten, ein manueller Lauf kann
#    genau darin fallen. Ohne Lock waeren zwei Builds gleichzeitig auf
#    demselben Arbeitsverzeichnis - das endet in einem gemischten dist/.
# ---------------------------------------------------------------
LOCK=/run/federwerk-autoupdate.lock
exec 9>"$LOCK" 2>/dev/null || true
if ! flock -n 9; then
  log "Ein Lauf ist bereits aktiv - uebersprungen."
  exit 0
fi

installed_commit() {
  [ -f "$STATE" ] || return 1
  node -e "try{process.stdout.write(require('$STATE').commit||'')}catch(e){}" 2>/dev/null
}

# ---------------------------------------------------------------
# 2./3. Holen und vergleichen
# ---------------------------------------------------------------
if [ ! -d "$REPO/.git" ]; then
  log "Klone $BRANCH nach $REPO"
  install -d -m 755 "$(dirname "$REPO")"
  git clone -q --branch "$BRANCH" "$REMOTE_URL" "$REPO" || fail "Clone fehlgeschlagen"
fi

log "Hole $REMOTE/$BRANCH …"
git -C "$REPO" fetch -q --depth 50 "$REMOTE" "$BRANCH" 2>/dev/null || git -C "$REPO" fetch -q "$REMOTE" "$BRANCH" || {
  warn "fetch fehlgeschlagen - vermutlich kein Netz. Dieser Lauf endet hier."
  exit 0
}
TARGET="$(git -C "$REPO" rev-parse "$REMOTE/$BRANCH" 2>/dev/null)"
[ -n "$TARGET" ] || { warn "Konnte $REMOTE/$BRANCH nicht aufloesen."; exit 0; }
CURRENT="$(installed_commit)"
LOCAL="$(git -C "$REPO" rev-parse HEAD 2>/dev/null || echo '')"

if [ "$TARGET" = "$CURRENT" ]; then
  log "Aktuell: ${TARGET:0:8} - nichts Neues."
  exit 0
fi

log "Neuer Commit: ${CURRENT:-—} -> ${TARGET:0:8}"
if [ -n "$TARGET" ]; then
  log "  $(git -C "$REPO" log -1 --format='%s' "$TARGET")"
  log "  $(git -C "$REPO" log -1 --format='%ci' "$TARGET")"
fi

if [ "$CHECK_ONLY" = "1" ]; then
  log "--check: nichts ausgefuehrt."
  exit 0
fi

# ---------------------------------------------------------------
# 4. Auschecken
# ---------------------------------------------------------------
# Hard reset auf den Zielstand: lokale Aenderungen im Arbeitsverzeichnis
# wuerden den naechsten Lauf in einen Zustand bringen, den niemand
# nachvollziehen kann - und der Build koennte sie ungefragt ausliefern.
git -C "$REPO" checkout -q --force "$TARGET" || fail "Checkout fehlgeschlagen"
git -C "$REPO" reset -q --hard "$TARGET"
git -C "$REPO" clean -qfd -e dist
log "Ausgecheckt: ${TARGET:0:8}"

# ---------------------------------------------------------------
# 5. Bauen
# ---------------------------------------------------------------
log "Baue dist/ …"
BUILD_LOG=$(mktemp)
if ! (cd "$REPO" && npm run build) >"$BUILD_LOG" 2>&1; then
  fail "Build fehlgeschlagen - alter Stand bleibt aktiv."
  tail -25 "$BUILD_LOG" >&2
  rm -f "$BUILD_LOG"
  exit 1
fi
rm -f "$BUILD_LOG"
[ -s "$REPO/dist/index.html" ] || { fail "dist/index.html fehlt nach dem Build."; exit 1; }
log "Build ok ($(du -sh "$REPO/dist" | cut -f1))"

# ---------------------------------------------------------------
# 6. Tests
# ---------------------------------------------------------------
if [ "$SKIP_TESTS" = "1" ]; then
  warn "Tests uebersprungen (--skip-tests)"
else
  log "Tests …"
  T_LOG=$(mktemp)
  TEST_FAIL=0
  (cd "$REPO" && npm test) >"$T_LOG" 2>&1 || TEST_FAIL=1
  (cd "$REPO" && node --test server/test/server.test.js \
                         server/test/security.test.js \
                         server/test/share-kinds.test.js \
                         server/test/share-code.test.js) >>"$T_LOG" 2>&1 || TEST_FAIL=1
  (cd "$REPO" && node server/test/http.test.js) >>"$T_LOG" 2>&1 || TEST_FAIL=1
  (cd "$REPO" && node server/test/mcp-http.test.js) >>"$T_LOG" 2>&1 || TEST_FAIL=1
  if [ "$TEST_FAIL" = "1" ]; then
    fail "Tests fehlgeschlagen - alter Stand bleibt aktiv."
    grep -E "^\s*(not ok|# fail|fail [1-9])|AssertionError|ERGEBNIS: [0-9]" "$T_LOG" | head -20 >&2
    rm -f "$T_LOG"
    exit 1
  fi
  rm -f "$T_LOG"
  log "Tests ok"
fi

# ---------------------------------------------------------------
# 7. Deployen, mit Rückfallmöglichkeit
# ---------------------------------------------------------------
log "Sichere laufenden Stand …"
rm -rf "$PREV"
if [ -d "$LIVE" ]; then
  cp -a "$LIVE" "$PREV" || { fail "Sicherung fehlgeschlagen"; exit 1; }
fi

log "Deploye Server + dist/ …"
install -d -m 755 "$LIVE/server"
install -m 644 "$REPO"/server/*.js "$LIVE/server/"
install -m 644 "$REPO/server/schema.sql" "$LIVE/server/"
install -m 644 "$REPO/server/gc.js"    "$LIVE/gc.js"
install -m 644 "$REPO/server/schema.sql" "$LIVE/schema.sql"

# Der MCP-Kern. server/mcp.js laedt ihn ueber "../mcpserver/content";
# fehlt das Verzeichnis, startet der Dienst nicht. Das faellt erst beim
# Neustart auf - der Health-Check hier unten faengt es dann ab.
install -d -m 755 "$LIVE/mcpserver"
install -m 644 "$REPO"/mcpserver/*.js "$LIVE/mcpserver/"

# dist/ wird komplett ersetzt, nicht hinuebergelegt. Sonst bleiben alte
# Bundle-Dateien liegen; sie sind zwar nur unbenutzter Speicher, aber der
# Service Worker kann sie noch aus dem Cache anbieten.
rm -rf "$LIVE/dist"
install -d -m 755 "$LIVE/dist"
cp -a "$REPO/dist/." "$LIVE/dist/"

chown -R federwerk:federwerk "$LIVE"
log "Starte Dienst neu …"
systemctl restart federwerk.service || warn "restart meldete einen Fehler, Health entscheidet"

# ---------------------------------------------------------------
# 8./9. Health pruefen, sonst zurueckrollen
# ---------------------------------------------------------------
HEALTHY=0
for _ in $(seq 1 30); do
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then HEALTHY=1; break; fi
  sleep 0.5
done

if [ "$HEALTHY" != "1" ]; then
  fail "Health fehlgeschlagen - rolle auf ${CURRENT:-—} zurueck."
  systemctl stop federwerk.service 2>/dev/null
  rm -rf "$LIVE"
  [ -d "$PREV" ] && cp -a "$PREV" "$LIVE"
  systemctl start federwerk.service
  sleep 3
  if curl -fsS "http://127.0.0.1:${PORT}/api/health" >/dev/null 2>&1; then
    warn "Rollback erfolgreich. Der neue Stand ${TARGET:0:8} ist NICHT aktiv."
    warn "Journal: journalctl -u federwerk -n 40"
    exit 1
  fi
  fail "Auch der Rollback laeuft nicht. Handarbeit noetig - journalctl -u federwerk -n 60"
  exit 1
fi

node -e '
const fs = require("fs");
fs.writeFileSync(process.argv[1], JSON.stringify({
  commit: process.argv[2],
  at: new Date().toISOString(),
}, null, 2));
' "$STATE" "$TARGET"

log "Aktiv: ${TARGET:0:8} - $(git -C "$REPO" log -1 --format='%s' "$TARGET")"
log "Health: $(curl -fsS "http://127.0.0.1:${PORT}/api/health")"
log "Fertig."