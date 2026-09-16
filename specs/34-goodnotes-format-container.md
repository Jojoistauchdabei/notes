# SPEC-34: GoodNotes .goodnotes Container-Format

- Quelle: GoodNotes 6 (2025/2026)
- Kategorie: Dokumentformat
- Status: Vorschlag

## 1. Beschreibung

Referenz-Spec für den `.goodnotes`-Container, den `js/goodnotes.js` (mit `js/gnzip.js`) importiert: ZIP-Layout, Protobuf-Wire + delimited Records, Apple-LZ4-Blöcke, TPL-Strokes, Stroke-/Eraser-/Shape-/Text-/Bild-/PDF-/Metadata-Felder und deren Grimoire-Mapping.

## 2. UI / Verhalten / Aufbau

- Container: ZIP (`PK` Magic `0x50 0x4B`), Einträge u. a. `schema.pb`, `index.*.pb`, `notes/<uuid>/page*.pb`, `attachments/<uuid>` (Bilder/PDFs). Beispiel-Pfade: `notes/3F2504E0-4F89-11D3-9A0C-0305E82C3301/page0.pb`, `attachments/3F2504E0-4F89-11D3-9A0C-0305E82C3301`.
- Protobuf: Wire-Types varint/fixed32/fixed64/len-delimited, `decodeMessage`/`decodeDelimited` (varint-Längenpräfix pro Record) wie in `js/goodnotes.js`.
- Apple-LZ4: Blöcke mit Magic `bv41` (`62 76 34 31`), Varianten `bv4-`/`bv4$`, dekomprimiert seitenweise; Trailer `f4` + RGBA-Vorschau (kleines RGBA-Bild am Block-Ende).
- TPL: Troy-Hanson-TPL-Strokes, Header `tpl` + Format-String (z. B. Punkt-Layout x/y/pressure), danach Punkt-Arrays.
- Stroke: Felder x/y (Float-Arrays), pressure (0–1), color (RGBA), width (pt); Mapping → Grimoire-Canvas-Stroke (Punkte + Breite + Farbe).
- Eraser-Cuts: Radier-Segmente als Cut-Records (Stroke-ID + Bereich), beim Import Strokes splitten/kürzen.
- Shapes: Typ-Marker `f21`/`f22`/`f9` (Rechteck/Ellipse/Linie o. ä.) + Parameter (Bounds, Rotation); aktuell gezählt, V1 nicht als Vektor importiert.
- Typ35-Text-Runs: getippte Textboxen (Runs mit Font/Size/String), aktuell gezählt/nicht importiert (vgl. SPEC-28).
- Bilder: Attachments mit Crop-Rect + Rotation; Mapping auf Canvas-Bild-Objekt (Crop anwenden).
- PDF: Hintergrund-Referenz + MediaBox, z. B. `[0 0 612 792]` (US-Letter, pt); gemeldet, nicht gerastert (V1).
- Metadata: Titel, Seiten-Order, Delete-Flag, Template-Name pro Seite.

## 3. User-Story

Als Entwicklerin will ich anhand dieser Spec einen `.goodnotes`-Export per Hex-View grob verifizieren (PK, bv41, tpl sichtbar) und wissen, welche Inhalte Grimoire importiert vs. meldet.

## 4. Akzeptanzkriterien (5-7 Checkboxen)

- [ ] Doku nennt Pfade `notes/<uuid>`, `attachments/<uuid>`, `schema.pb`, `index.*.pb` korrekt.
- [ ] Magic-Bytes `PK`, `bv41`, `tpl` + Trailer `f4` RGBA dokumentiert und im Code auffindbar (`BV41`, TPL-Parser).
- [ ] Stroke-Felder (x/y/pressure/color/width) → Grimoire-Mapping beschrieben.
- [ ] Eraser-Cuts, Shapes (`f21`/`f22`/`f9`), Typ35-Text-Runs, Bilder-Crop/Rot, PDF-MediaBox `[0 0 612 792]`, Metadata (Titel/Order/Delete/Template) abgedeckt.
- [ ] Status je Typ (importiert vs. gezählt/gemeldet) stimmt mit `js/goodnotes.js`-Header überein.
- [ ] `tests/codec.test.js` + `tests/ex1.test.js` bleiben grün (`npm test`).
- [ ] Beispiel-Pfade im Doc sind syntaktisch gültige UUID-Pfade.

## 5. Verifikation

- Manuell: `.goodnotes` entpacken (ZIP), Pfade prüfen, `bv41`/`tpl` per Hex-Suche finden, Import in Grimoire mit Zähl-Report (Strokes/Bilder/Shapes/Texte/PDF-Hinweis) vergleichen.
- Automatisiert: `tests/codec.test.js` (Wire/delimited/LZ4-Roundtrip), `tests/ex1.test.js` (Fixture-Import), plus neuer `tests/format-container.test.js` für Magic-Byte-Erkennung + Pfad-Parsing. Laufen lassen mit `npm test`.

## 6. Grimoire-Aufwand

S (reine Doku-Spec; Code-Änderungen nur via separaten Import-Specs).

## 7. Offene Entscheidung

V1-Limits (Shapes/Text nur zählen, PDF nur melden) aufheben oder als bewusste Scope-Grenze behalten? Fixture-`.goodnotes` ins Repo für Tests?
