# Federwerk

[![CI – Tests](https://github.com/Jojoistauchdabei/notes/actions/workflows/ci.yml/badge.svg)](https://github.com/Jojoistauchdabei/notes/actions/workflows/ci.yml)

Handschrift-Notizbuch im Papier-Stil: Stift, Marker, Radierer, Textboxen mit Rich-Text-Editor, Bilder, Seiten mit Thumbnails. Mehrere Dokumente, JSON-Einzel-/Gesamt-Export, **GoodNotes-Import (`.goodnotes`)**. Lokal im Browser, offline-fähig (PWA).

Einfach `index.html` öffnen oder hosten – kein Build, kein Server nötig.

## Speicher (IndexedDB + Bild-Blobs)

Der State (klein) liegt in IndexedDB (`grimoire-db`) plus localStorage-Backup; Bild-Bytes und PDF-Hintergründe liegen als Blobs separat in IndexedDB, im State steht nur eine kurze `blob:<id>`-Referenz. Das 5MB-localStorage-Limit greift damit nicht mehr. Beim ersten Start migriert die App bestehende Daten automatisch (Zähler in der Statuszeile). JSON-Export und WebDAV-Sync enthalten weiter portable dataURLs (`inlineBook`/`extractBook` in `js/store.js`).

## Tests

```bash
npm test   # 46 Tests, inkl. GoodNotes-Konformanz (tests/)
```

Läuft automatisch bei jedem Push/PR auf `main` (`.github/workflows/ci.yml`, Node 20 + 22).
Live: https://notes.ponnet.org
Dekodierlogik portiert aus [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes) von Kaih1825 (MIT License, © 2025 Document Parser for GoodNotes contributors).

Dekodierlogik portiert aus [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes) von Kaih1825 (MIT License, © 2025 Document Parser for GoodNotes contributors).
