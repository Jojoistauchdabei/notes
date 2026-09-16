# SPEC-25: GoodNotes Highlighter & Radierer (+ Undo-Gesten)

- Quelle: GoodNotes 6 (2025/2026)
- Kategorie: Feature
- Status: Vorschlag

## 1. Beschreibung

Textmarker mit Multiply-Blending (Alpha ~0.35, überlappt nicht deckend), Radierer-Modi (Precision / Standard / Stroke), Option „Nur Highlighter löschen", Scribble-Erase (Gekritzel über Stroke löscht ihn) sowie Zwei-Finger-Tap = Undo, Drei-Finger-Tap = Redo.

## 2. UI / Verhalten / Aufbau

- Highlighter: eigenes Tool neben Stiften; Striche mit `globalCompositeOperation = 'multiply'`, Alpha 0.35, breite Spitze, gerade-Linien-Snap bei Draw-and-Hold (vgl. SPEC-26).
- Eraser-Modi im Tool-Menü: Precision (Pixel-genau, Radier-Radius klein), Standard (Mittel, weiche Kante), Stroke (ganzer Stroke bei Berührung löschen).
- Toggle „Erase Highlighter Only": Radierer trifft nur Marker-Layer, lässt Ink intakt (und umgekehrt Standard-Modus opção).
- Scribble-Erase: schnelles Hin-und-Her-Gekritzel über einem Stroke (im Stroke-Modus) löscht ihn; Erkennung via Richtungswechsel ≥ 2 innerhalb 400 ms auf kleinem Radius.
- Gesten: Zwei-Finger-Tap → Undo, Drei-Finger-Tap → Redo (zusätzlich zu Buttons); Touch-Handler unterscheidet von Pinch-Zoom (Dauer < 300 ms, kaum Bewegung).

## 3. User-Story

Als Spielerin will ich NSC-Namen mit Gelb markieren (mehrfach übermalbar ohne Schwarz-Deckkraft) und mit Zwei-Finger-Tap Fehler sofort rückgängig machen, ohne die Toolbar zu suchen.

## 4. Akzeptanzkriterien (5-7 Checkboxen)

- [ ] Highlighter überlappt sich selbst/doppelt ohne Abdunklung über Alpha 0.35 hinaus (Multiply).
- [ ] Eraser Precision/Standard/Stroke verhalten sich unterscheidbar (Teillöschung vs. Voll-Stroke).
- [ ] „Erase Highlighter Only" löscht Marker, lässt Tinte darunter unverändert.
- [ ] Scribble-Erase löscht Ziel-Stroke, benachbarte Strokes bleiben.
- [ ] Zwei-Finger-Tap = Undo, Drei-Finger-Tap = Redo (kein Konflikt mit Zoom).
- [ ] Modi + Toggle persistiert pro Session/Doc.
- [ ] Touch-Geräte ohne Stylus voll bedienbar.

## 5. Verifikation

- Manuell: Marker doppelt übermalen (Foto-Vergleich), jeden Eraser-Modus testen, Highlighter-Only-Toggle prüfen, Scribble-Gekritzel testen, 2-/3-Finger-Taps testen.
- Automatisiert: `tests/highlighter-eraser.test.js` — Blend-Konstante (alpha 0.35, multiply), Eraser-Modus-Logik (Teillöschung vs. Stroke-Delete), Undo/Redo-Stack inkl. Gesten-Events. Laufen lassen mit `npm test`.

## 6. Grimoire-Aufwand

S–M (Highlighter-Blending + Stroke-Eraser klein; Scribble-Erkennung + Gesten-Dedup mittel).

## 7. Offene Entscheidung

Highlighter als eigener Layer oder Stroke-Flag? Scribble-Schwellwerte fix oder in Settings einstellbar?
