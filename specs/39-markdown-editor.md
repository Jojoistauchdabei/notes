# SPEC-39: Markdown-Editor mit Live-Vorschau

- Kategorie: Werkzeug / Dokumentformat
- Status: umgesetzt
- Ersetzt: nichts – `js/markdown.js` (OFM-Subset für Textboxen in `index.html`) bleibt
  unangetastet; der Editor ist eine eigene Seite mit eigenem, stärkerem Renderer.

## 1. Beschreibung

`md.html` ist ein vollwertiger Markdown-Editor als eigene Seite der App (wie
`present.html` und `agent.html`), erreichbar über **✎ Markdown** in der Kopfzeile
des Notizbuchs. Kern ist eine Live-Vorschau nach dem markText-Prinzip: getippt
wird nicht Quelltext, sondern das gerenderte Dokument. Die Markdown-Zeichen
liegen in `contenteditable="false"`-Spans und sind nur in dem Block sichtbar, in
dem der Cursor steht.

Als Parser dient **markdown-wasm** (WebAssembly, CommonMark + GFM: Tabellen,
Strikethrough, Aufgabenlisten, Autolinks). Es liegt vendored unter `js/vendor/`
(MIT) – kein CDN, kein `node_modules`, offline lauffähig, kein Build-Schritt
(`npm test` und `npm run build` brauchen weiterhin keine Installation).

Darüber liegt der OFM-Layer aus SPEC-13: Wikilinks, Embeds, Callouts,
`==Highlight==`, `%%Kommentar%%` und die halbe Aufgabe `- [/]`.

## 2. UI / Verhalten / Aufbau

```text
Kopfzeile   Titel · Modus (✎ Live / ⌨ Quelle / 👁 Lesen) · Neu/Speichern/Hilfe/Design
Seitenleiste  Dokumentliste (Filter über Titel und Text) · Gliederung · Kennzahlen
             ⬇ .md · ⬆ Öffnen · ⧉ duplizieren · 🖨 · 🗑
Bühne       Werkzeugleiste (nur in der Live-Ansicht) + eine von drei Flächen
Statuszeile  Parser-Status · Meldungen
```

Drei Ansichten:

- **Live** – `contenteditable` mit gerendertem Inhalt. Beim Tippen wird **nicht**
  neu gerendert (das würde den Cursor zerstören); die Quelle wird aus der DOM
  serialisiert (350 ms verzögert) und gespeichert (700 ms verzögert). Neu
  gerendert wird nur an sicheren Stellen: Moduswechsel, `Esc`, Blur, Einfügen,
  Werkzeugleisten-Klick – der Cursor kehrt über Blockindex + Textoffset zurück.
- **Quelle** – `<textarea>` mit echtem Markdown (Strg+E). Für Grobmachen und
  für kaputte Syntax.
- **Lesen** – nur gerendert, keine Marker, sinnvoll zum Drucken/PDF.

Render-Pipeline (`js/md-render.js`, reine Strings, ohne DOM):

```text
Quelle
  → Code sichern (```-Blöcke, `inline`)  → OFM-Vorbereitung (Wikilinks, Embeds,
    ==mark==, %%comment%%, - [/])        → markdown-wasm (CommonMark+GFM)
  → Callouts aus Blockquotes             → Sanitizer (js/sanitize.js)
  → Marker-Spans (nur Live)              → HTML

HTML → Marker entfernen → Blöcke (h1-h6, p, ul/ol inkl. Nestung, table,
pre, blockquote, div.callout) → Inline (b/i/code/mark/del/a/img/checkbox)
→ Markdown mit Escapes
```

Anschläge: Überschriften-Sprünge (`id`), Tabellen, klickbare Aufgaben-Kästchen
(`offen → erledigt → halb → offen`), Wikilink-Klick (öffnet das Dokument oder legt
es mit `# Titel` an), Gliederung aus der Quelle, Wort/Zeichen/Lesezeit, Import
mehrerer `.md`/`.txt`, Export als `.md`, `beforeunload`-Schutz, Drucklayout.

Speicher: IndexedDB `fw-md`, Store `docs` (`{id, title, source, createdAt,
updatedAt}`), localStorage als Spiegel und Fallback (`js/md-store.js`). Getrennt
vom Notizbuch, damit Markdown-Dateien nicht im Buch-Export landen.

## 3. User-Story

