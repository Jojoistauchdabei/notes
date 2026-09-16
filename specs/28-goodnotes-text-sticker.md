# SPEC-28: GoodNotes Textbox & Sticker

- Quelle: GoodNotes 6 (2025/2026)
- Kategorie: Feature
- Status: Vorschlag

## 1. Beschreibung

Verschiebbare Textboxen plus Full-Page-Typing (Tippen irgendwo erzeugt Text), Rich-Text (Font, Größe, Farbe, Fett/Kursiv, Listen, Ausrichtung), Default-Stil pro Dokument sowie Sticky-Notes (256×256, #FAE778) als D&D-taugliche Klebezettel.

## 2. UI / Verhalten / Aufbau

- Textbox-Tool: Tap → Box aufziehen/setzen, tippen, per Rahmen verschieben/resizen; Full-Page-Typing: Tap auf leere Stelle mit Text-Tool erzeugt sofort Box (kein Dialog).
- Format-Leiste: Font (System-Fonts + mind. 1 Handschrift-Font), Size (8–96 pt), Color (Shared-Palette, SPEC-29), Bold/Italic, Liste (Bullet/Nummeriert/Check), Align (links/mitte/rechts).
- Default-Stil: Button „Als Standard setzen" speichert Font/Size/Color pro Doc (IndexedDB), neue Boxen erben ihn.
- Sticky: quadratisch 256×256 px, Hintergrund #FAE778, leichte Rotation (-2°..2°), Schatten; Text wie Textbox light; verschiebbar/stapelbar (Z-Order).
- Rendering: Text als DOM-Overlay über Canvas (editierbar) + beim Export/Flatten auf Canvas gerastert.

## 3. User-Story

Als Chronistin will ich Quest-Texte tippen (statt schreiben), per Bullet-Liste strukturieren und gelbe Stickies für NSC-Hinweise auf die Karte kleben.

## 4. Akzeptanzkriterien (5-7 Checkboxen)

- [ ] Textbox anlegen/verschieben/resizen, Text bleibt editierbar nach Reload.
- [ ] Full-Page-Typing: Tap auf Seite erzeugt Box an Tap-Position.
- [ ] Font/Size/Color/Bold/Italic/List/Align wirken live und persistieren.
- [ ] Default-Stil wird für neue Boxen übernommen.
- [ ] Sticky 256×256 #FAE778 mit Schatten, verschiebbar, löschbar.
- [ ] Überlappung Ink/Text/Sticky: Z-Order korrekt, Text selektierbar.
- [ ] Export (PNG/PDF) enthält Text gerastert an richtiger Position.

## 5. Verifikation

- Manuell: Box anlegen, formatieren, Default setzen, neue Box prüfen, Sticky kleben/verschieben, Reload, PNG-Export prüfen.
- Automatisiert: `tests/text-sticker.test.js` — Textbox-Serialisierung (Font/Size/Color/Align/List), Default-Stil-Vererbung, Sticky-Konstanten (256, #FAE778). Laufen lassen mit `npm test`.

## 6. Grimoire-Aufwand

M (Textbox-Overlay + Format-Leiste + Sticky; Listen-Logik klein extra).

## 7. Offene Entscheidung

Text als DOM-Overlay dauerhaft oder Canvas-nativ? Handschrift-Font einbetten (Lizenz) oder System-Font nutzen?
