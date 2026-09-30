'use strict';
/* Federwerk MCP-Content-Helpers (DOM-frei, ohne Dependencies).
 *
 * Selbst-contained, damit es an drei Stellen läuft:
 *  1) mcpserver/index.js (Protokoll-Validierung),
 *  2) mcp/index.js (Appwrite Function – dort gibt es KEIN ../js/*),
 *  3) mcpserver/cli.js (lokales Demo-Backend).
 *
 * Das Fassungsvermögen ist bewusst ein "MCP-lite":
 *  - Markdown <-> Seiten-HTML ist eine Teilmenge von js/markdown.js
 *    (Überschriften, fett/kursiv, Listen, Tasks, Links, Code, Absätze).
 *    Die App rendert das HTML korrekt; volle Roundtrip-Treue gibt es nur
 *    über den Editor selbst.
 *  - SM-2 spiegelt js/flashcards.js (gleiche Konstanten + Formeln).
 *  - Advanced-Search-Scoring spiegelt js/search.js
 *    (Titel 10 > Tag 5 > Task 3 > Text 1).
 *
 * Content-Envelope (Appwrite notes.content):
 *  - v1 (Web-Client, Bestand): {v:1, pages} – nur Notizseiten.
 *  - v2 (MCP): {v:2, pages, kind, cards, deckOptions, reviewLog}.
 *  Alte Clients ignorieren v2-Zusatzfelder beim Lesen, würden sie beim
 *  nächsten Push aber verwerfen – Decks daher bevorzugt per MCP pflegen,
 *  bis js/appwrite-sync.js v2 persistiert.
 */

var OFFLOAD_BYTES = 40000;
// Live gemessen (Appwrite 2.3, Tabelle `notes`): `content` akzeptiert 60 KB
// inline, ab 64 KB lehnt Appwrite die Row ab. Der Bucket `attachments`
// erlaubt je nach Config nur Bild-/PDF-Endungen – deshalb dieser Wert als
// Notfallgrenze, wenn der Offload am Dateityp scheitert.
var INLINE_ROW_MAX = 60000;
var INLINE_MARKDOWN_MAX = 8000;
var CONTENT_MAX_BYTES = 200000;
var TITLE_MAX = 200;
var BULK_CARDS_MAX = 100;
var ROW_ID_RE = /^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$/;

function nowMs() { return Date.now(); }
function nowIso(ms) {
  try { return new Date(ms == null ? Date.now() : ms).toISOString(); }
  catch { return new Date(0).toISOString(); }
}
function num(v, fb) { var n = Number(v); return isFinite(n) ? n : fb; }

function newId(prefix) {
  var p = prefix || 'n';
  try {
    if (typeof crypto !== 'undefined' && crypto.randomUUID) {
      return p + crypto.randomUUID().replace(/-/g, '').slice(0, 12);
    }
  } catch { /* fallback */ }
  try {
    var c = require('crypto');
    return p + c.randomBytes(8).toString('hex').slice(0, 12);
  } catch { /* fallback */ }
  return p + Date.now().toString(36) + Math.random().toString(36).slice(2, 10);
}

// Appwrite Row-ID: ^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$ – sonst mappen.
function rowIdFor(id, prefix) {
  var s = String(id || '');
  if (ROW_ID_RE.test(s)) return s;
  var clean = s.toLowerCase().replace(/[^a-z0-9._-]/g, '').replace(/^[^a-z0-9]+/, '');
  return ((prefix || 'b') + (clean || 'doc')).slice(0, 36);
}

function normTitle(t, fallback) {
  var s = String(t == null ? '' : t).trim().slice(0, TITLE_MAX);
  return s || (fallback || 'Unbenannt');
}

function escHtml(s) {
  return String(s == null ? '' : s).replace(/[&<>"']/g, function (c) {
    return { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c];
  });
}

/* ---------- Markdown <-> HTML (lite) ---------- */

