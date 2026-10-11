# Federwerk

[![CI – Tests](https://github.com/Jojoistauchdabei/notes/actions/workflows/ci.yml/badge.svg)](https://github.com/Jojoistauchdabei/notes/actions/workflows/ci.yml)

Handschrift-Notizbuch im Papier-Stil: Stift, Marker, Radierer, Textboxen mit Rich-Text-Editor, Bilder, Seiten mit Thumbnails. Das Dokument wird **durchgängig gescrollt** (alle Seiten in einem Stack, keine Seitenwechsel-Gesten – siehe [SPEC-37](specs/37-continuous-scroll-dokument.md)). Mehrere Dokumente, JSON-Einzel-/Gesamt-Export, **GoodNotes-Import (`.goodnotes`)**. Lokal im Browser, offline-fähig (PWA).

Einfach `index.html` öffnen oder hosten – kein Build, kein Server nötig. Wer
zwischen Geraeten synchronisieren und Liveshare nutzen will, betreibt den
eigenen Server (`server/`) auf einem LXC: siehe [Selbsthosting](#selbsthosting-lxc).

## Releases: Web, Desktop & Android (mit Autoupdate)

`dist/` ist nur ein lokales Build-Artefakt (`npm run build`) und wird nicht
eingecheckt. Jedes GitHub Release enthält:
- `Federwerk-vX.Y.Z-web.zip` – die statische App (entpacken und ins `dist/`
  des LXC legen, siehe `deploy/lxc/README.md`),
- Linux: `.deb`, `.AppImage`, `.rpm` – Windows: `-setup.exe`, `.msi`,
- Android: universelles `.apk` (GitHub-Verteilung, kein Play Store),
- `latest.json` + Signaturen fürs Desktop-Autoupdate.

Autoupdate: Desktop prüft beim Start via `latest.json` und installiert still
(Rust, `src-tauri/`); Android/Web zeigen bei neuer Version einen Banner
(`js/updater.js`, APK-Download bzw. Neuladen).

Release auslösen: Jeder Push auf `main` legt automatisch ein Release an
(Version aus `package.json`, belegter Tag → Patch wird hochgezählt; für
Minor/Major vorher `package.json` erhöhen + `npm run sync-version`),
manuell via Actions → „Auto-Release", oder Release im Web-UI anlegen.
Opt-out per Commit: `[skip release]` in der Commit-Message.

Einmalig nötige Secrets (Repo → Settings → Secrets and variables → Actions):
`TAURI_SIGNING_PRIVATE_KEY` (Inhalt von `src-tauri/updater-key`, nie committen);
optional für stabile Android-Updatekette: `ANDROID_KEYSTORE_BASE64`,
`ANDROID_KEYSTORE_PASSWORD`, `ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD`
(ohne sie: Debug-APK). Für den Web-Deploy auf den LXC ist kein Cloud-Secret
nötig – der läuft über einen self-hosted Runner (`deploy-selfhost.yml`).

## Build (`npm run build`)

`npm run build` erzeugt ein auslieferbares `dist/` (~0,9 MB statt ~3,5 MB).
Ausgeliefert wird es vom Node-Server (`server/index.js`), der MIME, Cache und
Sicherheits-Header selbst setzt – eine Header-Datei neben dem Build gibt es
nicht mehr:

- `altes_Papier.png` (2,5 MB) bleibt Quell-Asset, im Build kommt nur die
  Papier-Textur als WebP (95K) + JPEG-Fallback (176K) mit – `css/styles.css`
  wählt per `image-set` automatisch das Format des Browsers.
- Die 26 Seiten-Skripte aus `index.html` werden zu **einem** gehashten Bundle
  (`js/app.bundle.<hash>.js`, minifiziert), die 27 HTTP-Requests entfallen.
  `js/gnpdf-worker.js` bleibt separat (wird per `new Worker(...)` geladen).
- Gehashte Dateien (Bundle, CSS, Papierbilder) erkennt der Server am Namen und
  schickt `Cache-Control: public, max-age=31536000, immutable`; `index.html`,
  `sw.js` und das Manifest bleiben `must-revalidate`, damit Releases sofort
  ankommen (`serveStatic` in `server/index.js`).
- `dist/sw.js` precacht nur noch die App-Shell (11 Dateien), nicht mehr
  Screenshots/Doku.

Minifiziert wird mit esbuild über `npx`; ohne Netz baut `npm run build` ohne
Minifizierung weiter, Bundle/Hash/Caching
greifen trotzdem.

## Design-Themes

Die App bringt 16 Designs mit. Standard ist **Papier** (unverändert: warme
Tinte, Ocker, Serifenschrift, Papier-Textur, folgt wie bisher dem System).
Darueber 15 Design-Varianten – Buntstift, Terminal, Zen, Neo-Brutalismus,
Editorial, Neon-Glas, Blueprint, Botanisch, Skeuomorph, Swiss sowie fuenf
Mischungen. Umschalten ueber das **🎨-Feld in der Kopfzeile**; Helligkeit
( Wie das System / Hell / Dunkel ) laesst sich pro Theme frei waehlen und
wird gemerkt (`localStorage`: `fw-theme`, `fw-scheme`).

Aufbau:

- `js/themes.js` – Auswahl, Nachladen, Speichern. Laeuft **synchron im
  `<head>`**, damit die Seite beim Start nicht kurz im Standard-Design
  aufblitzt. Benoetigt ein Attribut (`data-boot`), damit `build-dist.js` es
  nicht in das `defer`-Bundle zieht. Steht im `sw.js`-Precache, ist also
  offline vorhanden; ohne die Datei gaebe es gar kein Theme-System.
- `css/themes/_shared.css` – Adapter. Hebt die in `styles.css`
  **hartkodierten** Werte (Web-Fonts, `.btn-export`-Farben, `.stage`-Papier,
  `.text-box`-Tinte, Ordner-Baum-Brauntoene) auf Design-Tokens. Auf
  Nicht-Papier-Themen eingeschraenkt: `styles.css` beschreibt das
  Standard-Design bereits vollstaendig, und der Adapter darf es nicht
  veraendern.
- `css/themes/<design>.css` – je Design nur die Tokens (hell + dunkel) und
  eine kurze Signatur mit dem, was es vom Adapter abweichend will.
- `css/themes/papier.css` – **erzeugt**, nicht von Hand pflegen: spiegelt die
  `:root`-Tokens aus `styles.css`, damit auch das Standard-Design die
  Hell/Dunkel-Schaltung befolgt. Nach jeder Aenderung an den Tokens in
  `styles.css`: `npm run sync-paper-theme`. Ein Test (`--check`) verhindert,
  dass die beiden auseinanderlaufen.

Reihenfolge im Dokument: `styles.css` -> `_shared.css` -> `<design>.css`.
Geladen wird erst beim Auswaehlen; im Standard kommen nur 3 KB
(`papier.css`) extra dazu, die 15 Designs liegen ungenutzt auf der Platte
und werden vom Service Worker nach dem ersten Gebrauch gecacht.

Direktaufruf zum Ansehen/Verlinken, ohne die eigene Auswahl zu aendern:
`index.html?theme=12-herbarium&scheme=hell` (`scheme` = `hell|dunkel|auto`).
Geprueft von `tests/themes.test.js` (12 Tests).

## Speicher (IndexedDB + Bild-Blobs)

Der State (klein) liegt in IndexedDB (`grimoire-db`) plus localStorage-Backup; Bild-Bytes und PDF-Hintergründe liegen als Blobs separat in IndexedDB, im State steht nur eine kurze `blob:<id>`-Referenz. Das 5MB-localStorage-Limit greift damit nicht mehr. Beim ersten Start migriert die App bestehende Daten automatisch (Zähler in der Statuszeile). JSON-Export enthält weiter portable dataURLs (`inlineBook`/`extractBook` in `js/store.js`).

Der Sync gegen den eigenen Server liegt in `js/sync.js` (Notizen und Ordner:
Push/Pull, Tombstones, Konfliktkopien) und `js/files-sync.js` (Bilder/PDFs mit
SHA-256-Dedupe und Recompress). Beides spricht ausschließlich `js/api.js`, den
einen Transport gegen `/api/*`. **Liveshare** (Share-Link mit Lesen/Edit +
Ablauf, Live-Cursor, LWW pro Stroke) nutzt dieselbe API – Freigaben prüft
`server/shares.js`, der Live-Kanal ist SSE (`/api/events`); siehe
[SPEC-36](specs/36-liveshare.md).

## Selbsthosting (LXC)

Sync, Konten und Liveshare laufen auf einem eigenen Server in einem LXC
(Proxmox). Keine Cloud, kein Drittanbieter, keine Tunnel-Binärdatei: der
Node-Server (`server/`) liefert die App aus **und** die API, beides unter
derselben Adresse.

- **Ablage:** `auth.db` (`users` + `sessions`, scrypt, HttpOnly-Cookie),
  `users/<id>/docs.db` (Dokumente, Ordner, Datei-Ablage – eine SQLite-Datei pro
  Nutzer) und `social.db` (`shares` + `share_events`, weil Freigaben
  nutzerübergreifend sind). Dateien liegen content-adressiert unter
  `<sha256>.<ext>`; `server/gc.js` räumt per Timer auf (hot/cold).
- **Keine Dependencies:** `node:http` + `node:sqlite` (Node 24), kein Express,
  kein `node_modules` auf dem Container.
- **Erreichbarkeit:** `FW_HOST=0.0.0.0`, `FW_PORT=8080`. Absicherung ist die
  Authentifizierung plus Origin-Check in `server/index.js`, nicht das Interface.
  Wer TLS will, stellt einen Reverse-Proxy (nginx/Caddy) davor und setzt
  `FW_PUBLIC_URL`.
- **Deploy:** `deploy/lxc/` (bootstrap, systemd-Units, QNAP-Bind, Backup-Timer)
  und `.github/workflows/deploy-selfhost.yml` über einen self-hosted Runner.

Schritt für Schritt: [`deploy/lxc/README.md`](deploy/lxc/README.md).
Aufbau und Begründungen: [SPEC-41](specs/41-lxc-selbsthosting.md).


## Markdown-Editor (Live-Vorschau)

Eigene Seite **✎ Markdown** in der Kopfzeile (siehe
[SPEC-39](specs/39-markdown-editor.md)) – ein vollwertiger Markdown-Editor mit
Live-Vorschau nach dem markText-Prinzip: getippt wird das gerenderte Dokument,
die Markdown-Zeichen (`**`, `## `, `[[`, …) sind in `contenteditable="false"`-
Spans versteckt und erscheinen nur im Block, in dem der Cursor steht.

- **Parser** ist [markdown-wasm](https://github.com/rsms/markdown-wasm)
  (WebAssembly, CommonMark + GFM: Tabellen, Strikethrough, Aufgabenlisten,
  Autolinks). Liegt **vendored** unter `js/vendor/` (MIT, `markdown.js` +
  `markdown.wasm`, ~65 KB) – kein CDN, kein `node_modules`, offline, kein Build.
  Die Tests laden denselben Build per `require()`, deshalb braucht `npm test`
  weiterhin keine Installation.
- **OFM-Layer** wie in den Textboxen (SPEC-13): `[[Wikilink]]`, `[[Ziel|Alias]]`,
  `![[bild.png|300]]`, `> [!note]`-Callouts mit `-`/`+`-Faltung, `==Highlight==`,
  `%%Kommentar%%` und die halbe Aufgabe `- [/]`.
- **Drei Ansichten**: ✎ Live (WYSIWYG), ⌨ Quelle (Textarea, Strg+E), 👁 Lesen
  (Druck/PDF). Beim Tippen wird nie neu gerendert – die Quelle wird aus der DOM
  serialisiert (`serialize()` in `js/md-render.js`); neu gerendert wird nur an
  sicheren Stellen (Moduswechsel, `Esc`, Blur, Einfügen, Werkzeugleiste), und
  der Cursor kehrt über Blockindex + Textoffset zurück.
- **Dokumente** in IndexedDB `fw-md` (`js/md-store.js`), getrennt vom Notizbuch,
  damit Markdown-Dateien nicht im Buch-Export landen. Import/Export als `.md`,
  Gliederung, Wort-/Zeichen-/Lesezeit, Klick auf Aufgaben-Kästchen (offen →
  erledigt → halb), Wikilink-Klick legt fehlende Notizen an.
- `js/markdown.js` (Renderer der Textboxen im Notizbuch) bleibt unangetastet –
  Begründung in SPEC-39 § 7.

## Tests

```bash
npm test                                    # App-Tests, inkl. GoodNotes-Konformanz
node --test server/test/server.test.js      # Server-Tests (SQLite, Auth, Shares)
node server/test/http.test.js               # HTTP-Rundlauf gegen einen echten Server
```

`npm test` läuft automatisch bei jedem Push/PR auf `main`
(`.github/workflows/ci.yml`, Node 20 + 22); die Server-Tests laufen im
Deploy-Workflow (`deploy-selfhost.yml`) mit, bevor ausgeliefert wird.

## MCP (KI-Zugang: lesen + schreiben)

Federwerk hat einen echten MCP-Server (JSON-RPC 2.0, 24 Tools): Notizen
anlegen/bearbeiten/löschen, Ordner verwalten, Karteikarten-Decks inkl.
SM-2-Bewertung, Query-Suche und Wikilink-Graph – für Claude Desktop, Cursor,
Opencode u. a. Er läuft lokal per `node mcpserver/cli.js` (stdio oder `--http`)
und spricht die eigene Server-API; die Anmeldung kommt aus `FEDERWERK_URL` +
`FEDERWERK_EMAIL`/`FEDERWERK_PASSWORD` (oder `FEDERWERK_SESSION`) bzw. aus
`node mcpserver/login.js --email … --save`.

- `/agent` – Anleitungsseite für Nutzer (auch aus der App verlinkt)
- `/mcp` – Markdown-Anleitung für KI-Modelle (Installation + Nutzung)

Vollständige Doku: [`docs/mcp.md`](docs/mcp.md), KI-Version:
[`MCP_AI.md`](MCP_AI.md).
Dekodierlogik portiert aus [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes) von Kaih1825 (MIT License, © 2025 Document Parser for GoodNotes contributors).
