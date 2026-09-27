# SPEC-37: Continuous Scroll im Dokument

- Kategorie: UI / Navigation
- Status: Umgesetzt
- Ersetzt: Scroll-Navigation (Wheel blättert Seiten, `js/scrollnav.js`)

## 1. Beschreibung

Das Dokument wird als **ein langer Stapel** gelesen, nicht Seite für Seite
geblättert. Alle Seiten liegen untereinander in einem einzigen Scroll-Container;
der Nutzer scrollt wie in jeder Notiz-App. Welche Seite "gelesen" wird, ergibt
sich aus der Scrollposition — nicht aus einer Geste, die den Browser-Scroll
abfängt.

Vorher fing ein `wheel`-Handler auf `.stage-wrap` jeden vertikalen Scroll ab
(`preventDefault`) und machte daraus einen diskreten Seitenwechsel. Das kostete
das native Scrollen komplett, ließ am Dokumentrand nichts mehr zu (es wurde
auch am Anfang/Ende geschluckt) und brachte auf Touch-Geräten zusätzlich
`touch-action: none`, weil der Finger-Swipe dem Blättern belong.

## 2. Aufbau

- **Scroller**: `.stage-scroll` (je Pane) ist der einzige Scroll-Container,
  `touch-action: pan-y` — vertikales Panning bleibt Browser-Sache.
  `--stage-h` wird von `syncStageViewport()` aus den *gemessenen* Höhen von
  Header, Toolbar und Statuszeile gesetzt, damit der Container genau den freien
  Sichtbereich nutzt (kein Nachziehen pro Breakpoint).
- **Stack**: `.stage-stack` ist ein Flex-Column mit `gap`. Jede Seite ist ein
  `.page-slot` mit `aspect-ratio` aus dem Seitenformat (`--slot-ar`).
- **Bühne**: pro Seite eine `.stage` mit `bgLayer`, `drawCanvas`,
  `overlayCanvas`, `imgLayer`, `textLayer` (per `data-part` adressiert).

### Zwei Invarianten

1. **Die Höhe kommt vom Slot, nicht vom Inhalt.** Mounten/Unmounten einer Seite
   ändert das Layout um keinen Pixel → Scrollen bleibt ruckelfrei. Deshalb ist
   `aspect-ratio: auto` auf `.page-slot > .stage` und die Slot-Höhe wird beim
   Mounten nie neu geschrieben.
2. **Nur die aktive Seite trägt die kanonischen IDs** (`#stage`, `#drawCanvas`, …).
   `promoteStageEl()` hängt sie um. Dadurch zeigt der gesamte Bestand, der per
   `$(eid(...))` sucht (Canvas-Export, Liveshare-Cursor, `currentPage()`-Pfade),
   unverändert auf die gelesene Seite. Nachbarseiten tragen `data-part` statt `id`.

### Geometrie

`js/pageflow.js` ist DOM-frei und testbar (`tests/pageflow.test.js`):

- `buildLayout(heights, gap)` → `tops[]`, Gesamthöhe
- `windowRange(...)` → Mount-Fenster inkl. Overscan
- `pageFromScroll(...)` → gelesene Seite an der Fokuslinie (`lead` = 12px);
  am unteren Anschlag gewinnt die letzte Seite, sonst meldete die Fokuslinie
  eine kaum sichtbare Seite ("Seite 9/12" am Ende eines 12-Seiten-Dokuments)
- `offsetForPage(...)`, `dominantPageIndex(...)`, `neighborIndex(...)`

`js/app.js` macht nur das DOM-Glue: `ensureStackFor`, `measureFlow`,
`syncMountFor`, `mountSlotFor`/`unmountPageId`, `promoteStageEl`,
`activatePanePage`, `scrollPaneToPage`, `stepPanePage`.

## 3. Verhalten

- **Windowing**: nur Sichtbereich + 600px Overscan bekommen Canvases. 300
  Seiten → höchstens ~3 gemountet. Unmontierte Bühnen kommen in einen Pool
  (gedeckelt auf 8) und werden wiederverwendet.
- **Reihenfolge im Scroll-Handler**: erst die neue aktive Seite setzen, *dann*
  fenstern. Sonst blockiert die noch aktive alte Seite ihren eigenen Unmount und
  ihre Canvas bleibt belegt.
- **Nachbarsprünge**: die aktive Seite wird zusätzlich gemountet, *ohne* das
  Fenster zu vergrößern (Sprung auf Seite 500 darf nicht 500 Canvases anlegen).
