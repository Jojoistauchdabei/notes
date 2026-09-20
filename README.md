# Federwerk

[![CI – Tests](https://github.com/Jojoistauchdabei/notes/actions/workflows/ci.yml/badge.svg)](https://github.com/Jojoistauchdabei/notes/actions/workflows/ci.yml)

Handschrift-Notizbuch im Papier-Stil: Stift, Marker, Radierer, Textboxen mit Rich-Text-Editor, Bilder, Seiten mit Thumbnails. Mehrere Dokumente, JSON-Einzel-/Gesamt-Export, **GoodNotes-Import (`.goodnotes`)**. Lokal im Browser, offline-fähig (PWA).

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

## Speicher (IndexedDB + Bild-Blobs)

Der State (klein) liegt in IndexedDB (`grimoire-db`) plus localStorage-Backup; Bild-Bytes und PDF-Hintergründe liegen als Blobs separat in IndexedDB, im State steht nur eine kurze `blob:<id>`-Referenz. Das 5MB-localStorage-Limit greift damit nicht mehr. Beim ersten Start migriert die App bestehende Daten automatisch (Zähler in der Statuszeile). JSON-Export enthält weiter portable dataURLs (`inlineBook`/`extractBook` in `js/store.js`). Cloud-Sync läuft über Appwrite (Tabellen `notes`/`folders`, Storage-Bucket `attachments` mit SHA-256-Dedupe, `js/appwrite-files.js`, `js/appwrite-sync.js`).

## Tests

```bash
npm test   # 46 Tests, inkl. GoodNotes-Konformanz (tests/)
```

Läuft automatisch bei jedem Push/PR auf `main` (`.github/workflows/ci.yml`, Node 20 + 22).
Live: https://notes.ponnet.org
Dekodierlogik portiert aus [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes) von Kaih1825 (MIT License, © 2025 Document Parser for GoodNotes contributors).

Dekodierlogik portiert aus [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes) von Kaih1825 (MIT License, © 2025 Document Parser for GoodNotes contributors).
