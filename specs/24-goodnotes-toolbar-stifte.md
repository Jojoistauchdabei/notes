# SPEC-24: GoodNotes Toolbar & Stifte

- Quelle: GoodNotes 6 (2025/2026)
- Kategorie: UI / Feature
- Status: Vorschlag

## 1. Beschreibung

GoodNotes-Toolbar: 3-Zonen-Layout mit Tool-Tabs (Stift-Presets), konfigurierbaren Stift-Engines (Fountain, Ball, Brush, Pencil) und Parametern (Sharpness, Pressure, Flatness, Stabilization). Dazu Hover-Preview (Stylus-Hover-Punkt) und Barrel-Roll-Auswertung (Neigung/Rotation) auf fähiger Hardware. Übertrag auf Grimoires Canvas (`js/editor.js`).

## 2. UI / Verhalten / Aufbau

- Toolbar 3-Zonen: links Navigation (Library, Undo/Redo), Mitte Tools (4 Stift-Slots + Radierer, Marker, Formen, Lasso, Text, Bild), rechts Kontext (Farbe, Dicke, Mehr).
- Tabs/Presets: jeder Stift-Slot speichert eigene Engine + Farbe + Dicke (vgl. SPEC-29, Presets isoliert).
- Engines:
  - Fountain (Füller): variable Breite aus Pressure, Sharpness regelt Kanten-Härte.
  - Ball (Kuli): konstante Breite, leichte Pressure-Modulation.
  - Brush (Pinsel): starke Pressure→Breite-Kopplung + Flatness (Abflachung bei Neigung).
  - Pencil (Bleistift): körnige Textur, Pressure→Deckkraft statt Breite.
- Slider: Sharpness, Pressure-Empfindlichkeit, Flatness, Stabilization (Glättung 0–100 %).
- Hover-Preview: Stylus-Hover zeigt Punkt/Vorschau-Kreis in aktueller Farbe/Dicke (nur wenn `pointermove` mit `pointerType=pen` + `buttons=0`).
- Barrel-Roll-Gedanke: Rotation des Stylus (soweit `twist`/`tilt` verfügbar) rotiert Brush-Ellipse; Fallback: ignorieren, kein Fehler.

## 3. User-Story

Als Notizenschreiberin will ich drei Füller-Presets (Schwarz-fein, Rot-mittel, Braun-dick) per Tap wechseln und mit Druck dünn/dick schreiben, damit Karten-Annotationen im D&D-Stil schnell gehen.

## 4. Akzeptanzkriterien (5-7 Checkboxen)

- [ ] 3-Zonen-Toolbar rendert auf Desktop + Mobile (responsive, kein Overflow).
- [ ] 4 Engines wählbar, je Slot persistiert (Engine + Farbe + Dicke).
- [ ] Pressure beeinflusst Strichbreite/Deckkraft je Engine sichtbar unterschiedlich.
- [ ] Stabilization glättet zittrige Linien (Vorher/Nachher erkennbar).
- [ ] Hover-Preview zeigt Kreis in aktiver Farbe/Dicke, verschwindet bei Touch/Maus ohne Hover.
- [ ] Fehlende Sensorik (twist/tilt) führt nicht zu Fehlern (Barrel-Roll optional).
- [ ] Undo/Redo-Buttons spiegeln Canvas-History wider.

## 5. Verifikation

- Manuell: jede Engine 1 Satz schreiben, Pressure variieren, Stabilization 0 vs. 80 %, Hover mit Stylus testen, Reload → Presets erhalten.
- Automatisiert: `tests/toolbar-pens.test.js` — Preset-Store (Engine-Enum, Param-Ranges), Stroke-Renderer-Mapping Pressure→Breite pro Engine (Headless-Canvas oder Mock). Laufen lassen mit `npm test`.

## 6. Grimoire-Aufwand

M (Toolbar-Umbau + Engine-Parameter; L wenn Brush-Textur + Barrel-Roll voll).

## 7. Offene Entscheidung

Stabilization als einfacher Moving-Average oder One-Euro-Filter? Brush-Textur per Canvas-Pattern oder Shader-ähnlichem Alpha-Noise?
