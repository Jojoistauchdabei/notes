# Federwerk-Notizformat (`federwerk-1`)

Menschenlesbare Doku zum JSON-Export der Federwerk-Handschrift-App.
Maschinenlesbar: `federwerk.schema.json` (JSON Schema), Einstieg für LLMs: `llms.txt`.
Format-Metadaten setzt `js/format-doc.js` (`GrimoireFormat.attachFormatMeta`).

## Überblick

- **Gesamt-Export** (`exportAllJSON`, Datei `grimoire-export.json`):
  `{ books, folders, openBookId, openPageId, $schema, formatVersion, formatDoc, _ai }`
- **Einzelbuch-Export** (`exportBookJSON`, Datei `grimoire-<Titel>.json`):
  `{ id, title, paper, updatedAt, folderId, lang, pages, $schema, formatVersion, formatDoc, _ai }`
- **Metadaten**: `$schema` → `./federwerk.schema.json`, `formatVersion` → `"federwerk-1"`,
  `formatDoc` → `./FEDERWERK_FORMAT.md`, `_ai` → Inline-Lesehinweis für KI-Chats
  (`{format, version, schema, fields, promptHint}`).
- **Import** (`importAllJSON`) ignoriert die Meta-Felder; alte Exporte ohne Meta bleiben lesbar.

## Koordinaten

- Zeichenfläche (Canvas) pro Seite: **1000 × 1414 px** (A4-Verhältnis, Default).
- Strokes: absolute Canvas-Pixel der jeweiligen Seite (`x`: 0–Seitenbreite, `y`: 0–Seitenhöhe).
- Texte/Bilder: **normiert 0–1** relativ zu Seitenbreite/-höhe.

## Datenmodell

### Buch

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | string | Eindeutige Buch-ID |
| `title` | string | Buchtitel |
| `paper` | string | Papiervorlage, Buch-weit (Design + Maße, Katalog `js/paper-templates.js`: `blank-a4`, `blank-a5`, `blank-square`, `blank-letter`, `lined-a4`, `lined-margin-a4`, `grid-a4`, `grid-large-a4`, `dots-a4`, `cornell-a4`, `todo-a4`, `music-a4`). Legacy `""` → `blank-a4`, `"lined"` → `lined-a4`, `"grid"` → `grid-a4` |
| `updatedAt` | number | Änderungszeit (ms seit Epoch) |
| `folderId` | string \| null | Ordner-ID oder `null` (= Unsortiert) |
| `lang` | string | Suchsprache des Buchs (z. B. `"de"`) |
| `pages` | Page[] | Seiten in Reihenfolge |

### Seite

| Feld | Typ | Bedeutung |
|---|---|---|
| `id` | string | Seiten-ID |
| `strokes` | Stroke[] | Handschrift-Pfade |
| `texts` | TextBox[] | Getippte Textboxen |
| `images` | Image[] | Eingebettete Bilder |
| `bg` | string \| null | Seiten-Hintergrund als Bild-`dataURL` oder `null` |
| `size` | `{w,h}` \| fehlt | Seitenformat in Canvas-px (Vorlagenwechsel/Bild-/PDF-Import/Seitenformat-Wahl). Fehlt = A4-Default (1000×1414), wird nicht persistiert. `page.size` gewinnt immer gegen das Buch-Template (PDF-Seiten bleiben unangetastet) |

### Stroke (Handschrift)

`{ tool, color, size, points[{x, y, p}], ... }`

- `tool`: `"pen"` (Deckstrich) oder `"marker"` (halbtransparenter Highlighter).
- `color`: CSS-Farbe, `size`: Strichbreite in Canvas-px.
- `points`: Pfadpunkte; `x`/`y` in Canvas-px, `p` = Stift-Druck 0–1 (optional, Default 0.5).
- Optional (Shapes): `closed`, `fill` + `fillAlpha`, `dash` (Strichelung), `alpha`, `highlighter`.

### TextBox (getippt)

`{ id, x, y, html }` – `x`/`y` normiert (0–1), `html` ist Rich-Text
(`h1`–`h3`, `b`, `i`, `u`, Listen, `style`-Attribute für Farbe/Ausrichtung/Größe).

### Image

`{ id, x, y, w, src }` – Position/Breite normiert (0–1, Höhe aus Seitenverhältnis),
`src` ist eine `dataURL` (`data:image/...;base64,...`) oder eine App-interne
`blob:`-URL (nur innerhalb der laufenden App auflösbar – beim Export via
`GrimoireStore.inlineBook` werden Blobs zu dataURLs aufgelöst).

### Ordner

`{ id, name, parentId, createdAt, updatedAt }` – flache Liste, kein Verschachteln in der UI.

## GoodNotes-Export

`.goodnotes` ist ein separates Containerformat (siehe `specs/34-goodnotes-format-container.md`).
Der Export bettet zusätzlich `federwerk.json` ein
(`{format, formatVersion, title, pages, exportedAt}`) – GoodNotes und der
Federwerk-Import (`GoodNotes.parseDocument`) ignorieren die Datei.

## Beispiel (gekürzt)

```json
{
  "$schema": "./federwerk.schema.json",
  "formatVersion": "federwerk-1",
  "formatDoc": "./FEDERWERK_FORMAT.md",
  "_ai": { "format": "federwerk-notebook", "version": "federwerk-1", "promptHint": "..." },
  "books": [
    {
      "id": "abc123", "title": "Notizen", "paper": "grid",
      "folderId": null, "pages": [
        {
          "id": "p1",
          "strokes": [{ "tool": "pen", "color": "#2a1a0e", "size": 3,
                        "points": [{ "x": 100, "y": 200, "p": 0.5 }] }],
          "texts": [{ "id": "t1", "x": 0.08, "y": 0.05, "html": "<h2>Hallo</h2>" }],
          "images": [],
          "bg": null
        }
      ]
    }
  ],
  "folders": []
}
```

## Versionen

- `federwerk-1` (aktuell): wie oben beschrieben.
