# Federwerk im LXC (Proxmox)

Der Server ersetzt Backend und CDN: er liefert die statische App **und** die
API unter derselben Adresse. Aufbau und Begründungen stehen in
[SPEC-41](../../specs/41-lxc-selbsthosting.md) – hier steht nur, was man der
Reihe nach tut.

## 1. Grundinstallation

```bash
ssh root@<lxc> 'bash -s' < deploy/lxc/bootstrap.sh
```

Legt Node 24 (wegen `node:sqlite`), den System-User `federwerk` und
`/srv/federwerk/{app,data,data/users,files,backups}` an. `bootstrap.sh` ist
idempotent; der Dienst startet bewusst noch nicht.

## 2. Dateiablage (QNAP)

Der CIFS-Mount kommt vom **Proxmox-Host** (`lxc.mount.entry` in
`/etc/pve/lxc/<ctid>.conf`) und ist im Container schon als
`/mnt/qnap/federwerk` sichtbar. Im Container wird er nur durchgereicht:

```bash
sudo bash deploy/lxc/bind-files.sh      # bindet /mnt/qnap/federwerk/blobs -> /srv/federwerk/files
```

Fehlt der Host-Mount, bricht das Skript ab – mit Absicht: ein blinder Bind
würde auf die lokale Platte schreiben, und die Dateien wären beim nächsten Boot
weg. `deploy/lxc/federwerk-files.service` hängt daran, und
`federwerk.service` startet per `Requires=` erst danach.

## 3. systemd-Units

```bash
sudo bash deploy/lxc/install-units.sh
```

Installiert `federwerk.service`, `federwerk-backup.{service,timer}` und legt
`/etc/federwerk/env` (0600) mit einem frischen `FW_SESSION_SECRET` an. Das
Secret wird bei erneutem Aufruf **nicht** angefasst: ein Neustart darf keine
laufenden Sessions entwerten.

`/etc/federwerk/env`:

| Variable | Bedeutung |
| --- | --- |
| `FW_DATA_DIR` | SQLite-Ablage (`auth.db`, `social.db`, `users/<id>/docs.db`). Muss lokal liegen, nicht auf dem Share. |
| `FW_FILES_DIR` | Heiße Dateiablage (`<sha256>.<ext>`), im Betrieb der Bind aus Schritt 2. |
| `FW_BACKUP_DIR` | Ziel der Snapshots (`deploy/lxc/backup.js`). |
| `FW_HOST` | `0.0.0.0`, damit Geräte im LAN den Dienst erreichen. Nur lokal/Proxy: `127.0.0.1`. |
| `FW_PORT` | Standard `8080`. |
| `FW_SESSION_SECRET` | Pflicht. Wird von `install-units.sh` erzeugt. |
| `FW_PUBLIC_URL` | Optional: öffentliche Adresse hinter einem Reverse-Proxy. Erlaubt genau diese Herkunft für CORS und schaltet das `Secure`-Flag am Session-Cookie ein. |
| `FW_ARCHIVE_DIR` | Optional: Kalt-Ablage für `server/gc.js`. Ohne Angabe bleibt alles in `FW_FILES_DIR`. |

## 4. Deploy

```bash
sudo bash deploy/lxc/deploy-app.sh /pfad/zum/checkout     # kopiert server/ + dist/ und startet neu
```

`dist/` vorher mit `npm run build` erzeugen (bzw. aus dem Release-ZIP
`Federwerk-<tag>-web.zip` entpacken). Der Deploy ist additiv – er löscht keine
Dateien, die er nicht kennt, und prüft am Ende `/api/health`.

Automatisch läuft derselbe Weg bei jedem Push auf `main` über
`.github/workflows/deploy-selfhost.yml` auf einem self-hosted Runner im
Container (`deploy/lxc/setup-runner.sh`).

## 5. Timer und Prüfung

- `federwerk-backup.timer` – SQLite-Snapshots, Aufbewahrung über
  `FW_BACKUP_KEEP_DAYS` in `/etc/federwerk/backup.env`.
- `federwerk-gc-report.timer` – meldet, welche Dateien verwaist sind.
- `federwerk-gc-apply.service` – führt das Aufräumen nur auf Zuruf aus.

```bash
bash deploy/lxc/status.sh                 # Dienste, Ablage, Timer, Health
curl -s http://127.0.0.1:8080/api/health
```

## 6. TLS (optional)

Ohne vorgeschalteten Proxy läuft alles über HTTP im LAN. Wer TLS will, stellt
nginx oder Caddy vor Port 8080 und setzt `FW_PUBLIC_URL=https://…`; der Server
selbst muss davon nichts wissen. Der Origin-Check in `server/index.js` erlaubt
dann genau diese eine zusätzliche Herkunft.
