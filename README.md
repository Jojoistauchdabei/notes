# 📜 Grimoire

Handschrift-Notizbuch im D&D-Papier-Stil (wie DND-Character-sheet-generator): Stift, Marker, Radierer, Textboxen mit Rich-Text-Editor, Bilder, Seiten mit Thumbnails. Mehrere Dokumente, JSON-Einzel-/Gesamt-Export, **GoodNotes-Import (`.goodnotes`)**. Lokal im Browser, offline-fähig (PWA).

Einfach `index.html` öffnen oder hosten – kein Build, kein Server nötig.

## GoodNotes-Import

`.goodnotes`-Dateien werden komplett client-seitig dekodiert (ZIP → Protobuf → Apple-LZ4 → TPL-Strokes) und als neues Dokument in die Bibliothek übernommen: Handschrift-Strokes (Farbe, Breite, Marker), Shapes (Linien, Rechtecke, Ellipsen inkl. Fill/Dash), getippte Textboxen und Stickies (Formatierung, Listen, Ausrichtung), platzierte Bilder, PDF-Seitenhintergrund (wird via pdf.js gerastert), Titel, alle Seiten. Tests: `npm test` (19 Tests, inkl. Konformanz gegen echte Datei).

PDF-Hintergründe rendern in einem Web-Worker (OffscreenCanvas) mit harter Timeout-Garantie per `terminate()` – der Main-Thread blockiert nie, auch nicht bei defekten PDFs oder ohne Netz. Ohne Worker-Unterstützung gibt es einen Main-Thread-Fallback, ganz ohne Netz eine Hinweis-Box.

Dekodierlogik portiert aus [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes) von Kaih1825 (MIT License, © 2025 Document Parser for GoodNotes contributors).

Dekodierlogik portiert aus [parser-for-goodnotes](https://github.com/Kaih1825/parser-for-goodnotes) von Kaih1825 (MIT License, © 2025 Document Parser for GoodNotes contributors).
