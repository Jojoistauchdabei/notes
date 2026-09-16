# SPEC-32: GoodNotes PDF-Import, Annotation & Hyperlinks

- Quelle: GoodNotes 6 (2025/2026)
- Kategorie: Feature
- Status: Vorschlag

## 1. Beschreibung

PDF-Import als nicht-editierbarer Hintergrund-Layer plus darüberliegender Ink-Layer für Annotationen; Export als editierbar (Vektor-Ink erhalten) vs. flattened (eine Ebene); Hyperlinks (getippter Text → URL/Dokument-Seite, Planner-Tabs als Seiten-Link-Menü) und Outline (Inhaltsverzeichnis-Seitenliste).

## 2. UI / Verhalten / Aufbau

- Import: PDF wählen → Seiten werden Hintergrund-Bilder (ein Canvas-Layer, fix, nicht selektierbar); Ink-Layer darüber frei beschreibbar (Stifte/Marker/Shapes/Text/Sticky).
- Neu-Seite-Import (Fokus): Bild-Import legt pro Bild eine neue Seite an, PDF-Import pro PDF-Seite eine neue Seite (wählbar: alle Seiten oder Seitenbereich); Hintergrund dort fix, Ink-Layer leer. Import-Dialog mit Option „Als neue Seite(n) anlegen" (Default an), danach Sprung zur ersten neuen Seite.
- Annotation: alle Grimoire-Tools arbeiten auf Ink-Layer; Hintergrund unverändert (Zoom synchron).
- Export: editierbar (PDF mit Vektor-Ink + Text, z. B. via Print/PDF-Lib) vs. flattened (Ink auf Hintergrund gerastert, eine Ebene, kleiner/sicher zum Teilen).
- Hyperlinks: in getippter Textbox URL oder Doc-Seite verlinken (Dialog: „Link: URL / Seite N"); getippte Links klickbar (Strg/Cmd+Klick im Edit, Tap im Read-Mode).
- Planner-Tabs: seitliche Tab-Reiter (z. B. „Karte", „NSC", „Loot") = Sprungmarken auf Seiten, anlegbar/umbenennbar.
- Outline: automatisch (Hyperlink-Ziele + Überschriften-Textboxen) + manuell; Sidebar-Baum zum Springen.

## 3. User-Story

Als Spielleiter will ich das Abenteuer-PDF importieren, Encounter-Notizen darauf kritzeln, „siehe Karte S.5" als klickbaren Seiten-Link setzen und flattened für Spieler exportieren.

## 4. Akzeptanzkriterien (5-7 Checkboxen)

- [ ] PDF-Import zeigt alle Seiten als Hintergrund, Ink darüber synchron beim Zoom/Scroll.
- [ ] Bild-/PDF-Import als neue Seite: 1 Bild = 1 neue Seite, PDF = N neue Seiten (bzw. gewählter Bereich), Hintergrund fix, Ink leer, per Undo rückgängig.
- [ ] Hintergrund nicht versehentlich selektier-/löschbar (Layer-Trennung).
- [ ] Export editierbar vs. flattened wählbar, beide öffnen sich in Standard-PDF-Readern.
- [ ] Typed-Text-Link zu URL öffnet extern; Link zu Doc-Seite springt korrekt.
- [ ] Planner-Tabs anlegbar/umbenennbar, springen auf Zielseite.
- [ ] Outline listet Tabs/Überschriften, Klick navigiert.
- [ ] Große PDFs (> 50 Seiten) laden paginiert/lazy ohne Freeze (Fortschritt sichtbar).

## 5. Verifikation

- Manuell: Bild importieren → neue Seite mit Bild-Hintergrund erscheint; 3-seitiges PDF importieren → 3 neue Seiten, annotieren, URL- + Seiten-Link setzen, Tabs + Outline testen, beide Exporte öffnen, 50+-Seiten-PDF Ladezeit prüfen.
- Automatisiert: `tests/pdf-links.test.js` — Layer-Trennung (BG vs. Ink), Link-Modell (URL/Page-Targets, Validation), Outline-Builder, Export-Modus-Flag. Laufen lassen mit `npm test`.

## 6. Grimoire-Aufwand

M–L (Import-Anzeige M; Hyperlinks/Tabs M; echter Vektor-PDF-Export L).

## 7. Offene Entscheidung

PDF-Rendering via PDF.js oder Worker (`js/gnpdf-worker.js`)? Export-Lib (pdf-lib) oder Print-to-PDF als V1?