Als Notizbuch-Nutzerin möchte ich lange Texte direkt als Markdown tippen – ohne
zwischen Quelltext und Vorschau zu pendeln und ohne mich an die Syntax zu
erinnern –, damit Gliederung, Tabellen und Aufgaben sofort so aussehen wie im
Notizbuch und meine Dateien trotzdem echtes, portables Markdown bleiben.

## 4. Akzeptanzkriterien

- [x] `**`, `*`, `~~`, `` ` ``, `==`, `##`, `[[…]]` sind unsichtbar, solange der
      Cursor woanders ist, und erscheinen im aktiven Block wieder.
- [x] Tippen ändert die Quelle ohne Cursor-Sprung; `Esc`, Blur und
      Werkzeugleisten-Klicks rendern neu und lassen den Cursor an Ort und Stelle.
- [x] Tabellen, verschachtelte Listen, Aufgaben (auch `[/]`), Zitate, Bilder und
      Codeblöcke mit Sprachkennung werden gerendert und überstehen den Roundtrip.
- [x] Roundtrip `serialize(render(q))` ist für typische Notizen byte-identisch
      und für jede Eingabe stabil (zweimal dieselbe Quelle), getestet in
      `tests/md-editor.test.js`.
- [x] OFM: `[[Ziel|Alias]]`, `![[bild.png|300]]`, `> [!note]` (mit `-`/`+`),
      `==Mark==`, `%%Kommentar%%` gerendert und verlustfrei zurückgeschrieben.
- [x] Aufgaben-Kästchen sind klickbar und schreiben `[ ]`/`[x]`/`[/]` in die Quelle.
- [x] Kein rohes HTML im Ergebnis, keine `javascript:`-URLs, kein `<script>`
      (Sanitizer wie bei den Textboxen, `NO_HTML_BLOCKS` zusätzlich).
- [x] Dokumente liegen in IndexedDB und überleben einen Neustart; Export/Import
      als `.md` funktionieren.
- [x] Offline: Parser und `.wasm` liegen im Precache, `md.html` ist im
      Service-Worker-Precache und im dist-Shell.
- [x] Alle 16 Designs greifen (die Seite lädt `css/styles.css` + `themes.js`
      wie das Notizbuch), Druck blendet Rahmen und Marker aus.

## 5. Verifikation

Automatisiert:

- `npm test` – `tests/md-editor.test.js`: Parser/Flags, Marker, OFM, Callouts,
  Serializer (Blöcke, Listen, Tabellen, Aufgaben, Callouts, Browser-Reste,
  Escapes), Roundtrip-Identität und -Stabilität, kaputte Syntax, Sicherheit,
  Store (anlegen/lesen/sortieren/umbenennen/duplizieren/löschen/Neustart),
  Verdrahtung von `md.html`, `index.html` und `js/vendor/`.

Manuell (der Node-Test kann keine Caret-Interaktion prüfen):

1. `md.html` öffnen → Startdokument mit Überschrift, Tabelle, Aufgabe und Codeblock.
2. In einen Absatz tippen: Marker erscheinen nur dort, `Esc` rendert neu, Cursor
   bleibt stehen.
3. Aufgabe anklicken: offen → erledigt → halb → offen; Quelle in **⌨ Quelle**
   gegengeprüft.
4. `[[Testnotiz]]` anklicken → neues Dokument öffnet sich.
5. Design wechseln, Seite neu laden, offline schalten: alles noch da.

## 6. Aufwand

M — Parser und Sanitizer waren da, der OFM-Layer (Wikilinks/Callouts/Highlight)
existierte als Spec; neu sind Renderer-Pipeline, Marker-Technik, Cursor-Rettung
beim Neurendern, Store, Oberfläche und Build-/SW-Verdrahtung.

## 7. Offene Entscheidung

`js/markdown.js` (Textboxen im Notizbuch) bleibt bewusst der alte, dependency-freie
OFM-Subset-Renderer. Aufwand einer Zusammenführung: `md-render.js` bräuchte einen
HTML→HTML-Pfad statt HTML→Markdown (die Textboxen speichern HTML), und der
WASM-Parser müsste in das App-Bundle – dort ist er nicht vorgesehen. Wenn die
Textboxen später denselben Renderer nutzen sollen, ist das ein eigenes Vorhaben
(SPEC-13 Update), kein Umbau dieses Editors.