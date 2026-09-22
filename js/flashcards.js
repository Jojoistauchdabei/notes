/* Federwerk – Karteikarten (Dokumenttyp) + intelligentes Lernsystem (SM-2/Anki-Hybrid).
 *
 * Datenmodell (abwärtskompatibel, federwerk-1):
 * - book.kind: 'notebook' (Default, Feld fehlt = Notizbuch) | 'flashcards' (Deck).
 * - Decks behalten `pages[]` (min. 1, Notiz-/Skizzen-Seiten, GoodNotes-kompatibel)
 *   und tragen zusätzlich `cards[]` + optional `deckOptions{}`.
 * - card: { id, front, back, frontImg, backImg, createdAt, updatedAt,
 *           ease, interval, reps, lapses, due, lastReview,
 *           suspended, totalReviews, correctReviews }
 *   - front/back: Plain-Text (Rich-Text light: HTML erlaubt, wird beim Suchen gestrippt).
 *   - frontImg/backImg: optionales Bild als dataURL oder App-interne `blob:`-Ref
 *     (gleicher Blob-Store wie Seitenbilder; Export löst zu dataURL auf).
 *   - ease: SM-2-Ease-Faktor (Start 2.5, clamp 1.3..2.8).
 *   - interval: Intervall in Tagen (0 = Relearning/intraday, fällig in ~10 Min).
 *   - reps: aufeinanderfolgende korrekte Wiederholungen (SM-2 repetition number).
 *   - lapses: Anzahl "Nochmal"-Fehler. due/lastReview: ms seit Epoch.
 *
 * Lernalgorithmus (SM-2 nach SuperMemo, mit Anki-Buttons):
 * - Buttons: 'again' (q=0, Nochmal) | 'hard' (q=3, Hart) |
 *            'good' (q=4, Gut) | 'easy' (q=5, Leicht).
 * - Ease-Update nur bei q>=3 (SM-2-Formel), geclampt.
 * - Intervalle: Neu (reps==0): again->10min, hard/good->1 Tag, easy->4 Tage.
 *   Wiederholung: again->Reset (10min), hard->prev*1.2,
 *   good->SM-2 (reps==1 -> 6 Tage, sonst prev*ease), easy->prev*ease*1.3.
 * - due = grade-Zeitpunkt + Intervall (again = +10 Minuten, sonst +Tage).
 *
 * - Rein DOM-frei (kein Zugriff auf Browser-APIs außer gegardetem Export):
 *   per <script> (global FederwerkFlashcards) + require() in Node-Tests.
 * - Alle Funktionen werfen nie bei kaputten Eingaben (tolerant: Defaults),
 *   Zeitstempel via Date.now(), per Param `now` überschreibbar (testbar).
 */
