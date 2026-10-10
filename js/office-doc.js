/* Federwerk Office -- Dokumentmodell (DOM-frei, in Node testbar).
 *
 * Ein Office-Dokument ist ein Buch mit `office`-Feld, kein eigener Bestand:
 * Ordner, Ordnerfilter, moveBook, Suche, Duplizieren und der Server-Sync
 * laufen dadurch unverändert mit. Gleiches Muster wie die Kartenstapel, die
 * schon heute ueber isFlashDeck(b) einen eigenen Buchtyp im Bibliotheksraster
 * bekommen. Siehe SPEC-40.
 *
 * Bewusst DOM-frei: die reine Logik (Modell, Klartext, Statistik) laesst sich so
 * in Node pruefen, wie es im Repo ueblich ist (js/store.js, js/files-sync.js).
 * Das Rendern und die Toolbar liegen in js/office-writer.js.
 */
(function () {
  'use strict';

  const KINDS = { doc: 'Dokument', sheet: 'Tabelle', slides: 'Präsentation' };
  const BLOCK_TYPES = ['p', 'h1', 'h2', 'h3', 'ul', 'ol', 'quote', 'code', 'hr'];

  let seq = 0;
  function uid(prefix) {
    seq += 1;
    return prefix + '-' + Date.now().toString(36) + '-' + seq.toString(36);
  }

  // Absatztypen, die in der Outline zaehlen (fuer die Seitenleiste).
  const HEADING_TYPES = ['h1', 'h2', 'h3'];

  function isOfficeBook(b) {
    return !!(b && b.office && typeof b.office === 'object' && KINDS[b.office.kind]);
  }

  function kindOf(b) {
    return isOfficeBook(b) ? b.office.kind : null;
  }

  /* Text ohne HTML. Federwerk hat stripHtml in js/app.js, das ist aber nicht
   * exportiert und haengt am Fenster -- hier lokal, damit das Modul allein
   * testbar bleibt. */
  function stripHtml(html) {
    return String(html == null ? '' : html)
      .replace(/<br\s*\/?>/gi, '\n')
      .replace(/<\/(p|div|li|h[1-6]|blockquote|pre|tr)>/gi, '\n')
      .replace(/<li[^>]*>/gi, '• ')
      .replace(/<hr\s*\/?>/gi, '\n')
      .replace(/<[^>]*>/g, '')
      .replace(/&nbsp;/g, ' ')
      .replace(/&amp;/g, '&')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/[ \t]+\n/g, '\n')
      .replace(/\n{3,}/g, '\n\n')
      .trim();
  }

  function escapeHtml(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;').replace(/'/g, '&#39;');
  }

  function block(type, html) {
    return { id: uid('b'), type: BLOCK_TYPES.includes(type) ? type : 'p', html: html || '' };
  }

  /* Ein neues Office-Buch anlegen. `pages` bleibt bewusst leer: der
   * Handschrift-Pfad erwartet Seiten, Office-Bucher haben keine. */
  function create(kind, title) {
    const k = KINDS[kind] ? kind : 'doc';
    const t = String(title == null ? '' : title).trim() || (KINDS[k] + ' 1');
    const now = Date.now();
    const book = {
      id: uid('o'),
      title: t,
      createdAt: now,
      updatedAt: now,
      pages: [],
      office: { kind: k },
    };
    if (k === 'doc') book.office.blocks = [block('p', '')];
    if (k === 'sheet') book.office.sheets = [{ id: uid('s'), name: 'Tabelle1', rows: 40, cols: 12, cells: {} }];
    if (k === 'slides') book.office.slides = [{ id: uid('d'), name: 'Folie 1', items: [{ text: '', x: 8, y: 12, w: 84, h: 16 }] }];
    return book;
  }

  /* Reparatur beim Laden: alte oder von Hand bearbeitete Bucher muessen nicht
   * crashen. Fehlende Felder werden ergaenzt, kaputte Absatztypen auf 'p'
   * gesetzt. */
  function normalize(book) {
    if (!isOfficeBook(book)) return book;
    const o = book.office;
    if (o.kind === 'doc') {
      if (!Array.isArray(o.blocks) || !o.blocks.length) o.blocks = [block('p', '')];
      o.blocks = o.blocks.map((b) => {
        const t = b && BLOCK_TYPES.includes(b.type) ? b.type : 'p';
        return { id: (b && b.id) || uid('b'), type: t, html: String((b && b.html) || '') };
      });
      if (!o.blocks.some((b) => String(b.html || '').trim())) {
        // Eine komplett leere Liste laesst die Toolbar nicht greifen.
        o.blocks = [block('p', '')];
      }
    } else if (o.kind === 'sheet') {
      if (!Array.isArray(o.sheets) || !o.sheets.length) {
        o.sheets = [{ id: uid('s'), name: 'Tabelle1', rows: 40, cols: 12, cells: {} }];
      }
      o.sheets = o.sheets.map((s) => ({
        id: (s && s.id) || uid('s'),
        name: String((s && s.name) || 'Tabelle1'),
        rows: clampInt((s && s.rows) || 40, 1, 1000, 40),
        cols: clampInt((s && s.cols) || 12, 1, 100, 12),
        cells: (s && s.cells && typeof s.cells === 'object') ? s.cells : {},
      }));
    } else if (o.kind === 'slides') {
      if (!Array.isArray(o.slides) || !o.slides.length) {
        o.slides = [{ id: uid('d'), name: 'Folie 1', items: [{ text: '', x: 8, y: 12, w: 84, h: 16 }] }];
      }
      o.slides = o.slides.map((sl) => ({
        id: (sl && sl.id) || uid('d'),
        name: String((sl && sl.name) || 'Folie'),
        items: (Array.isArray(sl && sl.items) ? sl.items : []).map((it) => ({
          text: String((it && it.text) || ''),
          x: clampNum(it && it.x, 0, 100, 8),
          y: clampNum(it && it.y, 0, 100, 12),
          w: clampNum(it && it.w, 4, 100, 84),
          h: clampNum(it && it.h, 3, 100, 16),
        })),
      }));
    }
    if (!Array.isArray(book.pages)) book.pages = [];
    return book;
  }

  function clampNum(v, min, max, fallback) {
    const n = Number(v);
    if (!isFinite(n)) return fallback;
    return Math.min(max, Math.max(min, n));
  }

  function clampInt(v, min, max, fallback) {
    return Math.round(clampNum(v, min, max, fallback));
  }

  /* Klartext des ganzen Dokuments -- speist Bibliotheksvorschau UND Suche.
   * Deshalb eine eigene Funktion statt im Writer: die Suche braucht den Text
   * auch, wenn der Editor gar nicht geoeffnet wurde. */
  function plainText(book) {
    if (!isOfficeBook(book)) return '';
    const o = book.office;
    if (o.kind === 'doc') return (o.blocks || []).map((b) => stripHtml(b.html)).join('\n').trim();
    if (o.kind === 'sheet') {
      const out = [];
      for (const s of o.sheets || []) {
        out.push('[' + s.name + ']');
        for (const key of Object.keys(s.cells || {})) {
          const raw = s.cells[key];
          const v = raw && typeof raw === 'object' ? (raw.f != null ? raw.f : raw.v) : raw;
          const text = String(v == null ? '' : v);
          if (text.trim()) out.push(key + ' ' + text);
        }
      }
      return out.join('\n').trim();
    }
    if (o.kind === 'slides') {
      return (o.slides || [])
        .map((sl) => '[' + sl.name + '] ' + (sl.items || []).map((it) => stripHtml(it.text)).join(' '))
        .join('\n').trim();
    }
    return '';
  }

  function wordCount(text) {
    const t = String(text == null ? '' : text).trim();
    if (!t) return 0;
    return t.split(/\s+/).length;
  }

  /* Kurzanzeige fuer die Bibliothekskarte. */
  function stats(book) {
    const text = plainText(book);
    const o = (book && book.office) || {};
    let unit = '';
    if (o.kind === 'doc') unit = (o.blocks || []).length + ' Absatz/Absätze';
    else if (o.kind === 'sheet') {
      const s = (o.sheets || [])[0] || {};
      unit = (o.sheets || []).length + ' Blatt/Blätter · ' + (s.rows || 0) + '×' + (s.cols || 0);
    } else if (o.kind === 'slides') unit = (o.slides || []).length + ' Folie(n)';
    return { words: wordCount(text), chars: text.length, unit };
  }

  function kindLabel(kind) {
    return KINDS[kind] || 'Office';
  }

  /* Outline fuer eine moegliche Seitenleiste (Stufe 2). */
  function outline(book) {
    if (!isOfficeBook(book) || book.office.kind !== 'doc') return [];
    return (book.office.blocks || [])
      .filter((b) => HEADING_TYPES.includes(b.type))
      .map((b) => ({ id: b.id, level: Number(b.type.slice(1)), text: stripHtml(b.html) }));
  }

  const OfficeDoc = {
    KINDS, BLOCK_TYPES, HEADING_TYPES,
    isOfficeBook, kindOf, create, normalize, plainText, stripHtml, escapeHtml,
    wordCount, stats, kindLabel, outline, block,
  };

  if (typeof window !== 'undefined') window.FederwerkOfficeDoc = OfficeDoc;
  if (typeof module !== 'undefined' && module.exports) module.exports = OfficeDoc;
})();