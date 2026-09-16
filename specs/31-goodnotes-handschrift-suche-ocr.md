# SPEC-31: GoodNotes Handschrift-Suche, OCR & Smart-Ink

- Quelle: GoodNotes 6 (2025/2026)
- Kategorie: Feature
- Status: Vorschlag

## 1. Beschreibung

Handschrift-Erkennung (HSR) on-device mit durchsuchbarem Index, globaler + lokaler Suche, Sprache pro Dokument, Lasso→Text-Konvertierung, Smart-Ink (Reflow/Straighten: Umfließen/Begradigen) und Math-Assist (Gleichung handschriftlich → Lösung/Vervollständigung).

## 2. UI / Verhalten / Aufbau

- HSR-Index: beim Speichern läuft (zukünftig) on-device-Erkennung, Index in IndexedDB (Wort → Stroke-/Seiten-Referenz); Suche ohne Cloud.
- Suche: global (über alle Docs, Ergebnis mit Doc-Titel + Seiten-Vorschau) vs. lokal (nur aktuelles Doc, Highlight auf Seite). Getrennt von Library-Titel-Suche (SPEC-23).
- Sprache pro Doc: Auswahl (z. B. de/en/fr), steuert Erkennungs-Modell; Default = Gerätesprache.
- Convert: Lasso-Auswahl → „In Text umwandeln" erzeugt Textbox (SPEC-28) an Auswahl-Position, Original optional behalten/löschen.
- Smart-Ink: Reflow (Umfließen: eingefügter Platz schiebt Handschrift um) + Straighten (Begradigen: schiefe Zeilen werden horizontal ausgerichtet).
- Math-Assist: erkannte Gleichung (z. B. „2d6+4=") → Lösungs-Vorschlag als einfügbare Annotation (Würfel-Auswertung im D&D-Sinn optional).

## 3. User-Story

Als Chronistin will ich „Strahd" handschriftlich suchen und alle Erwähnungen kampagnenweit finden, eine Kritzel-Notiz in Text wandeln und „12+8=" direkt auswerten lassen.

## 4. Akzeptanzkriterien (5-7 Checkboxen)

- [ ] HSR-Index wird aufgebaut (Mock genügt V1), Suche findet Wort mit Seiten-Treffer.
- [ ] Global vs. lokal umschaltbar, Ergebnisse mit Kontext-Vorschau.
- [ ] Sprache pro Doc einstellbar, Default = Gerätesprache.
- [ ] Lasso→Text erzeugt editierbare Textbox an richtiger Position.
- [ ] Straighten begradigt Zeile sichtbar; Reflow schafft Platz ohne Überlappung.
- [ ] Math-Assist löst einfache Gleichungen korrekt (inkl. Fehlermeldung bei Unsinn).
- [ ] Alles offline lauffähig (kein Cloud-Zwang, Privacy-Hinweis in UI).

## 5. Verifikation

- Manuell: Testseite mit 5 Wörtern, global/lokal suchen, Sprache wechseln, Lasso→Text, Straighten, „7*6=" auswerten, offline (Flugmodus) wiederholen.
- Automatisiert: `tests/handwriting-search.test.js` — Index-Aufbau/Query (Mock-Recognizer), Scope-Filter global/lokal, Convert-Mapping, Math-Parser (Grundrechenarten). Laufen lassen mit `npm test`.

## 6. Grimoire-Aufwand

L (echtes On-Device-HSR schwer; V1 mit Mock/Platzhalter + Suche M).

## 7. Offene Entscheidung

 echtes HSR-Modell (z. B. WASM) oder Server-/Platzhalter V1? Math-Assist mit Würfel-Notation (2d6) als D&D-Sonderweg?
