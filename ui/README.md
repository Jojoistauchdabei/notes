# Federwerk UI-Rework: shadcn/ui + Liquid Glass

Zwei neue UI-Varianten der **unveränderten** Federwerk-App (`js/`, Canvas,
Sync, Export, GoodNotes-Import …), plus gemeinsame Basis.

```
ui/
├── shared/                      # Gemeinsame Basis (einmal, von beiden genutzt)
│   ├── shadcn-tokens.css        # shadcn/ui Design-Tokens (Hell/Dunkel) + App-Aliase
│   ├── shadcn-components.css    # shadcn-Komponenten + Re-Style der App-Klassen
│   ├── app-shell.css            # Sidebar/Topbar/Canvas-Fullscreen/Sheet/Responsive
│   ├── tailwind.css             # Kompiliertes Tailwind (token-gemappt, kein Preflight)
│   ├── ui-kit.js                # shadcn-Komponenten in Vanilla-JS (window.FWUI)
│   ├── theme-switcher.js        # Hell/Dunkel + Variante shadcn⇄Liquid (window.FWTheme)
│   ├── keyboard-shortcuts.js    # Zusätzliche Shortcuts + Übersicht (window.FWShortcuts)
│   └── federwerk-core.js        # Shared JS-Modul: Fassade über App-Business-Logik
│                                #   (window.FederwerkCore + window.FederwerkBus)
├── shadcn/                      # Variante 1: shadcn/ui
│   ├── index.html
│   ├── css/app.css
│   └── js/app.js
└── liquid/                      # Variante 2: shadcn/ui + Liquid Glass
    ├── index.html
    ├── css/liquid-glass.css
    └── js/app.js
```

## Ausführen

Statisch vom Repo-Root serven (Basis-URL `<base href="../../">`):

```sh
python3 -m http.server 8137        # oder npm run build && dist serven
# http://127.0.0.1:8137/ui/shadcn/index.html
# http://127.0.0.1:8137/ui/liquid/index.html
```

Deep-Links: `?ui=shadcn|liquid` (Variante), `?scheme=hell|dunkel|auto`
(Federwerk-kompatibel) / `light|dark`, `?theme=…` wird ignoriert (kein
Papier-Theme in diesen Varianten).

## 1) Analyse der bestehenden UI (Vorher)

`index.html` (Root) + `css/styles.css`, `css/canvas.css`, `css/themes/*`,
`js/themes.js`, `js/app.js`, `js/canvas.js`, …

**Komponenten (Vorher):**
- **Header/Topbar** `.header` + `.header-buttons`/`.header-group`, Brand,
  Export/Import JSON, GoodNotes, Markdown, Druck/PDF, Theme-Picker
  (auto via `js/themes.js`).
- **Library** `#viewLibrary`: `#librarySearch`, Graph/Craft/Neues Buch/Deck/
  Office, `#folderChips`, **Folder-Sidebar** `.folder-sidebar` + `#folderNav`
  (Drag&Drop, Rechtsklick-Menü, Klappen), `#libraryGrid`, `#conflictBanner`,
  „Über Federwerk", Liveshare, Appwrite-Cloud.
- **Workspace** `#viewBook`: Split-Screen `.split-container`/`.split-pane`
  (`#pane0/#pane1`, `#splitDivider`, `#splitRatio`, Split-Schalter),
  **Toolbar** `.toolbar` `#toolButtons` (Stift/Canvas/Marker/Radierer/Text/
  Auswahl/Laser, Farbe `#penColor`, Stärke `#penSize`, Radierer-Modi,
  `#fingerDrawToggle`, Undo/Redo, Doc-Import, Vorlage, Bild, PDF, Texteditor,
  Live, Präsentieren, Seite leeren), **Pane-Bar** `.pane-bar`
  (`#bookSelect`, `#bookTitle`, `#paperSelect`, `#pageFormat`, +Seite,
  Duplizieren, Löschen, PNG, HG-entfernen), **Canvas** `.stage` +
  `#drawCanvas`/`#overlayCanvas`/`#bgLayer`/`#imgLayer`/`#textLayer`,
  **Page-Rail** `#pageRail`, **Status-Line**, Rail-Toggle.
