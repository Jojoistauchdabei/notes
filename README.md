# 📜 Grimoire

[![CI – Tests](https://github.com/Jojoistauchdabei/notes/actions/workflows/ci.yml/badge.svg)](https://github.com/Jojoistauchdabei/notes/actions/workflows/ci.yml)

Handschrift-Notizbuch im D&D-Papier-Stil (wie DND-Character-sheet-generator): Stift, Marker, Radierer, Textboxen mit Rich-Text-Editor, Bilder, Seiten mit Thumbnails. Mehrere Dokumente, JSON-Einzel-/Gesamt-Export, **GoodNotes-Import (`.goodnotes`)**. Lokal im Browser, offline-fähig (PWA).

Einfach `index.html` öffnen oder hosten – kein Build, kein Server nötig.

## Speicher (IndexedDB + Bild-Blobs)

Der State (klein) liegt in IndexedDB (`grimoire-db`) plus localStorage-Backup; Bild-Bytes und PDF-Hintergründe liegen als Blobs separat in IndexedDB, im State steht nur eine kurze `blob:<id>`-Referenz. Das 5MB-localStorage-Limit greift damit nicht mehr. Beim ersten Start migriert die App bestehende Daten automatisch (Zähler in der Statuszeile). JSON-Export und WebDAV-Sync enthalten weiter portable dataURLs (`inlineBook`/`extractBook` in `js/store.js`).

## Tests

```bash
npm test   # 46 Tests, inkl. GoodNotes-Konformanz (tests/)
```

Läuft automatisch bei jedem Push/PR auf `main` (`.github/workflows/ci.yml`, Node 20 + 22).

## Releases & Cloudflare-Deploy

Live: https://notes.ponnet.org – deployed wird **ausschließlich über GitHub Releases**:

1. Release auf GitHub anlegen (Tag, z. B. `v1.3.1`) und **publishen**.
2. Workflow `Release – Test + Cloudflare Deploy` läuft: erst `npm test` auf dem Release-Tag – nur bei grünen Tests geht es weiter.
3. Deploy per Wrangler (`wrangler.toml`, Static Assets) auf den Worker `notes`.

Alternative per Automation (Workflow `Auto-Release – Test + Release + Deploy`):
manuell per `Run workflow` mit Versions-Input (z. B. `v1.7.0`), oder automatisch
bei Push auf `main` mit `[release]` in der Commit-Message – die Version kommt
dabei aus `package.json` (vorher erhöhen, sonst bricht der Workflow ab).
Ablauf jeweils: `npm test` → Tag + Release anlegen → Deploy.

Einmalig nötige Repo-Secrets (Settings → Secrets and variables → Actions):

| Secret | Woher |
|---|---|
| `CLOUDFLARE_API_TOKEN` | Cloudflare Dashboard → My Profile → API Tokens → Create Token → Vorlage „Edit Cloudflare Workers“ |
| `CLOUDFLARE_ACCOUNT_ID` | Cloudflare Dashboard → rechte Seitenleiste (Account-ID) |

Fehlen die Secrets, bricht der Workflow mit klarer Fehlermeldung ab (kein Deploy).

## GoodNotes-Import

`.goodnotes`-Dateien werden komplett client-seitig dekodiert (ZIP → Protobuf → Apple-LZ4 → TPL-Strokes) und als neues Dokument in die Bibliothek übernommen: Handschrift-Strokes (Farbe, Breite, Marker), Shapes (Linien, Rechtecke, Ellipsen inkl. Fill/Dash), getippte Textboxen und Stickies (Formatierung, Listen, Ausrichtung), platzierte Bilder, PDF-Seitenhintergrund (wird via pdf.js gerastert), Titel, alle Seiten. Tests: `npm test` (46 Tests, inkl. Konformanz gegen echte Datei).

PDF-Hintergründe rendern in einem Web-Worker (OffscreenCanvas) mit harter Timeout-Garantie per `terminate()` – der Main-Thread blockiert nie, auch nicht bei defekten PDFs oder ohne Netz. Ohne Worker-Unterstützung gibt es einen Main-Thread-Fallback, ganz ohne Netz eine Hinweis-Box.

Dekodierlogik portiert aus [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes) von Kaih1825 (MIT License, © 2025 Document Parser for GoodNotes contributors).

Dekodierlogik portiert aus [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes) von Kaih1825 (MIT License, © 2025 Document Parser for GoodNotes contributors).