- **Zeichnen auf Nachbarseiten**: ein `pointerdown` im Capture-Phase auf dem
  Scroller aktiviert die Seite unter dem Zeiger, bevor Textbox-Handler und
  Resize-Griffe laufen (die greifen auf `currentPage()` zu). `stagePosFor(ev,
  idx, stage)` nutzt das Rechteck *dieser* Bühne.
- **Inhalt sichtbarer Nachbarseiten**: `repaintMountedNeighbors()` zieht die
  übrigen gemounteten Seiten nach, sonst zeigte eine sichtbare Nachbarseite
  veralteten Inhalt, bis man weg- und zurückgescrollt hatte. `repaintPage()`
  macht dasselbe gezielt für eine einzelne Seite (Liveshare-Übernahme).
- **Navigation**: Rail-Doppelklick, Bild auf/ab, Pos1/Ende scrollen weich auf
  die Seite. `scrollPaneToPage()` rückt nur, wenn die Seite nicht schon an der
  Fokuslinie steht — mitten in einer Seite lesen wird nicht unterbrochen.
- **Undo/Redo**: Seitenwechsel löschen die Historie nicht mehr (vorher wäre
  jeder Undo nach dem Scrollen unmöglich gewesen). `restore()` springt über die
  gespeicherte Seiten-ID selbst auf die richtige Seite.
- **Auswahl** wird bei jedem Seitenwechsel verworfen (sie gehört zu einer Seite),
  die Undo-Historie nicht.
- **Druck**: `beforeprint` mountet alle Seiten (`setFlowMountAll(true)`), weil der
  Scroller im `@media print` seine Höhenbegrenzung verliert; jeder `.page-slot`
  bricht nach einer Seite um.
- **Ohne `js/pageflow.js`** (offline, Datei fehlt) degradiert die App sauber:
  alle Seiten gemountet, normales Scrollen, die aktive Seite folgt dem Scroll
  dann nicht mehr.

## 4. User-Story

Als Notizenschreiberin will ich durch mein Dokument scrollen wie durch ein
PDF — continuous, mit Trägheit, an jeder Stelle stehen bleiben dürfen — und
nicht bei jedem Nocken eine Seite weitergeblättert bekommen, das sich anfühlt
wie ein kaputter Scroll.

## 5. Akzeptanzkriterien

- [x] Vertikales Rad-/Finger-Scrollen scrollt das Dokument nativ; nichts wird
      per `preventDefault` abgefangen.
- [x] Die Seite an der Fokuslinie gilt als gelesen: Statuszeile, Rail-Markierung
      und aktive Seite folgen dem Scroll.
- [x] Direkt unter- und überschriebene Nachbarseiten sind mit Tinte, Text und
      Bildern gerendert, nicht leer.
- [x] Zeichnen, Radieren, Textboxen und Bilder greifen auf der Seite zu, auf der
      der Zeiger steht — nicht auf der zuletzt aktiven.
- [x] Mounten/Unmounten von Seiten erzeugt keinen Scroll-Sprung (Slot-Höhe ist
      CSS-getrieben) und keine doppelten IDs im Dokument.
- [x] Ein Dokument mit 300 Seiten mountet nie mehr als wenige Seiten gleichzeitig.
- [x] Bild auf/ab, Pos1/Ende und Rail blättern; am Rand kein Wrap, sondern ein
      kurzer Blink auf der Statuszeile.
- [x] Undo/Redo funktioniert über Seitenwechsel hinweg in beide Richtungen.
- [x] Split-Ansicht: beide Pane scrollen unabhängig, jeder hält seine eigene
      aktive Seite.
- [x] Druck gibt alle Seiten aus, nicht nur das Mount-Fenster.
- [x] `npm test` grün; Geometrie in `tests/pageflow.test.js`, Architektur-Wächter
      gegen die Rückkehr des Wheel-Hijacks.

## 6. Dateien

| Datei | Rolle |
| --- | --- |
| `js/pageflow.js` | DOM-freie Layout-/Navigations-Logik (neu) |
| `js/app.js` | DOM-Glue: Slots, Mounting, ID-Wanderung, Scroll-Sync |
| `js/liveshare.js` | Cursor-Versand an `.stage-scroll` + Slot-Auflösung |
| `css/styles.css` | `.stage-scroll` / `.stage-stack` / `.page-slot`, Druck |
| `index.html` | Scroller-/Stack-Struktur, `js/pageflow.js` |
| `sw.js` | `js/pageflow.js` in die Offline-Precache-Liste |
| entfernt | `js/scrollnav.js`, `tests/scrollnav.test.js` |
