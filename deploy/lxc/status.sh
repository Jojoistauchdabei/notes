#!/usr/bin/env bash
# Abschlusspruefung: alles auf einmal, mit sauberer Ausgabe.
echo "================= DIENSTE ================="
for u in federwerk.service federwerk-files.service federwerk-backup.timer federwerk-gc-report.timer actions-runner.service; do
  printf '  %-32s %-9s %s\n' "$u" "$(systemctl is-enabled $u 2>&1)" "$(systemctl is-active $u 2>&1)"
done
printf '  %-32s %-9s %s\n' federwerk-gc-apply.service "$(systemctl is-enabled federwerk-gc-apply.service)" "nur auf Zuruf"

echo
echo "================= SUDO FUER RUNNER ================="
# Ohne Argument aufrufen: die sudoers-Regel laesst genau
# /srv/federwerk/deploy.sh zu, und eine Regel mit Argumenten verlangt eine
# exakte Uebereinstimmung. Ein Test mit Argumenten wuerde "password required"
# melden, obwohl die Regel in Ordnung ist.
su runner -s /bin/bash -c 'sudo -n -l' 2>&1 | grep -E "may run|NOPASSWD" | sed 's/^/  /'
echo "  Probe (ohne Checkout, muss sauber scheitern):"
su runner -s /bin/bash -c 'sudo -n /bin/bash /srv/federwerk/deploy.sh' 2>&1 | head -1 | sed 's/^/    /'

echo
echo "================= SERVER ================="
curl -s http://127.0.0.1:8080/api/health | sed 's/^/  /'
echo
echo "  Nutzerordner:"
ls -1 /srv/federwerk/data/users/ 2>/dev/null | sed 's/^/    /'

echo
echo "================= ABLAUF AUF DEM QNAP ================="
echo "  Quelle: $(findmnt -no SOURCE,FSTYPE /mnt/qnap/federwerk 2>/dev/null || echo 'NICHT GEMOUNTET')"
echo "  Bind:   $(findmnt -no SOURCE /srv/federwerk/files 2>/dev/null || echo 'NICHT GEBUNDEN')"
du -sh /mnt/qnap/federwerk/* 2>/dev/null | sed 's/^/  /'

echo
echo "================= TIMER ================="
systemctl list-timers --no-pager --no-legend 2>/dev/null | grep -i federwerk | sed 's/^/  /'

echo
echo "================= AUTO-UPDATE ================="
if [ -f /srv/federwerk/deployed.json ]; then
  node -e '
    const s = require("/srv/federwerk/deployed.json");
    const t = new Date(s.at);
    console.log("  aktiv:      " + s.commit.slice(0,8) + "  (" + t.toLocaleString("de-DE") + ")");
    const ageH = (Date.now() - t.getTime()) / 3600000;
    if (ageH > 48) console.log("  WARNUNG:    letztes Update vor " + Math.round(ageH) + " Stunden");
  ' 2>/dev/null || echo "  deployed.json unlesbar"
  echo "  Repo-HEAD:  $(git -C /srv/federwerk/repo log -1 --format='%h %s' 2>/dev/null || echo 'n/a')"
  echo "  neuer:      $(git -C /srv/federwerk/repo fetch -q origin main 2>/dev/null; git -C /srv/federwerk/repo log -1 --format='%h' origin/main 2>/dev/null || echo 'n/a')"
else
  echo "  kein deployed.json - Auto-Update lief noch nie"
fi
systemctl list-timers federwerk-autoupdate.timer --no-pager --no-legend 2>/dev/null | sed 's/^/  /'
echo "  Rollback-Kopie: $(du -sh /srv/federwerk/previous 2>/dev/null | cut -f1 || echo keine)"
echo "  letzter Lauf:"
journalctl -u federwerk-autoupdate -n 6 --no-pager 2>/dev/null | sed 's/^/    /'

echo
echo "================= WAS NOCH FEHLT ================="
[ -f /opt/actions-runner/.runner ] && echo "  Runner: registriert" || echo "  Runner: NICHT registriert (Token fehlt)"
[ -f /etc/federwerk/tunnel.env ] && echo "  Tunnel:     wird im anderen LXC betrieben" || echo "  Tunnel:     kein tunnel.env hier (geplant: eigener LXC)"
curl -fsS http://127.0.0.1:8080/ >/dev/null 2>&1 && echo "  App-Shell:  ausgeliefert" || echo "  App-Shell:  FEHLT"

# Gegenprobe auf die alte Cloud: im ausgelieferten Bundle darf kein
# Appwrite-Endpunkt mehr stehen. Sonst redet die App weiter zu Cloudflare
# und wundert sich ueber 404 des eigenen Servers.
BUNDLE=$(ls /srv/federwerk/app/dist/js/app.bundle.*.js 2>/dev/null | head -1)
if [ -n "$BUNDLE" ]; then
  # grep -c gibt bei null Treffern Exit-Code 1 - mit "|| echo 0" haengt dann
  # eine zweite Null an. Ueber wc -l zaehlen, das immer 0 liefert und nie
  # den Status veraendert.
  AW=$(grep -o -e 'appwrite\.io' -e 'tablesdb' -e 'X-Appwrite' "$BUNDLE" 2>/dev/null | wc -l | tr -d ' ')
  API=$(grep -o 'federwerkApiV1' "$BUNDLE" 2>/dev/null | wc -l | tr -d ' ')
  echo "  Frontend:   Appwrite-Refs=$AW  api.js=$API $([ "$AW" = "0" ] && [ "$API" -gt 0 ] && echo '(ok)' || echo '(PRUEFEN)')"
else
  echo "  Frontend:   Bundle nicht gefunden"
fi