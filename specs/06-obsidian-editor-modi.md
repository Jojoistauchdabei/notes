# SPEC-06: Editor-Modi (Live Preview / Source / Reading)

- Quelle: Obsidian
- Kategorie: Feature
- Status: Vorschlag (zur Auswahl)

## 1. Beschreibung

Obsidian kennt drei Editor-Ansichten auf CodeMirror-6-Basis: Live Preview (WYSIWYG-nahes Editieren), Source Mode (reines Markdown) und Reading View (gerendertes Lesen), umschaltbar per `Ctrl/Cmd+E` bzw. Icon (Stand 2025/2026). Der Gedanke ist ein Editor-State mit drei Renderern über demselben Markdown-Dokument.

## 2. UI / Verhalten / Aufbau

Toolbar-Toggle (Stift/Auge/Code-Icon) + `Ctrl+E` rotiert Live → Source → Reading. Live Preview: Markdown-Syntax wird beim Tippen inline formatiert (Fett, Links, Embeds gerendert, aber editierbar). Source: monospace, rohe `[[Wikilinks]]`/`#tags`. Reading: reines HTML, Klicks folgen Links, kein Cursor. Modus pro Notiz in `workspace.json` gemerkt:
```json
{ "path": "Notiz.md", "mode": "live | source | reading", "cursor": { "line": 12, "ch": 4 } }
```
Grimoire: Vanilla-Contenteditable oder leichtes CM6-Äquivalent, kein Framework-Editor.

## 3. User-Story

Als Autor möchte ich zwischen WYSIWYG-Editieren, Roh-Markdown und ablenkungsfreiem Lesen per Tastendruck wechseln, damit ich schreiben, debuggen (Syntax) und konsumieren kann ohne die Notiz zu verlassen.

## 4. Akzeptanzkriterien

- [ ] Drei Modi sind vorhanden und per `Ctrl+E` sowie per Icon durchschaltbar.
- [ ] Live Preview rendert Fett/Kursiv/Links/`[[Wikilinks]]`/Checkboxen inline und bleibt editierbar.
- [ ] Source Mode zeigt rohes Markdown inkl. Frontmatter, keine Formatierung.
- [ ] Reading View rendert Tabellen, Codeblöcke und Bilder korrekt und ist nicht editierbar.
- [ ] Modus bleibt pro Notiz nach Reload erhalten (Persistenz).
- [ ] Canvas-/Handschrift-Notizen (GoodNotes-Import) öffnen immer in Reading/Canvas-Ansicht, nie im Markdown-Editor.
- [ ] Lange Notiz (>500 Zeilen) bleibt in allen Modi ohne spürbaren Lag bedienbar.

## 5. Verifikation

Manuell:
1. Notiz mit Fett, Tabelle, `[[Link]]`, `#tag`, Checkbox öffnen → `Ctrl+E` 3× drücken → Live/Source/Reading jeweils optisch unterscheidbar.
2. In Source Frontmatter ändern, Reload → Modus und Inhalt erhalten.
3. Gescannte Canvas-Notiz öffnen → kein Markdown-Editor, sondern Canvas/Lesen-Ansicht.

Automatisiert: `npm test` mit neuem Test in `tests/editor-modi.test.js` (Modus-Toggle-State-Machine, Markdown→HTML-Renderer für Fett/Link/Checkbox-Fixture). Im Browser sichtbar sein muss: Modus-Toggle in Toolbar, inline-formatierter Live-Text, roher Source-Text, gerenderte Reading-Ansicht mit klickbaren Links.

## 6. Grimoire-Aufwand

L — Abhängigkeit: braucht Markdown-Parser/Renderer und Wikilink-Auflösung; berührt GoodNotes-Canvas-Darstellung.

## 7. Offene Entscheidung

Soll Grimoire CodeMirror 6 als Dependency einführen oder einen eigenen minimalen Vanilla-Editor (Contenteditable + eigener Renderer) bauen?
