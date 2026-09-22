/* Federwerk – Papier-Vorlagen (Design + Maße, Buch-weit).
 *
 * Zentraler Katalog für Papiervorlagen: jede Vorlage beschreibt Design
 * (CSS-Klasse / Pattern) UND Maße (Canvas-px). Plain <script> (global
 * `FederwerkPaper`) + Node-Export für Tests. Rein/DOM-frei/testbar.
 *
 * Koordinaten-Modell (wichtig, Canvas-kompatibel):
 * - Strokes liegen in absoluten Canvas-px der jeweiligen Seite
 *   (`x`: 0..pageW, `y`: 0..pageH). Texte/Bilder sind normiert (0..1)
 *   und folgen Formatwechseln automatisch.
 * - Die Vorlage setzt KEINE Magie in den Renderer: Beim Vorlagenwechsel
 *   (`setPaper` in js/app.js) wird `page.size = { w, h }` auf alle
 *   template-folgenden Seiten geschrieben und bestehende Strokes via
 *   `PagesImport.retargetStrokes` proportional umgerechnet. Neue Seiten
 *   erben das Buch-Format ebenfalls als `page.size`.
 * - `page.size` bleibt autoritativ: Seiten mit eigenem (Bild-/PDF-)Format
 *   werden vom Vorlagenwechsel NICHT angerührt (siehe `followsTemplate`).
 *   Der Renderer nutzt unverändert `pageDimsOf` (fällt auf Buch-Vorlage
 *   zurück, wenn die Seite kein `size` trägt – siehe `effectiveDims`).
 * - A4-Hoch (1000×1414) ist der Default und wird NICHT persistiert
 *   (`sizeForPersistence` -> null), damit Alt-Exporte/Leser unverändert
 *   funktionieren.
 *
 * Datenmodell:
 * - Buch-weit: `book.paper` = Template-ID (string). KEIN pro-Seite-Override
 *   (`page.templateId` existiert bewusst nicht – eine Seite = ein Format
 *   via `page.size`, ein Design via Buch-Vorlage; mischt man beides, wird
 *   unklar, was `pageDimsOf` liefern soll).
 * - Abwärtskompatibel: Legacy-IDs `''` (Blanko), `'lined'`, `'grid'`
 *   werden via `normalizeId` auf Katalog-IDs gemappt (`blank-a4`,
 *   `lined-a4`, `grid-a4`). Alte gespeicherte Werte rendern weiter korrekt;
 *   neu gespeichert wird immer die kanonische ID.
 */
