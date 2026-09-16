# SPEC-13: Obsidian Markdown (OFM)

- Quelle: Obsidian
- Kategorie: Dokumentformat
- Status: Vorschlag

## 1. Beschreibung

Grimoire unterstützt Obsidian Flavored Markdown (OFM) als Text-Kern neben dem Canvas-Notizbuch: CommonMark + GFM (Tabellen, Strikethrough, Task-Listen, Autolinks) plus Obsidian-Erweiterungen — Wikilinks `[[...]]`, Embeds `![[...]]`, Callouts `> [!note]`, Highlights `==...==`, Kommentare `%%...%%`. Ziel ist verlustfreier Roundtrip: OFM parsen → rendern → zurück serialisieren, ohne Obsidian-Syntax beim Editieren zu zerstören.

## 2. UI / Verhalten / Aufbau (mit Schema/Beispiel wo relevant)

Unterstützte Syntax (MVP-Umfang):

```markdown
# Titel

Wikilink: [[Notizname]] | [[Notizname|Alias]] | [[Notiz#Überschrift]] | [[Notiz#^block-id]]
Embed: ![[bild.png|300]] | ![[Notizname#Abschnitt]]
Callout:
> [!note] Titel
> Inhalt
> [!warning]- eingeklappt mit Minus

Highlight: ==wichtig==
Kommentar: %%intern, wird nicht gerendert%%
Task: - [ ] offen / - [x] erledigt / - [/] halb
Fußnote: Text[^1] … [^1]: Quelle
```

Verhalten:

- Lesemodus rendert Wikilinks als klickbare Links (unresolved = eigene CSS-Klasse), Embeds inline (Bild mit Breite, Notiz-Transklusion gerendert).
- Quellmodus lässt Rohtext unverändert; Live-Preview optional (Grimoire-Aufwand, nicht MVP).
- Callout-Typen MVP: `note`, `tip`, `warning`, `caution/danger`, `info`, `example`, `quote`; unbekannte Typen fallen auf `note` zurück.
- Falt-Suffix: `> [!note]-` (eingeklappt) und `> [!note]+` (ausgeklappt).
- Block-Referenz: `^block-id` am Absatzende; `[[Notiz#^block-id]]` springt dorthin.
- Serialisierung: AST → Markdown muss Wikilink-Ziele, Aliase, Embed-Breiten und Callout-Header byte-identisch erhalten.

Parser-Pipeline (Schema):

```text
Rohtext → Tokenizer (GFM) → OFM-Layer (Wikilink/Embed/Callout/Highlight/Comment) → AST → Renderer (HTML) / Serializer (Markdown)
```

## 3. User-Story

Als Grimoire-Nutzerin möchte ich Obsidian-Notizen mit Wikilinks, Embeds und Callouts öffnen und weiterbearbeiten, damit mein Vault in Grimoire lesbar bleibt und ich beim Zurückwechseln nach Obsidian keine Formatierung verliere.

## 4. Akzeptanzkriterien (5-7 Checkboxen)

- [ ] GFM (Tabellen, `~~strike~~`, `- [ ]`-Tasks, Autolinks) rendert korrekt.
- [ ] `[[Ziel]]`, `[[Ziel|Alias]]`, `[[Ziel#Header]]`, `[[Ziel#^block]]` werden erkannt; unaufgelöste Ziele erhalten eine `is-unresolved`-Markierung.
- [ ] `![[bild.png|300]]` rendert ein Bild mit Breite 300; `![[Note]]` bettet die Notiz gerendert ein.
- [ ] Callouts `> [!note]`/`tip`/`warning`/etc. rendern mit Titel + Body; `-`/`+`-Faltung funktioniert.
- [ ] `==highlight==` und `%%comment%%` (nicht gerendert) funktionieren; Roundtrip verändert die Quelle nicht.
- [ ] Roundtrip-Test: Parsen → Serialisieren ist für alle Beispiel-Snippets byte-identisch.
- [ ] Unbekannte/fehlerhafte OFM-Syntax (z. B. `[[offen`) crasht nicht, sondern fällt auf Plain-Text zurück.

## 5. Verifikation

Manuell:

1. Beispiel-Notiz mit allen Snippets aus §2 in Grimoire öffnen → Lesemodus prüfen (Links klickbar, Bild 300px, Callouts, Highlight sichtbar, Kommentar unsichtbar).
2. In Quellmodus wechseln, speichern ohne Änderung → Datei-Diff gegen Original muss leer sein.
3. Kaputte Syntax (`[[offen`, `> [!fancy]`, `==offen`) eingeben → kein Crash, Plain-Text-Fallback.

Automatisiert (`tests/obsidian-markdown.test.js`):

- Unit-Tests für Wikilink-Parsing (Ziel/Alias/Header/Block), Embed-Breite, Callout-Typ + Faltung, Highlight, Kommentar, Tasks.
- Roundtrip-Tests (parse → serialize = identisch) über Fixture-Datei mit allen Snippets.
- Prüfen mit `npm test`.

## 6. Grimoire-Aufwand (S/M/L)

M — eigener OFM-Layer über bestehendem Markdown-Renderer; kein Editor-Neubau, aber Tokenizer + Roundtrip-Tests sind substanziell. Live-Preview wäre L (separat speccen).

## 7. Offene Entscheidung

Eigener minimaler OFM-Parser (volle Roundtrip-Kontrolle, mehr Aufwand) vs. bestehende Library (z. B. remark-Erweiterung) + Custom-Serializer — Library spart Zeit, riskiert aber Serialisierungs-Drift bei Wikilinks/Embeds.