(function () {
  'use strict';

  var EASE_START = 2.5;
  var EASE_MIN = 1.3;
  var EASE_MAX = 2.8;
  var AGAIN_DELAY_MS = 10 * 60 * 1000;
  var DAY_MS = 24 * 60 * 60 * 1000;

  var GRADES = ['again', 'hard', 'good', 'easy'];
  // SM-2-Qualität pro Button (Anki-Mapping).
  var GRADE_Q = { again: 0, hard: 3, good: 4, easy: 5 };

  function uid() {
    try {
      if (typeof crypto !== 'undefined' && crypto.randomUUID) {
        return 'c' + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
      }
    } catch (e) { /* Fallback unten */ }
    return 'c' + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
  }

  function num(v, fb) {
    var n = Number(v);
    return (isFinite(n) ? n : fb);
  }

  function clampEase(e) {
    e = num(e, EASE_START);
    if (e < EASE_MIN) return EASE_MIN;
    if (e > EASE_MAX) return EASE_MAX;
    return Math.round(e * 100) / 100;
  }

  function isDeck(book) {
    return !!(book && (book.kind === 'flashcards' || book.kind === 'deck'));
  }

  function isCardNew(card) {
    return !card || !card.lastReview;
  }

  function normalizeGrade(g) {
    if (g === 'again' || g === 'hard' || g === 'good' || g === 'easy') return g;
    if (g === 0 || g === '0' || g === 'forgot') return 'again';
    if (g === 3 || g === '3') return 'hard';
    if (g === 4 || g === '4') return 'good';
    if (g === 5 || g === '5') return 'easy';
    return null;
  }

  /* ---------- Karten anlegen / heilen ---------- */

  function newCard(front, back, now) {
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    return {
      id: uid(),
      front: String(front == null ? '' : front),
      back: String(back == null ? '' : back),
      frontImg: null,
      backImg: null,
      createdAt: t,
      updatedAt: t,
      ease: EASE_START,
      interval: 0,
      reps: 0,
      lapses: 0,
      due: t,
      lastReview: null,
      suspended: false,
      totalReviews: 0,
      correctReviews: 0,
    };
  }

  // Heilt eine Karte in place (tolerant, gibt card zurück). Fremde Keys bleiben.
  function normalizeCard(card, now) {
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    if (!card || typeof card !== 'object') return newCard('', '', t);
    if (typeof card.id !== 'string' || !card.id) card.id = uid();
    if (typeof card.front !== 'string') card.front = String(card.front == null ? '' : card.front);
    if (typeof card.back !== 'string') card.back = String(card.back == null ? '' : card.back);
    if (card.frontImg != null && typeof card.frontImg !== 'string') card.frontImg = null;
    if (card.backImg != null && typeof card.backImg !== 'string') card.backImg = null;
    if (!card.frontImg) card.frontImg = null;
    if (!card.backImg) card.backImg = null;
    if (!isFinite(Number(card.createdAt))) card.createdAt = t;
    if (!isFinite(Number(card.updatedAt))) card.updatedAt = t;
    card.ease = clampEase(card.ease);
    card.interval = Math.max(0, Math.round(num(card.interval, 0)));
    card.reps = Math.max(0, Math.round(num(card.reps, 0)));
    card.lapses = Math.max(0, Math.round(num(card.lapses, 0)));
    if (!isFinite(Number(card.due))) card.due = t;
    if (card.lastReview != null && !isFinite(Number(card.lastReview))) card.lastReview = null;
    card.suspended = !!card.suspended;
    card.totalReviews = Math.max(0, Math.round(num(card.totalReviews, 0)));
    card.correctReviews = Math.max(0, Math.round(num(card.correctReviews, 0)));
    if (card.correctReviews > card.totalReviews) card.correctReviews = card.totalReviews;
    return card;
  }

  function ensureDeck(book, now) {
    if (!book || typeof book !== 'object') return null;
    if (book.kind !== 'flashcards') book.kind = 'flashcards';
    if (!Array.isArray(book.cards)) book.cards = [];
    if (!Array.isArray(book.pages) || !book.pages.length) {
      book.pages = [{ id: uid(), strokes: [], texts: [], images: [], bg: null }];
    }
    if (!book.deckOptions || typeof book.deckOptions !== 'object') {
      book.deckOptions = { newPerDay: 20, maxReviewsPerDay: 100 };
    } else {
      book.deckOptions.newPerDay = Math.max(1, Math.min(500, Math.round(num(book.deckOptions.newPerDay, 20))));
      book.deckOptions.maxReviewsPerDay = Math.max(1, Math.min(2000, Math.round(num(book.deckOptions.maxReviewsPerDay, 100))));
    }
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    for (var i = 0; i < book.cards.length; i++) {
      try { book.cards[i] = normalizeCard(book.cards[i], t); }
      catch (e) { book.cards[i] = newCard('', '', t); }
    }
    return book;
  }

  /* ---------- SM-2-Kern ---------- */

  function easeAfter(ease, q) {
    // SM-2: EF' = EF + (0.1 - (5-q) * (0.08 + (5-q) * 0.02)); nur q>=3.
    if (q < 3) return clampEase(ease);
    var next = num(ease, EASE_START) + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02));
    return clampEase(next);
  }

  function intervalAfter(card, grade) {
    var prev = Math.max(0, Math.round(num(card && card.interval, 0)));
    var reps = Math.max(0, Math.round(num(card && card.reps, 0)));
    var ease = clampEase(card && card.ease);
    if (grade === 'again') return 0;
    if (reps <= 0) {
      if (grade === 'easy') return 4;
      return 1; // hard + good starten mit 1 Tag
    }
    if (grade === 'hard') return Math.max(1, Math.round(prev * 1.2) || 1);
    if (grade === 'easy') {
      if (reps === 1) return Math.max(1, Math.round(6 * ease * 1.3 / ease) || 6);
      return Math.max(1, Math.round(prev * ease * 1.3));
    }
    // good
    if (reps === 1) return 6;
    return Math.max(1, Math.round(prev * ease));
  }

  // Vorschau der nächsten Fälligkeiten pro Button (für UI-Labels "1d", "6d").
  function previewIntervals(card, now) {
    var c = normalizeCard(Object.assign({}, card || {}), now);
    return {
      again: 0,
      hard: intervalAfter(c, 'hard'),
      good: intervalAfter(c, 'good'),
      easy: intervalAfter(c, 'easy'),
    };
  }

  function formatInterval(days) {
    if (!days || days <= 0) return '<10m';
    if (days < 30) return days + 'd';
    if (days < 365) {
      var mo = Math.round(days / 30);
      return mo + 'mo';
    }
    var y = Math.round((days / 365) * 10) / 10;
    return String(y).replace('.', ',') + 'y';
  }

  // Bewertet eine Karte, mutiert sie (in place) + gibt sie zurück.
  // Unbekanntes grade -> null (keine Mutation).
  function gradeCard(card, grade, now) {
    var g = normalizeGrade(grade);
    if (!g || !card || typeof card !== 'object') return null;
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    normalizeCard(card, t);
    var q = GRADE_Q[g];
    if (g === 'again') {
      card.reps = 0;
      card.lapses += 1;
      card.interval = 0;
      card.due = t + AGAIN_DELAY_MS;
    } else {
      var nextInterval = intervalAfter(card, g);
      card.ease = easeAfter(card.ease, q);
      card.reps += 1;
      card.interval = nextInterval;
      card.due = t + nextInterval * DAY_MS;
    }
    card.lastReview = t;
    card.updatedAt = t;
    card.totalReviews += 1;
    if (g !== 'again') card.correctReviews += 1;
    return card;
  }

  /* ---------- Queue + Statistik (intelligentes Lernen) ---------- */

  function isDue(card, now) {
    if (!card || card.suspended) return false;
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    return num(card.due, 0) <= t;
  }

  function dueCards(book, now) {
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    if (!book || !Array.isArray(book.cards)) return [];
    return book.cards
      .filter(function (c) { return c && !c.suspended && num(c.due, 0) <= t; })
      .sort(function (a, b) { return num(a.due, 0) - num(b.due, 0) || num(a.createdAt, 0) - num(b.createdAt, 0); });
  }

  function newCards(book) {
    if (!book || !Array.isArray(book.cards)) return [];
    return book.cards
      .filter(function (c) { return c && !c.suspended && !c.lastReview; })
      .sort(function (a, b) { return num(a.createdAt, 0) - num(b.createdAt, 0); });
  }

  // Baut eine Lerneinheit: erst Fällige (älteste zuerst), dann Neue bis newPerDay.
  // Respektiert deckOptions (newPerDay/maxReviewsPerDay), Default 20/100.
  function buildSession(book, opts) {
    var o = opts || {};
    var t = (typeof o.now === 'number' && isFinite(o.now)) ? o.now : Date.now();
    var newPerDay = Math.max(0, Math.round(num(o.newPerDay, book && book.deckOptions && book.deckOptions.newPerDay, 20)));
    var maxReviews = Math.max(0, Math.round(num(o.maxReviewsPerDay, book && book.deckOptions && book.deckOptions.maxReviewsPerDay, 100)));
    if (!book || !Array.isArray(book.cards)) return [];
    var due = dueCards(book, t).filter(function (c) { return c.lastReview; });
    var dueNew = dueCards(book, t).filter(function (c) { return !c.lastReview; });
    // Fällige Wiederholungen zuerst (gecappt), dann neue Karten.
    var session = due.slice(0, maxReviews);
    var fresh = [];
    var seen = {};
    session.forEach(function (c) { seen[c.id] = true; });
    // Überfällige neue Karten zählen gegen das Neu-Limit.
    var pool = dueNew.concat(newCards(book).filter(function (c) { return !seen[c.id]; }));
    for (var i = 0; i < pool.length && fresh.length < newPerDay && session.length + fresh.length < maxReviews + newPerDay; i++) {
      if (!seen[pool[i].id]) { seen[pool[i].id] = true; fresh.push(pool[i]); }
    }
    return session.concat(fresh);
  }

  function deckStats(book, now) {
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    var empty = { total: 0, active: 0, suspended: 0, fresh: 0, due: 0, learned: 0, retention: null, totalReviews: 0 };
    if (!book || !Array.isArray(book.cards)) return empty;
    var s = { total: book.cards.length, active: 0, suspended: 0, fresh: 0, due: 0, learned: 0, retention: null, totalReviews: 0 };
    var correct = 0, total = 0;
    for (var i = 0; i < book.cards.length; i++) {
      var c = book.cards[i];
      if (!c) continue;
      if (c.suspended) { s.suspended++; continue; }
      s.active++;
      if (!c.lastReview) s.fresh++;
      else s.learned++;
      if (num(c.due, 0) <= t) s.due++;
      s.totalReviews += Math.max(0, Math.round(num(c.totalReviews, 0)));
      correct += Math.max(0, Math.round(num(c.correctReviews, 0)));
      total += Math.max(0, Math.round(num(c.totalReviews, 0)));
    }
    if (total > 0) s.retention = Math.round((correct / total) * 1000) / 10; // % mit 1 Nachkomma
    return s;
  }

  // Fälligkeits-Vorschau für die nächsten `days` Tage (für Deck-Header/Stats).
  function forecastDue(book, days, now) {
    var n = Math.max(1, Math.min(30, Math.round(num(days, 7))));
    var t = (typeof now === 'number' && isFinite(now)) ? now : Date.now();
    var out = [];
    for (var d = 0; d < n; d++) out.push(0);
    if (!book || !Array.isArray(book.cards)) return out;
    for (var i = 0; i < book.cards.length; i++) {
      var c = book.cards[i];
      if (!c || c.suspended) continue;
      var diff = num(c.due, 0) - t;
      var day = diff <= 0 ? 0 : Math.ceil(diff / DAY_MS);
      if (day >= 0 && day < n) out[day]++;
    }
    return out;
  }

  /* ---------- Text / Suche / CSV ---------- */

  function stripTags(s) {
    return String(s == null ? '' : s)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'").replace(/&#x27;/gi, "'").replace(/&amp;/g, '&')
      .replace(/[ \t\u00a0]+/g, ' ')
      .trim();
  }

  function cardText(card) {
    if (!card) return '';
    return (stripTags(card.front) + '\n' + stripTags(card.back)).trim();
  }

  function deckText(book) {
    if (!book || !Array.isArray(book.cards)) return '';
    return book.cards.map(cardText).filter(Boolean).join('\n');
  }

  // CSV: "Vorderseite;Rückseite" pro Zeile (Trennzeichen wählbar, Standard ';').
  // Anführungszeichen nach RFC 4180 ("..." + ""-Escape). Wirft nie (kaputt -> []).
  function parseCardCsv(text, sep) {
    var out = [];
    try {
      var d = (typeof sep === 'string' && sep) ? sep[0] : ';';
      var rows = parseCsvRows(String(text == null ? '' : text));
      for (var i = 0; i < rows.length; i++) {
        var r = rows[i];
        if (!r || !r.length) continue;
        var cells = (r.length === 1 && d !== ',') ? splitSingle(r[0], d) : r;
        var front = (cells[0] || '').trim();
        var back = cells.slice(1).join(d).trim();
        if (!front && !back) continue;
        out.push({ front: front, back: back });
      }
    } catch (e) { /* tolerant */ }
    return out;
  }

  function splitSingle(cell, d) {
    // Eine Zelle ohne erkannte Trennung: am gewählten Separator teilen.
    if (cell.indexOf(d) === -1) return [cell];
    return cell.split(d);
  }

  function parseCsvRows(text) {
    var rows = [];
    var row = [];
    var cell = '';
    var inQ = false;
    for (var i = 0; i < text.length; i++) {
      var ch = text[i];
      if (inQ) {
        if (ch === '"') {
          if (text[i + 1] === '"') { cell += '"'; i++; }
          else inQ = false;
        } else { cell += ch; }
      } else {
        if (ch === '"') inQ = true;
        else if (ch === ';' || ch === ',' || ch === '\t') { row.push(cell); cell = ''; }
        else if (ch === '\n') { row.push(cell); rows.push(row); row = []; cell = ''; }
        else if (ch === '\r') { /* \r\n -> \n handhabt */ }
        else { cell += ch; }
      }
    }
    row.push(cell);
    rows.push(row);
    return rows.filter(function (r) {
      return r.some(function (c) { return String(c).trim() !== ''; });
    });
  }

  function cardToCsvRow(card, sep) {
    var d = (typeof sep === 'string' && sep) ? sep[0] : ';';
    return [csvCell(card && card.front, d), csvCell(card && card.back, d)].join(d);
  }

  function csvCell(v, d) {
    var s = stripTags(v);
    if (s.indexOf('"') !== -1 || s.indexOf(d) !== -1 || s.indexOf('\n') !== -1) {
      return '"' + s.replace(/"/g, '""') + '"';
    }
    return s;
  }

  var api = {
    EASE_START: EASE_START,
    EASE_MIN: EASE_MIN,
    EASE_MAX: EASE_MAX,
    AGAIN_DELAY_MS: AGAIN_DELAY_MS,
    DAY_MS: DAY_MS,
    GRADES: GRADES,
    GRADE_Q: GRADE_Q,
    uid: uid,
    isDeck: isDeck,
    isCardNew: isCardNew,
    normalizeGrade: normalizeGrade,
    newCard: newCard,
    normalizeCard: normalizeCard,
    ensureDeck: ensureDeck,
    easeAfter: easeAfter,
    intervalAfter: intervalAfter,
    previewIntervals: previewIntervals,
    formatInterval: formatInterval,
    gradeCard: gradeCard,
    isDue: isDue,
    dueCards: dueCards,
    newCards: newCards,
    buildSession: buildSession,
    deckStats: deckStats,
    forecastDue: forecastDue,
    stripTags: stripTags,
    cardText: cardText,
    deckText: deckText,
    parseCardCsv: parseCardCsv,
    cardToCsvRow: cardToCsvRow,
  };

  if (typeof window !== 'undefined') window.FederwerkFlashcards = api;
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
