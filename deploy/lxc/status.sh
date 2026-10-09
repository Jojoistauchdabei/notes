#!/usr/bin/env bash
# Abschlusspruefung: alles auf einmal, mit sauberer Ausgabe.
echo "================= DIENSTE ================="
for u in federwerk.service federwerk-files.service federwerk-backup.timer federwerk-gc-report.timer actions-runner.service; do
  printf '  %-32s %-9s %s\n' "$u" "$(systemctl is-enabled $u 2>&1)" "$(systemctl is-active $u 2>&1)"
done
printf '  %-32s %-9s %s\n' federwerk-gc-apply.service "$(systemctl is-enabled federwerk-gc-apply.service)" "nur auf Zuruf"

echo
echo "================= SUDO FUER RUNNER ================="
su runner -s /bin/bash -c 'sudo -n -l' 2>&1 | tail -3 | sed 's/^/  /'
echo "  -- Aufruf mit gueltigem Pfad (soll 'Quelle ... nicht im Arbeitsverzeichnis' sagen):"
su runner -s /bin/bash -c 'sudo -n /bin/bash /srv/federwerk/deploy.sh /tmp/falsch' 2>&1 | head -2 | sed 's/^/    /'

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
echo "================= WAS NOCH FEHLT ================="
[ -f /opt/actions-runner/.runner ] && echo "  Runner: registriert" || echo "  Runner: NICHT registriert (Token fehlt)"
TOK=$(sed -n 's/^TUNNEL_TOKEN=//p' /etc/federwerk/tunnel.env 2>/dev/null | tr -d '"\r\n ')
[ -n "$TOK" ] && echo "  Tunnel: Token gesetzt" || echo "  Tunnel: Token fehlt in /etc/federwerk/tunnel.env"
curl -fsS http://127.0.0.1:8080/ >/dev/null 2>&1 && echo "  App-Shell: ausgeliefert" || echo "  App-Shell: FEHLT"
grep -rqs "fra.cloud.appwrite.io" /srv/federwerk/app/dist/ && echo "  Frontend: spricht NOCH Appwrite an (Client-Transport nicht umgestellt)" || echo "  Frontend: kein Appwrite mehr"