(function () {
  'use strict';

  /* Referenzmaße (Canvas-px). Breite 1000 = Referenz wie bisher
   * (Stiftstärken/Fonts unverändert); Formate übernehmen ihr natives
   * Seitenverhältnis bei Breite 1000. Bounds wie PagesImport (200..2400). */
  const DEFAULT_W = 1000, DEFAULT_H = 1414; // A4-Hoch
  const MIN_EDGE = 200, MAX_EDGE = 2400;

  /* Legacy-IDs aus der 3er-Auswahl ('' | 'lined' | 'grid'). */
  const LEGACY_MAP = {
    '': 'blank-a4',
    lined: 'lined-a4',
    grid: 'grid-a4',
  };

  const DEFAULT_ID = 'blank-a4';

  /* Katalog (~12 Vorlagen). Felder:
   * - id, name, group (Optgroup im Select)
   * - w, h: Canvas-px
   * - cssClass: auf `.stage` zu legende Klasse(n, leerzeichengetrennt).
   *   Legacy-Klassen `lined`/`grid` werden für die beiden Klassiker
   *   wiederverwendet (Alt-CSS bleibt gültig).
   * - pattern: Design-Deskriptor (blank|lined|grid|dots|cornell|todo|music)
   * - lineGap: Rasterabstand in Canvas-px (Doku-/Test-Wert)
   * - bg: Seiten-Grundfarbe (PNG-Export/Thumbs ohne CSS-Pattern) */
  const TEMPLATES = [
    { id: 'blank-a4', name: 'Blanko A4', group: 'Blanko & Formate', w: 1000, h: 1414, cssClass: '', pattern: 'blank', bg: '#fffdf6' },
    { id: 'blank-a5', name: 'Blanko A5 hoch', group: 'Blanko & Formate', w: 1000, h: 1419, cssClass: '', pattern: 'blank', bg: '#fffdf6' },
    { id: 'blank-square', name: 'Blanko Quadrat', group: 'Blanko & Formate', w: 1000, h: 1000, cssClass: '', pattern: 'blank', bg: '#fffdf6' },
    { id: 'blank-letter', name: 'Blanko US-Letter', group: 'Blanko & Formate', w: 1000, h: 1294, cssClass: '', pattern: 'blank', bg: '#fffdf6' },
    { id: 'lined-a4', name: 'Liniert A4', group: 'Linien & Raster', w: 1000, h: 1414, cssClass: 'lined', pattern: 'lined', lineGap: 32, bg: '#fffdf6' },
    { id: 'lined-margin-a4', name: 'Liniert mit Rand', group: 'Linien & Raster', w: 1000, h: 1414, cssClass: 'lined paper-margin', pattern: 'lined', lineGap: 32, bg: '#fffdf6' },
    { id: 'grid-a4', name: 'Kariert klein A4', group: 'Linien & Raster', w: 1000, h: 1414, cssClass: 'grid', pattern: 'grid', lineGap: 24, bg: '#ffffff' },
    { id: 'grid-large-a4', name: 'Kariert groß A4', group: 'Linien & Raster', w: 1000, h: 1414, cssClass: 'paper-grid-lg', pattern: 'grid', lineGap: 48, bg: '#ffffff' },
    { id: 'dots-a4', name: 'Punktraster A4', group: 'Linien & Raster', w: 1000, h: 1414, cssClass: 'paper-dots', pattern: 'dots', lineGap: 24, bg: '#fffdf6' },
    { id: 'cornell-a4', name: 'Cornell-Notizen', group: 'Spezial', w: 1000, h: 1414, cssClass: 'paper-cornell', pattern: 'cornell', lineGap: 32, bg: '#fffdf6' },
    { id: 'todo-a4', name: 'Checkliste / Todo', group: 'Spezial', w: 1000, h: 1414, cssClass: 'paper-todo', pattern: 'todo', lineGap: 40, bg: '#fffdf6' },
    { id: 'music-a4', name: 'Notenlinien', group: 'Spezial', w: 1000, h: 1414, cssClass: 'paper-music', pattern: 'music', lineGap: 12, bg: '#fffdf6' },
  ];

  /* Alle CSS-Klassen, die je auf `.stage` liegen können (zum Abräumen
   * in applyPaperFor – inkl. Legacy, damit Altstände nie kleben). */
  const ALL_CSS_CLASSES = ['lined', 'grid', 'paper-margin', 'paper-grid-lg', 'paper-dots', 'paper-cornell', 'paper-todo', 'paper-music'];

  function byId(id) {
    if (typeof id !== 'string' || !id) return null;
    for (const t of TEMPLATES) if (t.id === id) return t;
    return null;
  }

  /* Kanonische Template-ID: Legacy mappen, Unbekanntes/Leeres -> Default.
   * HINWEIS: `''`/`null`/`undefined` bedeuten historisch „Blanko" und
   * mappen daher auf `blank-a4` (nicht „ungültig"). */
  function normalizeId(v) {
    if (v == null) return DEFAULT_ID;
    const s = String(v);
    if (Object.prototype.hasOwnProperty.call(LEGACY_MAP, s)) return LEGACY_MAP[s];
    return byId(s) ? s : DEFAULT_ID;
  }

  /* Vorlage auflösen (fällt nie auf null – immer renderbar). */
  function resolve(v) {
    return byId(normalizeId(v)) || byId(DEFAULT_ID);
  }

  function dimsFor(v) {
    const t = resolve(v);
    return { w: t.w, h: t.h };
  }

  function cssClasses(v) {
    const t = resolve(v);
    return String(t.cssClass || '').split(/\s+/).filter(Boolean);
  }

  function allCssClasses() {
    return ALL_CSS_CLASSES.slice();
  }

  function patternFor(v) {
    return resolve(v).pattern || 'blank';
  }

  function bgFor(v) {
    return resolve(v).bg || '#fffdf6';
  }

  /* `{w,h}`-Größe sanitizen (Bounds wie pageDimsOf/PagesImport: 200..2400)
   * -> {w,h} | null. null = fehlend/ungültig (KEIN Default-Collapse und
   * KEIN Clamp – korrupte Werte gelten als „kein Format", Aufrufer fällt
   * auf die Buch-Vorlage zurück). */
  function sanitizeSize(v) {
    if (v == null) return null;
    if (typeof v !== 'object') return null;
    const w = Math.round(Number(v.w)), h = Math.round(Number(v.h));
    if (!isFinite(w) || !isFinite(h)) return null;
    if (w < MIN_EDGE || w > MAX_EDGE || h < MIN_EDGE || h > MAX_EDGE) return null;
    return { w, h };
  }

  /* Persistier-Größe für Template-Maße: A4-Default -> null (kein Ballast
   * im State, Altbestand-kompatibel), sonst {w,h}. */
  function sizeForPersistence(w, h) {
    const s = sanitizeSize({ w, h });
    if (!s) return null;
    if (s.w === DEFAULT_W && s.h === DEFAULT_H) return null;
    return s;
  }

  function sizeForTemplateId(id) {
    const d = dimsFor(id);
    return sizeForPersistence(d.w, d.h);
  }

  /* Effektive Seitenmaße (immer gültig): `page.size` gewinnt (Bild-/PDF-
   * Formate nicht brechen), sonst Buch-Vorlage, sonst A4-Default. */
  function effectiveDims(page, bookPaper) {
    const s = sanitizeSize(page && page.size);
    if (s) return s;
    return dimsFor(bookPaper);
  }

  /* Folgt die Seite der Buch-Vorlage (darf beim Vorlagenwechsel umformatiert
   * werden)? true = kein `size` oder `size` == alte Template-Maße;
   * false = eigenes Format (PDF-/Bild-Import) -> unangetastet lassen. */
  function followsTemplate(page, oldDims) {
    const s = sanitizeSize(page && page.size);
    if (!s) return true;
    const o = sanitizeSize(oldDims) || { w: DEFAULT_W, h: DEFAULT_H };
    return s.w === o.w && s.h === o.h;
  }

  /* Optgroups für die Papier-Selects: [{ label, items: [template...] }]. */
  function groups() {
    const out = [];
    const seen = new Map();
    for (const t of TEMPLATES) {
      const label = t.group || 'Vorlagen';
      if (!seen.has(label)) { seen.set(label, []); out.push({ label, items: seen.get(label) }); }
      seen.get(label).push(t);
    }
    return out;
  }

  const api = {
    DEFAULT_W,
    DEFAULT_H,
    DEFAULT_ID,
    LEGACY_MAP,
    TEMPLATES,
    byId,
    normalizeId,
    resolve,
    dimsFor,
    cssClasses,
    allCssClasses,
    patternFor,
    bgFor,
    sanitizeSize,
    sizeForPersistence,
    sizeForTemplateId,
    effectiveDims,
    followsTemplate,
    groups,
  };

  if (typeof window !== 'undefined') window.FederwerkPaper = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
