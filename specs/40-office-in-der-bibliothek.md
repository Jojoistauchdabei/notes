# SPEC-40: Office in der Bibliothek

- Kategorie: UI / Dokumente
- Status: In Arbeit (Stufe 1 umgesetzt: Dokument + Writer)
- Ersetzt: nichts (ergänzt die Bibliothek um Office-Dokumente)

## 1. Warum ein eigenes Office statt ONLYOFFICE

Ursprünglich war ein ONLYOFFICE-WASM-Build als Basis vorgesehen. Dagegen sprachen
drei Dinge, die nicht wegdiskutierbar waren:

- **Lizenz.** ONLYOFFICE ist AGPL-3.0 mit Zusatzbedingungen nach §7 (Logo muss
  erhalten bleiben, keine Markenrechte). Eingebettet in Federwerk wäre Federwerk
  ein AGPL-Derivat mit Pflicht zur Veröffentlichung des Quelltexts — auch für die
  signierten Desktop-Installer. Das ist eine Entscheidung, die nicht nebenbei
  beim Feature-Bau fallen darf.
- **Größe.** Der WASM-Build ist ~445 MB über ~3.200 Dateien. In `dist/` würden
  Release-ZIP und Desktop-/Android-Installer (die gegen `../dist` bauen) um
  dieselbe Größe wachsen.
- **Co-Editing war dort ohnehin nicht erreichbar.** Der Build ist bewusst
  serverlos; echtes gleichzeitiges Bearbeiten gibt es nur über den Connector im
  Document Server. Ein CRDT hätte nichts zum Andocken.

EuroOffice löst das nicht: es ist derselbe ONLYOFFICE-Code plus laufender
Markenrechtsstreit mit Ascensio.

Also: eigenes Office, ONLYOFFICE-ähnliche Oberfläche, die gemeinsamen
Funktionen, ohne die Fremdabhängigkeit.

## 2. Aufbau

### Office-Dokumente sind Bücher

Ein Office-Dokument ist **kein eigener Datenbestand**, sondern ein Buch mit
`office`-Feld:

```
{ id, title, updatedAt, folderId, pages: [],
  office: { kind: 'doc' | 'sheet' | 'slides', ... } }
```

Damit funktionieren Ordner, Ordnerfilter, `moveBook`, Suche, Duplizieren,
Löschen und der Appwrite-Sync **unverändert mit** — es ist derselbe Pfad wie bei
Karteikarten-Decks, die schon heute über `isFlashDeck(b)` einen eigenen Buchtyp
im selben Raster bekommen. Kein zweiter Container, keine zweite Ablage.

### Module

| Datei | Aufgabe |
| --- | --- |
| `js/office-doc.js` | Modell, Normalisierung, Klartext, Statistik. Rein, DOM-frei, in Node testbar. |
| `js/office-writer.js` | Writer: Blöcke, Inline-Formatierung, Toolbar, Tastatur. |
| `css/styles.css` (Abschnitt `/* Office */`) | Styles des Office-Bereichs. Bewusst in der App-Datei, nicht als eigenes Stylesheet — sonst müsste `scripts/build-dist.js` erweitert werden. |

`js/office-doc.js` ist bewusst DOM-frei: die reine Logik ist damit in Node
testbar, wie es im Repo üblich ist (`js/store.js`, `js/appwrite-files.js`).

### Blöcke statt eigenem Zeilenmodell

Ein Writer-Absatz ist `{ type, html }` mit **bereits sanitiztem** HTML über
`GrimoireSanitize.sanitizeHtml()` — dasselbe Sicherheitsmodell, das Federwerk
für Textboxen benutzt. Kein eigener CRDT-ähnlicher Inline-Modell-Layer: der
Aufwand steht in keinem Verhältnis zum Nutzen, und `sanitizeHtml` ist bereits
bewusst geprüft.

Absatztypen: `p`, `h1`, `h2`, `h3`, `ul`, `ol`, `quote`, `code`, `hr`.

### Ansicht

`#viewOffice` liegt neben `#viewLibrary` und `#viewBook`. Beim Öffnen eines
Office-Buchs wechselt die Karten-`onclick` je nach `kind` in die Office-Ansicht;
„Zurück" führt in die Bibliothek. Der Eintrag in der Bibliothek bekommt ein
eigenes Badge ( wie bei Decks) und eine Vorschau aus dem Klartext.

## 3. Stufen

| Stufe | Inhalt | Stand |
| --- | --- | --- |
| 1 | Modell, Bibliotheks-Integration, Writer | umgesetzt |
| 2 | Tabelle: Raster, Zellreferenzen, Formeln, Berechnungsreihenfolge | offen |
| 3 | Präsentation: Folien, Textfelder, Präsentationsmodus | offen |
| 4 | Austausch: CSV/HTML/Markdown rein und raus | offen |

**Echte `.docx`/`.xlsx`/`.pptx` sind nicht enthalten.** OOXML schreiben und lesen
ist möglich (`js/gnzip.js` kann ZIP, OOXML ist ZIP+XML), aber es ist ein eigenes
Projekt und wird nicht behauptet, bevor es läuft. Was jetzt existiert, ist
Federwerks eigenes Format plus die Textformate.

## 4. Bewusst nicht gemacht

- **Kein Co-Editing.** Zwei Personen in einem Dokument bleiben serialisiert.
- **Keine echten Office-Dateiformate.** Siehe Stufe 4.
- **Kein Server.** Ablage bleibt lokal (IndexedDB) plus der bestehende
  Appwrite-Sync. Ein Backend für das spätere Selbsthosting ist nicht Teil
  dieser Stufe.