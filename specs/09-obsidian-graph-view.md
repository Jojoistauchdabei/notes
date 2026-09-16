# SPEC-09: Graph View (Global und Lokal)

- Quelle: Obsidian
- Kategorie: Feature
- Status: Vorschlag (zur Auswahl)

## 1. Beschreibung

Obsidian visualisiert das Link-Netz als Graph: Global Graph (ganzer Vault) und Local Graph (Nachbarschaft einer Notiz mit Tiefen-Slider), mit Force-Layout-Parametern, Filtern/Search, farbigen Gruppen sowie Canvas-Rendering für tausende Knoten (Stand 2025/2026). Knotengröße signalisiert Vernetzung, Klick öffnet die Notiz.

## 2. UI / Verhalten / Aufbau

Vollbild-View bzw. Sidebar-Widget: Canvas mit Knoten (Notizen, Größe ~ Backlink-Count) und Kanten (`[[Links]]`), Drag zum Pannen, Scroll zum Zoomen, Hover-Tooltip (Titel + Pfad), Klick öffnet Notiz. Controls: Depth-Slider (1–3, nur Local), Filterfeld (`path:`, `tag:`, `-`), Gruppen-Farbregeln, Force-Slider (Repel/Center/Link-Distance). Config:
```json
{ "mode": "local", "depth": 2, "filters": ["-path:Archiv"], "groups": [{ "query": "tag:#projekt", "color": "#a78bfa" }], "forces": { "repel": 120, "linkDistance": 60 } }
```
Grimoire: `<canvas>` + eigener Force-Loop in Vanilla JS (kein D3-Zwang), Daten aus Backlink-Index (SPEC-08).

## 3. User-Story

Als visueller Denker möchte ich mein Notiz-Netz als zoombaren Graphen (global + lokal mit Tiefe) filtern und einfärben, damit ich Cluster, Brücken und Waisen erkenne.

## 4. Akzeptanzkriterien

- [ ] Global Graph rendert alle Notizen/Kanten aus Fixture-Vault (mind. 30 Knoten) als Canvas.
- [ ] Local Graph zeigt nur Nachbarschaft der aktiven Notiz, Depth-Slider 1–3 verändert Menge sichtbar.
- [ ] Filter (`path:`/`tag:`/`-`) blenden Knoten live aus/ein.
- [ ] Gruppen-Regel färbt passende Knoten (z. B. `tag:#projekt` → violett).
- [ ] Klick auf Knoten öffnet die Notiz im aktiven Tab; Hover zeigt Titel.
- [ ] Pan/Zoom per Maus/Touch funktioniert, Layout stabilisiert sich (kein Dauer-Zittern).
- [ ] Leerer Vault / Notiz ohne Links zeigt Hinweis statt leerem Canvas.

## 5. Verifikation

Manuell:
1. Graph öffnen → Knotenwolke sichtbar → zoomen/pannen → Klick auf Knoten → Notiz öffnet sich.
2. Auf Local wechseln, Depth 1 vs. 3 vergleichen → Knotenzahl wächst; Filter `-path:Archiv` → Archiv-Knoten verschwinden.
3. Gruppen-Regel `tag:#x` anlegen → passende Knoten färben sich.

Automatisiert: `npm test` mit neuem Test in `tests/graph-view.test.js` (Nachbarschafts-BFS mit Depth, Filter-/Gruppen-Matcher, Force-Step ohne NaN). Im Browser sichtbar sein muss: Canvas-Graph mit unterschiedlich großen/farbigen Knoten, Depth-Slider, Filterfeld, Tooltip bei Hover.

## 6. Grimoire-Aufwand

L — Abhängigkeit: braucht fertigen Backlink-/Reverse-Index (SPEC-08) und Canvas-Loop; Performance-Tuning inklusive.

## 7. Offene Entscheidung

Soll der Grimoire-Graph als Vollbild-View, als rechte Sidebar oder als beides (klein + aufklappbar groß) umgesetzt werden?
