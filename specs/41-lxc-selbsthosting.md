# SPEC-41 – Selbsthosting im LXC (ohne Appwrite und Cloudflare)

**Status:** umgesetzt
**Betrifft:** `server/`, `js/api.js`, `js/sync.js`, `js/files-sync.js`,
`mcpserver/`, `deploy/lxc/`, `.github/workflows/`

## 1. Warum

Federwerk lief als Cloudflare-Worker (Static Assets + ein MCP-Worker) und
nutzte Appwrite als Backend: die Tabellen `notes`/`folders` für Dokumente und
Ordner, den Bucket `attachments` für Bilder/PDFs, die Tabellen
`shares`/`share_events` für Liveshare. Der Ausgang nach draußen war ein
Cloudflare-Tunnel (`cloudflared`) im Container.

Beides fällt weg. Die App läuft vollständig auf einem LXC in Proxmox; es gibt
keinen Cloud-Anbieter mehr, keine Tunnel-Binärdatei, keinen zweiten
Deploy-Pfad. Das ist nicht nur eine Abhängigkeit weniger: mit Appwrite lagen
die Nutzerdaten bei einem Drittanbieter, und jede Änderung am Datenmodell
brauchte dessen Console.

## 2. Zielbild (Datenhaltung)

```
auth.db                    users + sessions        <- Login, Konten
social.db                  shares + share_events   <- nutzerübergreifend
users/<id>/docs.db         docs + folders          <- Dokumente (SQLite pro Nutzer)
                           files + file_refs       <- Datei-Verzeichnis + Referenzen
<files>/                   <sha256>.<ext>          <- Bild-/PDF-Bytes, content-adressiert
```

- **SQLite pro Nutzer** (`users/<id>/docs.db`): Dokumente, Ordner, Datei-Ablage.
  Die Isolation fällt nebenbei ab – ein Nutzer kann strukturell nicht in fremde
  Daten lesen, weil sein Handle nur auf sein eigenes File zeigt.
- **Eine DB für Nutzer** (`auth.db`): `users` (E-Mail, scrypt-Hash) und
  `sessions` (Token-Hash, Ablauf). Bewusst flach und getrennt von den
  Nutzer-DBs: beim Login muss das Passwort ohne Umweg über alle Nutzer-DBs
  gefunden werden.
- **Getrennte DB für Freigaben** (`social.db`): Freigaben sind die einzige
  Datenklasse, die per Definition nutzerübergreifend ist (Gast ≠ Besitzer).
- **Dateien** liegen content-adressiert unter ihrem SHA-256; `files.status`
  unterscheidet `hot`/`cold`, `file_refs` beantwortet „wird diese Datei noch
  benutzt?“ für den GC.

SQLite bleibt auf der lokalen Platte. Auf der QNAP-Ablage (CIFS ohne
POSIX-Semantik und ohne Byte-Range-Locks) würde das Locking- und
Journal-Verhalten nicht tragen, auf das SQLite sich verlässt.

## 3. Zielbild (Client und Transport)

- `js/api.js` ist der **einzige** Transport: Same-Origin-HTTP gegen
  `/api/*`. Session als HttpOnly-Cookie – kein Secret im `localStorage`,
  kein `X-Appwrite-Session`-Kopf, kein Cookie-Fallback für fremde Origins.
- `js/sync.js` (früher `appwrite-sync.js`): Notizen/Ordner-Sync
  (push/pull, Tombstones, Konflikte) über `/api/docs` und `/api/folders`.
- `js/files-sync.js` (früher `appwrite-files.js`): Datei-Sync mit
  SHA-256-Dedupe und Recompress über `/api/files`.
- `js/liveshare.js`: Freigaben über `/api/shares`, Live-Kanal als SSE
  (`/api/events`) statt Appwrite-Realtime-WebSocket.
- Der Inhalt eines Dokuments liegt **inline** im Dokument – die frühere
  40-KB-Auslagerung war allein Appwrites 64-KB-Zeilenlimit geschuldet.

Das Referenzformat `awfile:<sha256>` für Bild-Refs bleibt unverändert: der
Wert ist ein undurchsichtiger interner Tag und steckt in bereits geschriebenen
Dokumenten. Er ist keine Appwrite-Abhängigkeit, sondern nur ein Name.

## 4. Was entfernt wurde

| Entfernt | Grund |
| --- | --- |
| `worker.js`, `wrangler.toml` | Cloudflare-Worker (Static Assets + MCP) |
| `functions/share-events-guard/` | Appwrite Function als Liveshare-Guard |
| `mcp/` | MCP-Server als Appwrite Function |
| `deploy/lxc/federwerk-tunnel.service`, `setup-tunnel.sh` | Cloudflare-Tunnel |
| `scripts/build-mcp.js`, `scripts/setup-liveshare.js` | Deploy/Setup gegen Appwrite |
| `dist/_headers` (Build) | Cloudflare-Header-Format; der Node-Server setzt Header selbst |
| `CLOUDFLARE_*`-Secrets/-Steps in den Workflows | Deploy lief über `wrangler` |

Der Liveshare-Guard entfällt, weil der Server die Prüfung im selben Prozess
macht: die Freigabe muss existieren, nicht widerrufen und nicht abgelaufen
sein – genau auf dem Weg, den der Aufruf nimmt. Ein zusätzlicher Proxy könnte
diese Prüfung nur umgehen.

## 5. MCP

`mcpserver/` bleibt der lokale MCP-Server (stdio/HTTP). Sein Backend spricht
statt Appwrite-REST jetzt die eigene Server-API (`/api/auth/*`, `/api/docs`,
`/api/folders`) und nutzt dieselben Content-Envelopes (v1 für Notizbücher,
v2 für Decks). Anmeldedaten kommen aus `FEDERWERK_URL`,
`FEDERWERK_EMAIL`/`FEDERWERK_PASSWORD` oder `FEDERWERK_SESSION` bzw. aus
`~/.config/federwerk/mcp-credentials.json`.

## 6. Erreichbarkeit

Ohne Tunnel muss der Server auf der Netzwerkschnittstelle lauschen
(`FW_HOST=0.0.0.0`), damit Geräte im LAN ihn erreichen. Die Sicherheitsgrenze
ist die Authentifizierung (scrypt, HttpOnly-Cookie, SameSite=Lax) plus der
Origin-Check in `server/index.js`. Wer TLS will, stellt einen Reverse-Proxy
(nginx/Caddy) davor und setzt `FW_PUBLIC_URL`; der Prozess selbst muss davon
nichts wissen.

## 7. Nicht-Ziele

- Kein Migrationswerkzeug für bestehende Appwrite-Bestände. Wer Daten
  umziehen will, exportiert sie als JSON aus der App und importiert sie neu.
- Kein Mehrserver-Betrieb, kein Load-Balancing: ein Container, eine DB-Datei
  pro Nutzer, WAL an.