function mdToHtmlLite(src) {
  var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
  if (!text.trim()) return '';
  var html = escHtml(text);
  // Codeblöcke ```...```
  html = html.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, function (m, lang, code) {
    return '<pre><code>' + String(code).replace(/\n$/, '') + '</code></pre>';
  });
  // Inline-Code `...`
  html = html.replace(/`([^`\n]+)`/g, '<code>$1</code>');
  // Überschriften
  html = html.replace(/^###### (.*)$/gm, '<h6>$1</h6>')
    .replace(/^##### (.*)$/gm, '<h5>$1</h5>')
    .replace(/^#### (.*)$/gm, '<h4>$1</h4>')
    .replace(/^### (.*)$/gm, '<h3>$1</h3>')
    .replace(/^## (.*)$/gm, '<h2>$1</h2>')
    .replace(/^# (.*)$/gm, '<h1>$1</h1>');
  // Tasks (vor Listen, damit Marker erhalten bleiben)
  html = html.replace(/^(\s*)[-*] \[ \] (.*)$/gm, '$1<ul><li><input type="checkbox" data-marker=" "> $2</li></ul>')
    .replace(/^(\s*)[-*] \[[xX]\] (.*)$/gm, '$1<ul><li><input type="checkbox" data-marker="x" checked> $2</li></ul>');
  // Fett/kursiv (nach Überschriften, vor Links)
  html = html.replace(/\*\*([^*]+)\*\*/g, '<b>$1</b>')
    .replace(/__([^_]+)__/g, '<b>$1</b>')
    .replace(/\*([^*\n]+)\*/g, '<i>$1</i>')
    .replace(/(^|\W)_([^_\n]+)_(\W|$)/g, '$1<i>$2</i>$3');
  // Links [text](url) + [[Wikilink]]
  html = html.replace(/\[([^\]]+)\]\(([^)]+)\)/g, '<a href="$2">$1</a>')
    .replace(/\[\[([^\]|#]+)(?:\|([^\]]+))?\]\]/g, '<a data-wikilink="$1">$2</a>');
  // Absätze: Blöcke, die schon HTML sind, stehen lassen; Rest in <p>.
  var parts = html.split(/\n{2,}/).map(function (blk) {
    var t = blk.trim();
    if (!t) return '';
    if (/^<(h[1-6]|ul|ol|pre|blockquote|hr)/i.test(t)) return t;
    if (/^<li>/i.test(t)) return '<ul>' + t + '</ul>';
    return '<p>' + t.replace(/\n/g, '<br>') + '</p>';
  }).filter(Boolean);
  var out = parts.join('\n');
  // Leere data-wikilink-Anker ohne Alias mit Ziel füllen.
  out = out.replace(/<a data-wikilink="([^"]+)"><\/a>/g, '<a data-wikilink="$1">$1</a>');
  return out;
}

function htmlToMdLite(html) {
  var s = String(html == null ? '' : html);
  s = s.replace(/<input[^>]*>/gi, function (im) {
    var dm = /data-marker="([ xX\/])"/.exec(im);
    var mk = dm ? dm[1].toLowerCase() : (/checked/i.test(im) ? 'x' : ' ');
    if (mk === 'X') mk = 'x';
    return mk === 'x' ? '- [x] ' : '- [ ] ';
  });
  s = s.replace(/<li[^>]*>/gi, '- ');
  s = s.replace(/<(br|hr)[^>]*>/gi, '\n');
  s = s.replace(/<\/(p|div|li|ul|ol|h[1-6]|blockquote|section|article|header|footer|tr|pre)[^>]*>/gi, '\n');
  s = s.replace(/<h([1-6])[^>]*>/gi, function (m, n) {
    return new Array(Number(n) + 1).join('#') + ' ';
  });
  s = s.replace(/<(b|strong)[^>]*>([\s\S]*?)<\/(b|strong)>/gi, '**$2**');
  s = s.replace(/<(i|em)[^>]*>([\s\S]*?)<\/(i|em)>/gi, '*$2*');
  s = s.replace(/<code[^>]*>([\s\S]*?)<\/code>/gi, '`$1`');
  s = s.replace(/<a[^>]*data-wikilink="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[[$1]]');
  s = s.replace(/<a[^>]*href="([^"]+)"[^>]*>([\s\S]*?)<\/a>/gi, '[$2]($1)');
  s = s.replace(/<[^>]*>/g, '');
  s = s.replace(/&lt;/g, '<').replace(/&gt;/g, '>').replace(/&quot;/g, '"')
    .replace(/&#39;/g, "'").replace(/&nbsp;/gi, ' ');
  // absichtlich zuletzt (kein Doppel-Dekodieren)
  s = s.replace(/&amp;/g, '&');
  return s.replace(/[ \t]+/g, ' ').replace(/\n{3,}/g, '\n\n').trim();
}

/* ---------- Seiten / Envelope ---------- */

function blankPage() {
  return { id: newId('p'), strokes: [], texts: [], images: [], bg: null };
}

function contentToPages(content, format) {
  var fmt = String(format || 'markdown').toLowerCase();
  if (!content || !String(content).trim()) return [blankPage()];
  if (fmt === 'pages') {
    var pages = content && content.pages ? content.pages : content;
    if (Array.isArray(pages) && pages.length) return pages;
    return [blankPage()];
  }
  var html = (fmt === 'html') ? String(content) : mdToHtmlLite(content);
  var page = blankPage();
  page.texts = [{ id: newId('t'), x: 0.08, y: 0.05, html: html }];
  return [page];
}

function pagesToMarkdown(pages) {
  if (!Array.isArray(pages)) return '';
  var parts = [];
  for (var i = 0; i < pages.length; i++) {
    var p = pages[i] || {};
    var texts = Array.isArray(p.texts) ? p.texts : [];
    for (var j = 0; j < texts.length; j++) {
      var t = texts[j];
      var html = (t && typeof t.html === 'string') ? t.html : (typeof t === 'string' ? t : '');
      var md = htmlToMdLite(html).trim();
      if (md) parts.push(md);
    }
  }
  return parts.join('\n\n');
}

function stripTagsLite(h) {
  return String(h == null ? '' : h).replace(/<[^>]*>/g, ' ').replace(/\s+/g, ' ').trim();
}

function pageText(p) {
  var parts = [];
  var texts = (p && Array.isArray(p.texts)) ? p.texts : [];
  for (var i = 0; i < texts.length; i++) {
    var t = texts[i];
    var html = (t && typeof t.html === 'string') ? t.html : (typeof t === 'string' ? t : '');
    if (html) parts.push(stripTagsLite(html));
  }
  return parts.join('\n');
}

function encodeContent(opts) {
  var o = opts || {};
  var pages = Array.isArray(o.pages) ? o.pages : [];
  var isDeck = o.kind === 'flashcards' || o.kind === 'deck';
  // Deck-Marker: Typ, Karten oder Verlauf. deckOptions allein macht KEIN Deck
  // aus (sonst würde jedes Notizbuch durchgereichter Default-Optionen zum
  // Deck) – deckOptions zählen nur, wenn das Buch ohnehin Deck ist.
  var hasDeck = isDeck
    || (Array.isArray(o.cards) && o.cards.length > 0)
    || (Array.isArray(o.reviewLog) && o.reviewLog.length > 0);
  if (!hasDeck) return JSON.stringify({ v: 1, pages: pages });
  return JSON.stringify({
    v: 2,
    pages: pages,
    kind: 'flashcards',
    cards: Array.isArray(o.cards) ? o.cards.map(function (c) { return normalizeCard(c); }) : [],
    deckOptions: normalizeDeckOptions(o.deckOptions),
    reviewLog: normalizeReviewLog(o.reviewLog),
  });
}

function decodeContent(contentStr) {
  var out = { pages: [], kind: 'notebook', cards: [], deckOptions: null, reviewLog: [] };
  if (!contentStr) return out;
  var p = null;
  try { p = JSON.parse(contentStr); } catch { return out; }
  if (!p || typeof p !== 'object') return out;
  if (Array.isArray(p.pages)) out.pages = p.pages;
  else if (Array.isArray(p)) out.pages = p;
  if (p.kind === 'flashcards' || p.kind === 'deck') out.kind = 'flashcards';
  if (Array.isArray(p.cards)) out.cards = p.cards;
  if (p.deckOptions && typeof p.deckOptions === 'object') out.deckOptions = p.deckOptions;
  if (Array.isArray(p.reviewLog)) out.reviewLog = p.reviewLog;
  return out;
}

function docText(doc) {
  var parts = [];
  if (doc && doc.title) parts.push(String(doc.title));
  var md = pagesToMarkdown(doc && doc.pages);
  if (md) parts.push(md);
  var cards = (doc && Array.isArray(doc.cards)) ? doc.cards : [];
  for (var i = 0; i < cards.length; i++) {
    var c = cards[i] || {};
    if (c.front) parts.push(stripTagsLite(c.front));
    if (c.back) parts.push(stripTagsLite(c.back));
  }
  return parts.join('\n');
}

function snippetFor(text, tokens, maxLen) {
  maxLen = maxLen || 160;
  var low = String(text || '').toLowerCase();
  var ix = -1;
  for (var i = 0; i < tokens.length; i++) {
    var at = low.indexOf(tokens[i]);
    if (at >= 0 && (ix < 0 || at < ix)) ix = at;
  }
  var flat = String(text || '').replace(/\s+/g, ' ').trim();
  if (flat.length <= maxLen) return flat;
  if (ix < 0) return flat.slice(0, maxLen) + ' …';
  var from = Math.max(0, ix - 60);
  return (from > 0 ? '… ' : '') + flat.slice(from, from + maxLen) + ' …';
}

/* Row (Appwrite) <-> Doc (MCP) */

function docFromRow(row, opts) {
  var o = opts || {};
  var dec = decodeContent(row && (row.content || ''));
  var md = pagesToMarkdown(dec.pages);
  var doc = {
    id: (row && (row.$id || row.id)) || '',
    title: (row && row.title) || 'Unbenannt',
    folderId: (row && (row.folderId || null)) || null,
    kind: dec.kind,
    updatedAt: (row && (row.updatedAt || row.$updatedAt)) || null,
    pages: dec.pages.length,
  };
  if (o.includeContent !== false) {
    doc.markdown = md.slice(0, INLINE_MARKDOWN_MAX + 500);
    doc.truncated = md.length > INLINE_MARKDOWN_MAX + 500;
  }
  if (dec.kind === 'flashcards') {
    var max = Math.max(1, Math.min(200, num(o.cardsLimit, 200)));
    doc.cards = dec.cards.slice(0, max).map(function (c) { return normalizeCard(c); });
    doc.cardsTruncated = dec.cards.length > max;
    doc.cardsTotal = dec.cards.length;
    doc.deckOptions = normalizeDeckOptions(dec.deckOptions);
  }
  return doc;
}

function rowDataFromDocParts(parts, userId, existing) {
  var ex = existing || {};
  var content = encodeContent({
    pages: parts.pages !== undefined ? parts.pages : (ex.pages || []),
    kind: parts.kind !== undefined ? parts.kind : ex.kind,
    cards: parts.cards !== undefined ? parts.cards : ex.cards,
    deckOptions: parts.deckOptions !== undefined ? parts.deckOptions : ex.deckOptions,
    reviewLog: parts.reviewLog !== undefined ? parts.reviewLog : ex.reviewLog,
  });
  var t = nowMs();
  return {
    content: content,
    data: {
      userId: userId,
      title: parts.title !== undefined ? parts.title : (ex.title || 'Unbenannt'),
      content: content,
      contentFileId: ex.contentFileId || null,
      folderId: parts.folderId !== undefined ? (parts.folderId || null) : (ex.folderId || null),
      createdAt: ex.createdAt || nowIso(t),
      updatedAt: nowIso(t),
      deletedAt: null,
    },
  };
}

/* ---------- Karteikarten (SM-2, gespiegelt aus js/flashcards.js) ---------- */

var EASE_START = 2.5, EASE_MIN = 1.3, EASE_MAX = 2.8;
var AGAIN_DELAY_MS = 10 * 60 * 1000, DAY_MS = 24 * 60 * 60 * 1000;
var GRADES = ['again', 'hard', 'good', 'easy'];
var GRADE_Q = { again: 0, hard: 3, good: 4, easy: 5 };

function clampEase(e) {
  e = num(e, EASE_START);
  if (e < EASE_MIN) return EASE_MIN;
  if (e > EASE_MAX) return EASE_MAX;
  return Math.round(e * 100) / 100;
}

function normalizeGrade(g) {
  if (g === 'again' || g === 'hard' || g === 'good' || g === 'easy') return g;
  if (g === 0 || g === '0' || g === 'forgot') return 'again';
  if (g === 3 || g === '3') return 'hard';
  if (g === 4 || g === '4') return 'good';
  if (g === 5 || g === '5') return 'easy';
  return null;
}

function newCard(front, back, t) {
  t = (typeof t === 'number' && isFinite(t)) ? t : nowMs();
  return {
    id: newId('c'), front: String(front == null ? '' : front), back: String(back == null ? '' : back),
    frontImg: null, backImg: null, createdAt: t, updatedAt: t,
    ease: EASE_START, interval: 0, reps: 0, lapses: 0, due: t,
    lastReview: null, suspended: false, totalReviews: 0, correctReviews: 0,
  };
}

function normalizeCard(card, t) {
  t = (typeof t === 'number' && isFinite(t)) ? t : nowMs();
  if (!card || typeof card !== 'object') return newCard('', '', t);
  var c = card;
  if (typeof c.id !== 'string' || !c.id) c.id = newId('c');
  if (typeof c.front !== 'string') c.front = String(c.front == null ? '' : c.front);
  if (typeof c.back !== 'string') c.back = String(c.back == null ? '' : c.back);
  if (!c.frontImg) c.frontImg = null;
  if (!c.backImg) c.backImg = null;
  if (!isFinite(Number(c.createdAt))) c.createdAt = t;
  if (!isFinite(Number(c.updatedAt))) c.updatedAt = t;
  c.ease = clampEase(c.ease);
  c.interval = Math.max(0, Math.round(num(c.interval, 0)));
  c.reps = Math.max(0, Math.round(num(c.reps, 0)));
  c.lapses = Math.max(0, Math.round(num(c.lapses, 0)));
  if (!isFinite(Number(c.due))) c.due = t;
  if (c.lastReview != null && !isFinite(Number(c.lastReview))) c.lastReview = null;
  c.suspended = !!c.suspended;
  c.totalReviews = Math.max(0, Math.round(num(c.totalReviews, 0)));
  c.correctReviews = Math.max(0, Math.round(num(c.correctReviews, 0)));
  if (c.correctReviews > c.totalReviews) c.correctReviews = c.totalReviews;
  return c;
}

function normalizeDeckOptions(o) {
  o = (o && typeof o === 'object') ? o : {};
  return {
    newPerDay: Math.max(1, Math.min(500, Math.round(num(o.newPerDay, 20)))),
    maxReviewsPerDay: Math.max(1, Math.min(2000, Math.round(num(o.maxReviewsPerDay, 100)))),
  };
}

function normalizeReviewLog(log) {
  if (!Array.isArray(log)) return [];
  var out = [];
  for (var i = 0; i < log.length; i++) {
    var e = log[i];
    if (!e || typeof e !== 'object') continue;
    var t = Number(e.t), g = normalizeGrade(e.g);
    if (!isFinite(t) || !g) continue;
    out.push({ t: Math.round(t), g: g, id: typeof e.id === 'string' ? e.id : '' });
  }
  return out.length > 1000 ? out.slice(out.length - 1000) : out;
}

function easeAfter(ease, q) {
  if (q < 3) return clampEase(ease);
  return clampEase(num(ease, EASE_START) + (0.1 - (5 - q) * (0.08 + (5 - q) * 0.02)));
}

function intervalAfter(card, grade) {
  var prev = Math.max(0, Math.round(num(card && card.interval, 0)));
  var reps = Math.max(0, Math.round(num(card && card.reps, 0)));
  var ease = clampEase(card && card.ease);
  if (grade === 'again') return 0;
  if (reps <= 0) return grade === 'easy' ? 4 : 1;
  if (grade === 'hard') return Math.max(1, Math.round(prev * 1.2) || 1);
  if (grade === 'easy') {
    if (reps === 1) return 6;
    return Math.max(1, Math.round(prev * ease * 1.3));
  }
  if (reps === 1) return 6;
  return Math.max(1, Math.round(prev * ease));
}

function previewIntervals(card) {
  var c = normalizeCard(Object.assign({}, card || {}));
  return { again: 0, hard: intervalAfter(c, 'hard'), good: intervalAfter(c, 'good'), easy: intervalAfter(c, 'easy') };
}

function gradeCardInPlace(card, grade, t) {
  var g = normalizeGrade(grade);
  if (!g || !card || typeof card !== 'object') return null;
  t = (typeof t === 'number' && isFinite(t)) ? t : nowMs();
  normalizeCard(card, t);
  var q = GRADE_Q[g];
  if (g === 'again') {
    card.reps = 0; card.lapses += 1; card.interval = 0; card.due = t + AGAIN_DELAY_MS;
  } else {
    card.interval = intervalAfter(card, g);
    card.ease = easeAfter(card.ease, q);
    card.reps += 1;
    card.due = t + card.interval * DAY_MS;
  }
  card.lastReview = t; card.updatedAt = t;
  card.totalReviews += 1;
  if (g !== 'again') card.correctReviews += 1;
  return card;
}

function isDue(card, t) {
  if (!card || card.suspended) return false;
  t = (typeof t === 'number' && isFinite(t)) ? t : nowMs();
  return num(card.due, 0) <= t;
}

function deckStats(cards, reviewLog, t) {
  t = (typeof t === 'number' && isFinite(t)) ? t : nowMs();
  var list = Array.isArray(cards) ? cards : [];
  var s = { total: list.length, active: 0, suspended: 0, fresh: 0, due: 0, learned: 0, leeches: 0, accuracy: null };
  var ok = 0, all = 0;
  for (var i = 0; i < list.length; i++) {
    var c = normalizeCard(list[i], t);
    if (c.suspended) { s.suspended++; continue; }
    s.active++;
    if (!c.lastReview) s.fresh++;
    else s.learned++;
    if (isDue(c, t)) s.due++;
    if (c.lapses >= 3) s.leeches++;
    all += c.totalReviews; ok += c.correctReviews;
  }
  if (all > 0) s.accuracy = Math.round((ok / all) * 1000) / 10;
  // Fälligkeits-Vorschau: nächste 7 Tage (Tag 0 = heute/überfällig).
  s.forecast = [];
  for (var d = 0; d < 7; d++) {
    var from = t + d * DAY_MS, to = from + DAY_MS;
    var n = 0;
    for (var j = 0; j < list.length; j++) {
      var cc = list[j];
      if (!cc || cc.suspended) continue;
      var due = num(cc.due, 0);
      if (d === 0 ? due <= to : (due > from && due <= to)) n++;
    }
    s.forecast.push({ dayOffset: d, due: n });
  }
  // Streak aus reviewLog (aufeinanderfolgende Tage bis heute/gestern).
  s.streak = 0;
  try {
    var days = {};
    normalizeReviewLog(reviewLog).forEach(function (e) {
      var dk = new Date(e.t); dk.setHours(0, 0, 0, 0);
      days[dk.getTime()] = true;
    });
    var cur = new Date(t); cur.setHours(0, 0, 0, 0);
    if (!days[cur.getTime()]) cur = new Date(cur.getTime() - DAY_MS);
    while (days[cur.getTime()]) { s.streak++; cur = new Date(cur.getTime() - DAY_MS); }
  } catch { /* streak bleibt 0 */ }
  return s;
}

/* ---------- Suche (Query-Sprache lite, Scoring wie js/search.js) ---------- */

function extractTagsLite(s) {
  var out = [];
  String(s == null ? '' : s).replace(/(^|\s)#([\w/-]+)/g, function (m, pre, tag) {
    out.push(String(tag).toLowerCase());
    return m;
  });
  return out;
}

function extractTasksLite(md) {
  var todo = [], done = [];
  String(md == null ? '' : md).split('\n').forEach(function (ln) {
    var t = ln.match(/-\s*\[\s\]\s*(.*)$/);
    if (t) { todo.push((t[1] || '').trim()); return; }
    var d = ln.match(/-\s*\[[xX]\]\s*(.*)$/);
    if (d) { done.push((d[1] || '').trim()); }
  });
  return { todo: todo, done: done };
}

function parseQueryLite(q) {
  var query = String(q == null ? '' : q);
  var groups = query.split(/\s+OR\s+/);
  return groups.map(function (g) {
    var tokens = [];
    var re = /(-)?"([^"]+)"|(-)?(\S+)/g, m;
    while ((m = re.exec(g)) !== null) {
      var neg = !!(m[1] || m[3]);
      var text = m[2] !== undefined ? m[2] : m[4];
      if (!text) continue;
      var op = null, val = text;
      var cm = /^(file|path|tag|task-todo|task-done|task):(.*)$/i.exec(text);
      if (cm) { op = cm[1].toLowerCase(); val = cm[2]; }
      tokens.push({ text: val.toLowerCase(), negated: neg, op: op, raw: text });
    }
    return tokens;
  }).filter(function (g) { return g.length > 0; });
}

function matchDoc(doc, groups) {
  var title = String(doc.title || '').toLowerCase();
  var text = String(doc.markdown || '').toLowerCase();
  var cardText = '';
  (doc.cards || []).forEach(function (c) {
    cardText += ' ' + stripTagsLite(c.front).toLowerCase() + ' ' + stripTagsLite(c.back).toLowerCase();
  });
  var full = text + cardText;
  var tags = extractTagsLite(doc.title + '\n' + (doc.markdown || ''));
  var tasks = extractTasksLite(doc.markdown || '');
  var score = 0, matched = false;
  for (var gi = 0; gi < groups.length; gi++) {
    var toks = groups[gi], ok = true, gs = 0;
    for (var i = 0; i < toks.length; i++) {
      var tk = toks[i], hit = false, w = 0;
      if (tk.op === 'file' || tk.op === 'path') {
        hit = title.indexOf(tk.text) >= 0;
        w = 10;
      } else if (tk.op === 'tag') {
        var needle = tk.text.replace(/^#/, '');
        hit = tags.some(function (t) { return t.indexOf(needle) === 0; });
        w = 5;
      } else if (tk.op === 'task-todo' || tk.op === 'task') {
        hit = tasks.todo.some(function (t) { return t.toLowerCase().indexOf(tk.text) >= 0; }) ||
          (tk.op === 'task' && tasks.done.some(function (t) { return t.toLowerCase().indexOf(tk.text) >= 0; }));
        w = 3;
      } else if (tk.op === 'task-done') {
        hit = tasks.done.some(function (t) { return t.toLowerCase().indexOf(tk.text) >= 0; });
        w = 3;
      } else if (tk.text.charAt(0) === '#') {
        var nt = tk.text.slice(1);
        hit = tags.some(function (t) { return t.indexOf(nt) === 0; });
        w = hit && title.indexOf(tk.text) >= 0 ? 10 : 5;
        if (title.indexOf(tk.text) >= 0) { hit = true; w = 10; }
      } else {
        var inTitle = title.indexOf(tk.text) >= 0;
        var inText = full.indexOf(tk.text) >= 0;
        hit = inTitle || inText;
        w = (inTitle ? 10 : 0) + (inText ? 1 : 0);
        var tagHit = tags.some(function (t) { return t.indexOf(tk.text) === 0; });
        if (tagHit) { hit = true; w += 5; }
      }
      if (tk.negated) {
        if (hit) { ok = false; break; }
      } else {
        if (!hit) { ok = false; break; }
        gs += w;
      }
    }
    if (ok) { matched = true; score = Math.max(score, gs); }
  }
  return matched ? score : -1;
}

function advancedSearchDocs(docs, query, limit) {
  var groups = parseQueryLite(query);
  if (!groups.length) return [];
  var out = [];
  for (var i = 0; i < docs.length; i++) {
    var s = matchDoc(docs[i], groups);
    if (s >= 0) {
      var toks = query.toLowerCase().split(/[^a-z0-9äöüß#]+/).filter(function (t) { return t.length >= 2; });
      out.push({
        id: docs[i].id, title: docs[i].title || 'Unbenannt', score: s,
        snippet: snippetFor((docs[i].markdown || '').replace(/\s+/g, ' '), toks),
      });
    }
  }
  out.sort(function (a, b) { return b.score - a.score || String(a.title).localeCompare(String(b.title), 'de'); });
  var n = Math.max(1, Math.min(100, num(limit, 20)));
  return out.slice(0, n);
}

/* ---------- Graph (Wikilinks [[...]]) ---------- */

var WIKILINK_RE = /\[\[([^\]]+)\]\]/g;
function extractWikilinks(input) {
  var out = [];
  var s = String(input == null ? '' : input);
  if (!s) return out;
  WIKILINK_RE.lastIndex = 0;
  var m;
  while ((m = WIKILINK_RE.exec(s)) !== null) {
    var inner = m[1];
    var pipe = inner.indexOf('|');
    if (pipe !== -1) inner = inner.slice(0, pipe);
    var hash = inner.indexOf('#');
    if (hash !== -1) inner = inner.slice(0, hash);
    var target = inner.trim();
    if (target) out.push(target);
  }
  return out;
}

function buildGraph(docs) {
  var nodes = (docs || []).map(function (d) {
    return { id: d.id, title: d.title || 'Unbenannt', kind: d.kind || 'notebook' };
  });
  var byTitle = {};
  nodes.forEach(function (n) { byTitle[String(n.title).toLowerCase()] = n.id; });
  var edges = [];
  (docs || []).forEach(function (d) {
    var links = extractWikilinks(d.markdown || '');
    var seen = {};
    links.forEach(function (t) {
      var key = String(t).toLowerCase();
      if (seen[key]) return;
      seen[key] = true;
      edges.push({ from: d.id, toTitle: t, to: byTitle[key] || null });
    });
  });
  return { nodes: nodes, edges: edges };
}

function localGraph(full, startId, depth) {
  depth = Math.max(0, Math.min(3, num(depth, 1)));
  var adj = {};
  full.edges.forEach(function (e) {
    if (!e.to) return;
    (adj[e.from] = adj[e.from] || []).push(e.to);
    (adj[e.to] = adj[e.to] || []).push(e.from);
  });
  var seen = {}, frontier = [startId], d = 0;
  seen[startId] = true;
  while (frontier.length && d < depth) {
    var next = [];
    frontier.forEach(function (id) {
      ((adj[id]) || []).forEach(function (nb) {
        if (!seen[nb]) { seen[nb] = true; next.push(nb); }
      });
    });
    frontier = next; d++;
  }
  return {
    nodes: full.nodes.filter(function (n) { return seen[n.id]; }),
    edges: full.edges.filter(function (e) { return e.to && seen[e.from] && seen[e.to]; }),
  };
}

/* ---------- Validierung ---------- */

function checkTitle(t) {
  if (t !== undefined && String(t).length > TITLE_MAX) throw new Error('title zu lang (max ' + TITLE_MAX + ' Zeichen)');
}
function checkContentBytes(contentStr) {
  if (Buffer.byteLength(contentStr, 'utf8') > CONTENT_MAX_BYTES) {
    throw new Error('Inhalt zu groß (max ' + Math.round(CONTENT_MAX_BYTES / 1024) + ' KB pro Schreibvorgang)');
  }
}
function checkCards(cards, required) {
  if (cards === undefined) {
    if (required) throw new Error('cards fehlt (Array aus {front, back})');
    return [];
  }
  if (!Array.isArray(cards)) throw new Error('cards muss ein Array sein');
  if (!cards.length && required) throw new Error('cards ist leer');
  if (cards.length > BULK_CARDS_MAX) throw new Error('max ' + BULK_CARDS_MAX + ' Karten pro Aufruf');
  return cards.map(function (c, i) {
    if (!c || typeof c !== 'object') throw new Error('cards[' + i + '] ist kein Objekt');
    return newCard(c.front, c.back);
  });
}

module.exports = {
  OFFLOAD_BYTES: OFFLOAD_BYTES, INLINE_ROW_MAX: INLINE_ROW_MAX,
  INLINE_MARKDOWN_MAX: INLINE_MARKDOWN_MAX,
  TITLE_MAX: TITLE_MAX, BULK_CARDS_MAX: BULK_CARDS_MAX,
  nowMs: nowMs, nowIso: nowIso, newId: newId, rowIdFor: rowIdFor, normTitle: normTitle,
  escHtml: escHtml, mdToHtmlLite: mdToHtmlLite, htmlToMdLite: htmlToMdLite,
  blankPage: blankPage, contentToPages: contentToPages, pagesToMarkdown: pagesToMarkdown,
  stripTagsLite: stripTagsLite, pageText: pageText,
  encodeContent: encodeContent, decodeContent: decodeContent, docText: docText, snippetFor: snippetFor,
  docFromRow: docFromRow, rowDataFromDocParts: rowDataFromDocParts,
  GRADES: GRADES, normalizeGrade: normalizeGrade, newCard: newCard, normalizeCard: normalizeCard,
  normalizeDeckOptions: normalizeDeckOptions, normalizeReviewLog: normalizeReviewLog,
  previewIntervals: previewIntervals, gradeCardInPlace: gradeCardInPlace, isDue: isDue, deckStats: deckStats,
  extractTagsLite: extractTagsLite, extractTasksLite: extractTasksLite,
  parseQueryLite: parseQueryLite, advancedSearchDocs: advancedSearchDocs,
  extractWikilinks: extractWikilinks, buildGraph: buildGraph, localGraph: localGraph,
  checkTitle: checkTitle, checkContentBytes: checkContentBytes, checkCards: checkCards,
};
