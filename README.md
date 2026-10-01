# Federwerk

[![CI – Tests](https://github.com/Jojoistauchdabei/notes/actions/workflows/ci.yml/badge.svg)](https://github.com/Jojoistauchdabei/notes/actions/workflows/ci.yml)

Handschrift-Notizbuch im Papier-Stil: Stift, Marker, Radierer, Textboxen mit Rich-Text-Editor, Bilder, Seiten mit Thumbnails. Das Dokument wird **durchgängig gescrollt** (alle Seiten in einem Stack, keine Seitenwechsel-Gesten – siehe [SPEC-37](specs/37-continuous-scroll-dokument.md)). Mehrere Dokumente, JSON-Einzel-/Gesamt-Export, **GoodNotes-Import (`.goodnotes`)**. Lokal im Browser, offline-fähig (PWA).

Einfach `index.html` öffnen oder hosten – kein Build, kein Server nötig.

## Releases: Web, Desktop & Android (mit Autoupdate)

`dist/` ist nur ein lokales Build-Artefakt (`npm run build`) und wird nicht
eingecheckt. Jedes GitHub Release enthält:
- `Federwerk-vX.Y.Z-web.zip` – fertige Cloudflare-/Web-Dateien (entpacken,
  z. B. als `wrangler`-Assets-Verzeichnis nutzen),
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
`TAURI_SIGNING_PRIVATE_KEY` (Inhalt von `src-tauri/updater-key`, nie committen),
`CLOUDFLARE_API_TOKEN`, `CLOUDFLARE_ACCOUNT_ID`; optional für stabile
Android-Updatekette: `ANDROID_KEYSTORE_BASE64`, `ANDROID_KEYSTORE_PASSWORD`,
`ANDROID_KEY_ALIAS`, `ANDROID_KEY_PASSWORD` (ohne sie: Debug-APK).

## CDN-Größe (Cloudflare Workers Static Assets)

`npm run build` erzeugt eine fürs CDN optimierte `dist/` (~0,9 MB statt ~3,5 MB):

- `altes_Papier.png` (2,5 MB) bleibt Quell-Asset, im Build kommt nur die
  Papier-Textur als WebP (95K) + JPEG-Fallback (176K) mit – `css/styles.css`
  wählt per `image-set` automatisch das Format des Browsers.
- Die 26 Seiten-Skripte aus `index.html` werden zu **einem** gehashten Bundle
  (`js/app.bundle.<hash>.js`, minifiziert), die 27 HTTP-Requests entfallen.
  `js/gnpdf-worker.js` bleibt separat (wird per `new Worker(...)` geladen).
- Gehashte Dateien (Bundle, CSS, Papierbilder) bekommen in `dist/_headers`
  `Cache-Control: public, max-age=31536000, immutable`; `index.html`, `sw.js`
  und das Manifest bleiben `must-revalidate`, damit Releases sofort ankommen.
- `dist/sw.js` precacht nur noch die App-Shell (11 Dateien), nicht mehr
  Screenshots/Doku.

Minifiziert wird mit esbuild über `npx` (wie `wrangler@4` im Release-Workflow);
ohne Netz baut `npm run build` ohne Minifizierung weiter, Bundle/Hash/Caching
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

Der State (klein) liegt in IndexedDB (`grimoire-db`) plus localStorage-Backup; Bild-Bytes und PDF-Hintergründe liegen als Blobs separat in IndexedDB, im State steht nur eine kurze `blob:<id>`-Referenz. Das 5MB-localStorage-Limit greift damit nicht mehr. Beim ersten Start migriert die App bestehende Daten automatisch (Zähler in der Statuszeile). JSON-Export enthält weiter portable dataURLs (`inlineBook`/`extractBook` in `js/store.js`). Cloud-Sync läuft über Appwrite (Tabellen `notes`/`folders`, Storage-Bucket `attachments` mit SHA-256-Dedupe, `js/appwrite-files.js`, `js/appwrite-sync.js`). **Liveshare** (Share-Link mit Lesen/Edit + Ablauf, Live-Cursor, LWW pro Stroke) läuft ebenfalls über Appwrite – Tabellen `shares`/`share_events`, `js/liveshare.js`, Setup in `specs/36-liveshare.md`.

## Tests

```bash
npm test   # 46 Tests, inkl. GoodNotes-Konformanz (tests/)
```

Läuft automatisch bei jedem Push/PR auf `main` (`.github/workflows/ci.yml`, Node 20 + 22).
Live: https://notes.ponnet.org

## MCP (KI-Zugang: lesen + schreiben)

Federwerk hat einen echten MCP-Server (JSON-RPC 2.0, 24 Tools): Notizen
anlegen/bearbeiten/löschen, Ordner verwalten, Karteikarten-Decks inkl.
SM-2-Bewertung, Query-Suche und Wikilink-Graph – für Claude Desktop, Cursor,
Opencode u. a. Lokal per `node mcpserver/cli.js` (stdio), in der Cloud als
Appwrite Function (`mcp/`).

- `/agent` – Anleitungsseite für Nutzer (auch aus der App verlinkt)
- `/mcp` – Markdown-Anleitung für KI-Modelle (Installation + Nutzung)

Vollständige Doku: [`docs/mcp.md`](docs/mcp.md), KI-Version:
[`MCP_AI.md`](MCP_AI.md).
Dekodierlogik portiert aus [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes) von Kaih1825 (MIT License, © 2025 Document Parser for GoodNotes contributors).

Dekodierlogik portiert aus [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes) von Kaih1825 (MIT License, © 2025 Document Parser for GoodNotes contributors).