- **Canvas-Schreibfluss** `js/canvas.js`: eigenes schwebendes `#canvasToolbar`
  + `body.canvas-writing`, `body.canvas-flow-open`, Pinch-Zoom, Palm-Rejection,
  PNG/PDF. (= bereits „Canvas full-screen mit Overlay-Controls".)
- **Modals/Dialogs** `.editor-overlay`/`.editor-modal` + `.editor-header/
  .editor-toolbar/.editor-body/.editor-footer`: Texteditor (`#editorOverlay`,
  `#editorContent`, `#editorSource`, Rich/Markdown `Ctrl+E`), Seitenvorschau
  (`#previewOverlay`,`#previewCanvas`), Server/Cloud (`#awOverlay`, Tabs
  `#awTabLogin/#awTabRegister`, `#awLoginPane/#awRegisterPane`, …),
  Sync-Diagnose (`#awDiagnosticsOverlay`), Karteikarten (`#flashOverlay`,
  `#flashBody`, Tabs Karten/Lernen/Auswertung, `#flashImgFile/#flashCsvFile`),
  Graph (`#graphOverlay`,`#graphCanvas`,`#graphBookSelect`,`#graphDepth`),
  ArtCraft (`#craftOverlay`,`#craftAppGrid`), **Liveshare** (`#liveOverlay`,
  `#liveBar`, Tabs Hosten/Beitreten, …), `#liveBar`.
- **Office** `#viewOffice`, `#officeToolbar`, `#officeBlocks`, DOCX Import/
  Export.
- **Dialoge** `js/dialog.js` `FederwerkDialog.confirm/prompt`
  (`.editor-overlay`, Tastatur, Queue).
- **Tastatur (Vorher):** `P` Stift, `L` Laser, `Esc`, `PageUp/PageDown`,
  `Home/End`, `Ctrl+Shift+B` Split, `Ctrl+Alt+←/→` Pane, `Ctrl+E`/`Ctrl+Enter`
  Editor, Preview `←/→/Enter/Esc`, …

## 2) shadcn/ui-Variante (`ui/shadcn/`)

**Tailwind CSS + shadcn/ui.** Da Federwerk Vanilla-JS ist (kein React), sind
die shadcn/ui-Komponenten 1:1 als **Vanilla-JS/CSS** mit **identischen
shadcn-Klassen, -Struktur und -Tokens** nachgebaut (shadcn ist per Design
kopierbarer Source, kein geschlossenes Framework). Tailwind ist die
Styling-Engine; die Komponenten sind zusätzlich semantisch klassifiziert.

**Komponenten** (über `window.FWUI`, Auto-Wiring per `data-fw-*` + CSS):
Button, Card, Badge, Separator, Label, Input, Kbd, Skeleton, ScrollArea,
**Dialog**, **AlertDialog**, **Sheet**, **DropdownMenu**, **Popover**,
**Tooltip**, **Tabs**, Accordion/Collapsible, Switch, Slider, Toggle/
ToggleGroup, **Sidebar**, **Sonner/Toast**, Command, Toolbar, Breadcrumb,
Pagination. (App-eigene `.mini-button`, `.editor-overlay`, Tabs, etc. sind
re-styled; Federwerks `FederwerkDialog` bleibt erhalten.)

**Layout:** klare App-Shell — **collapsible Sidebar** (`shadcn Sidebar`,
`Ctrl+B`, Zustand `localStorage`, Mobile-Sheet/Scrim, icon-only-Collapsed),
**icon-based Toolbar** (shadcn Toggle-Group-Stil, `size=icon`, Tooltips,
Separators, `#toolButtons` bleibt), **Canvas full-screen** + schwebende
**Overlay-Controls** (`.fw-overlay-controls`, `body.fw-canvas-fullscreen`,
`data-fw-canvas-fullscreen`, plus eingebauter Canvas-Schreibfluss).
**Responsive** Desktop ≥900px / Mobile. **Dark/Light**.
**Keyboard-Shortcuts** (siehe unten).

## 3) shadcn + Liquid Glass (`ui/liquid/`)

**Gleiche shadcn-Komponenten/Tokens + Logik**, zusätzlich
`ui/liquid/css/liquid-glass.css`:

- **Glas-Panels:** `backdrop-filter: blur(…) saturate(…)`, halbtransparente
  Flächen (`--card/--popover/--sidebar/--muted/--secondary` rgba), auf
  `.box/.card/.toolbar/.header/.editor-modal/.dropdown-content/.fw-sidebar/
  #canvasToolbar/.fw-overlay-controls/.fw-toast/…`.
- **Lichtkanten via border-box-Verlauf:** `border:1px solid transparent` +
  `background: linear-gradient(...) padding-box, linear-gradient(135deg, …)
  border-box;` + `box-shadow: inset 0 1px 0 …, …`.
- **Glas-Pillen-Buttons:** `border-radius: 9999px`, Glas + Marken-Gradient
  + Glow, `picked/active`-State.
- **Smooth Hover:** `transform translateY/scale`, Glow, Sheen `::before`,
  `cubic-bezier(0.2,0.8,0.2,1)`, `@media (prefers-reduced-motion)` Fallback.
- Animierter Pastell-Mesh-Hintergrund; Paper/Canvas bleibt deckend (Tinte
  lesbar); `@supports` Fallback ohne `backdrop-filter`.

## 4) Gemeinsame Basis

**Gleiche App-Logik in beiden Varianten** — Single Source of Truth:

- **Original-App-Module** `js/*.js` (Canvas, Sync `appwrite-*`, Liveshare,
  GoodNotes `goodnotes.js`/`gnzip.js`, Export/Import `app.js`, Split,
  Office, Flashcards, Paper-Templates, …) werden **identisch** geladen;
  **identischer DOM-Vertrag** (alle IDs/Klassen/`data-*`, Inline-Handler,
  Original-Script-Reihenfolge, `.view`/`.active`, `.picked`, `.inactive`,
  `.mini-button`, `.stage*`, `.pane-bar`, `#toolButtons`, …). **Nichts
  dupliziert**, beide Varianten funktionieren gleich.
- **Shared JS-Modul** `ui/shared/federwerk-core.js`
  (`window.FederwerkCore`: sicherer `call`, `ns`, `namespaces`, `ready`,
  `onAppReady`, `bus`; `window.FederwerkBus`) + `ui/shared/ui-kit.js`.
- **CSS-Basis** `ui/shared/*.css`.

### Theme-Switcher (`window.FWTheme`)

- **Variante wechseln shadcn ⇄ Liquid Glass:** Sidebar-Button
  (`data-fw-variant-toggle`), `Ctrl+Shift+L`, `FWTheme.toggleVariant()`,
  `FWTheme.applyVariant('shadcn'|'liquid')`, `?ui=…`; `<html data-ui-variant>`
  + Variant-CSS `#fw-variant-css`; persistiert `fw-ui-variant`.
- **Dark/Light:** Sidebar-Button (`data-fw-scheme-toggle`), `Ctrl+Shift+D`,
  `FWTheme.toggleScheme()`, `applyScheme('light'|'dark'|'auto')`,
  `?scheme=…`; `data-scheme` + `.dark`; persistiert `fw-ui-scheme`;
  `auto` folgt `prefers-color-scheme`. (shadcn-Dark-Tokens + kompatibel zur
  Federwerk-Theme-Engine.)

### Keyboard-Shortcuts

App-eigene bleiben; **ergänzt** (nicht in Eingabefeldern/Contenteditable):

| Taste | Aktion |
|---|---|
| `Ctrl/Cmd + B` | Sidebar ein-/ausklappen |
| `Ctrl/Cmd + Shift + D` | Dunkel-/Hellmodus |
| `Ctrl/Cmd + Shift + L` | Variante shadcn ⇄ Liquid Glass |
| `Ctrl/Cmd + K` | Suche fokussieren / Command |
| `Ctrl/Cmd + /` | Shortcut-Übersicht |
| `Ctrl/Cmd + Z` / `Ctrl/Cmd + Shift + Z` | Rückgängig / Wiederherstellen (Canvas; im Texteditor nativ) |
| `P` / `L` / `Esc` | Stift / Laser / schließen (App) |
| `PgUp`/`PgDn`, `Home`/`End` | Seite blättern (App) |
| `Ctrl/Cmd + Shift + B`, `Ctrl/Cmd + Alt + ←/→` | Split / Pane (App) |
| `Ctrl/Cmd + E` | Texteditor (App) |

Dialog-/Sheet-**Overlay-Klick + Esc**; `window.FWShortcuts.show()`.

## Build

`ui/shared/tailwind.css` ist ein einmalig kompiliertes Tailwind (v3.4,
`darkMode` class/`[data-scheme=dark]`, shadcn-Token-Mapping, Safelist,
**ohne Preflight**, damit App-Styles nicht zerschossen werden). Die
`index.html`s sind aus dem originalen Body + Shell generiert (Single Source
`index.html`; DOM bleibt identisch).

## Funktionalität erhalten

Canvas-Schreibfluss (Stift/Marker/Radierer, Druck, Palm-Rejection, Pinch/
Pan/Zoom, Canvas-Toolbar, PNG/PDF), Seiten/Paper-Templates/Formate, Undo/
Redo, Text-/Bild-/PDF-/Doc-Import, Split-Screen, Liveshare, Appwrite-Sync/
Datei-Sync, Export JSON/PNG/DOCX, GoodNotes-Import, Office, Karteikarten,
Graph, Markdown-Editor-Link, Präsentieren, PWA/Service-Worker, … — **alle
in beiden Varianten**, unverändert.
