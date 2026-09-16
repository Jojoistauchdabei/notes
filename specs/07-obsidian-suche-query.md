# SPEC-07: Globale Suche und Embedded Query-Blöcke

- Quelle: Obsidian
- Kategorie: Feature
- Status: Vorschlag (zur Auswahl)

## 1. Beschreibung

Obsidians globale Suche beherrscht eine eigene Query-Sprache mit `OR`, Minus-Ausschluss (`-`), Phrasen in `"Anführungszeichen"` sowie Operatoren wie `file:`, `path:`, `tag:`, `task:` und `line:`/`section:` (Stand 2025/2026). Daneben gibt es eingebettete Suchblöcke (````query`-Codeblöcke), die ihre Treffer live innerhalb einer Notiz rendern.

## 2. UI / Verhalten / Aufbau

Such-Panel links: Eingabefeld, Trefferliste gruppiert pro Datei (mit 1–2 Kontextzeilen, Klick springt in Zeile), Buttons: Groß/Klein, Regex, „Ergebnisse kopieren“. Query-Beispiele: `tag:#projekt file:.md -path:Archiv "nächste Schritte"`, `task:"todo" path:Daily`. Embedded Block in Notiz:
````markdown
```query
tag:#offen path:Projekte -"archiviert"
```
````
wird in Reading/Live als Trefferliste (Titel + Snippet + Backlink) gerendert, nicht als Code.

## 3. User-Story

Als Forscher möchte ich vault-weit mit Operatoren suchen und wiederverwendbare Suchen als Query-Block in Übersichtsnotizen einbetten, damit Dashboards (z. B. „alle offenen Aufgaben“) immer aktuell bleiben.

## 4. Akzeptanzkriterien

- [ ] Suche findet Volltext über alle `.md`-Notizen mit Trefferkontext und Dateigruppierung.
- [ ] Operatoren `OR`, `-`, `"Phrase"`, `file:`, `path:`, `tag:`, `task:` funktionieren kombiniert (mind. je 1 Testfall).
- [ ] Klick auf Treffer öffnet Notiz an der Trefferzeile (Cursor/Scroll).
- [ ] ` ```query `-Block in einer Notiz rendert Trefferliste live und aktualisiert nach Edit anderer Notizen.
- [ ] Suche ist case-insensitive und findet Umlaute/Word-Grenzen robust.
- [ ] Leere Suche / 0 Treffer zeigt Hinweis statt Absturz; Suche bleibt <500ms bei 200 Fixture-Notizen.
- [ ] Such-Historie (letzte 5 Queries) ist per Dropdown wieder aufrufbar.

## 5. Verifikation

Manuell:
1. `tag:#test path:Projekte -"alt"` eingeben → nur passende Dateien mit Kontext-Snippets sichtbar → Klick springt in Zeile.
2. Notiz mit ` ```query `-Block anlegen → andere Notiz so ändern, dass sie passt/nicht passt → Block-Liste aktualisiert nach Reload neu.
3. `"exakte Phrase"` vs. Einzelwörter vergleichen → unterschiedliche Treffermengen sichtbar.

Automatisiert: `npm test` mit neuem Test in `tests/suche-query.test.js` (Query-Parser für OR/-/""/file:/path:/tag:/task: + Matcher auf 10 Fixture-Notizen). Im Browser sichtbar sein muss: Suchfeld mit Trefferliste (Datei + Snippet), Operator-Highlight, gerenderter Query-Block als Liste statt Code.

## 6. Grimoire-Aufwand

M — Abhängigkeit: braucht Volltext-Index über IndexedDB und Frontmatter/Tag-Parsing (SPEC-12).

## 7. Offene Entscheidung

Soll die Grimoire-Suche synchron im Main-Thread (einfach, reicht bis ~1000 Notizen) oder sofort als Web-Worker-Index (skalierbar, mehr Aufwand) gebaut werden?
