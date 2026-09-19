/* Federwerk SPEC-07 light – Query-Sprache für die Bibliothekssuche (Vault light).
 *
 * - Reine Funktionen, bewusst ohne Browser-Zugriff: per <script> im Browser
 *   (global GrimoireSearch) und per require() in Node-Tests ladbar.
 * - parseQuery(q): Tokenizer für OR (nur Großschreibung, Default AND via
 *   Leerzeichen), -Negation, ""-Phrasen, Operatoren file: path: tag:
 *   task-todo: task-done: (Präfix-Match, case-insensitiv). Unbekannte
 *   Operatoren (z. B. line:, section:) werden tolerant als Text behandelt.
 *   task: ist ein Alias für (task-todo ODER task-done).
 * - matchBook(book, parsed|query): Titel-, Text-, Tag- und Task-Matcher.
 *   file:/path: wirken auf Buchtitel + Seitenindex ("Seite N"), nicht auf
 *   Volltext. Tags via /(^|\s)#([\w\/-]+)/, Tasks via "- [ ]"/"- [x]"-Mustern
 *   (Markdown-Quelle) plus gerenderten Checkboxen (data-marker/checked).
 * - rankBooks(books, parsed|query): Treffer mit Score
 *   (Titel 10 > Tag 5 > Task 3 > Text 1), stabile Sortierung
 *   (Score absteigend, dann Originalindex).
 * - Fehlertolerant: parseQuery/matchBook/rankBooks werfen nie (kaputte
 *   Syntax -> leere Query bzw. "alles zeigen"), Umlaute via toLowerCase.
 */
var GrimoireSearch = (function () {
  'use strict';

  var SCORE_TITLE = 10;
  var SCORE_TAG = 5;
  var SCORE_TASK = 3;
  var SCORE_TEXT = 1;
  // Anzeige-Limit für ```query-Blöcke (gilt in js/app.js, nur Anzeige, max 5).
  var QUERY_MAX_RESULTS = 5;

  /* ---------- kleine Helfer (rein, ohne Browser-APIs) ---------- */

  function normLower(s) {
    return String(s == null ? '' : s).toLowerCase();
  }

  // stripHtml-Kopie ohne DOM (vgl. stripHtml in js/app.js, dort per div).
  function stripHtml(h) {
    return String(h == null ? '' : h)
      .replace(/<script[\s\S]*?<\/script>/gi, ' ')
      .replace(/<style[\s\S]*?<\/style>/gi, ' ')
      .replace(/<[^>]*>/g, ' ')
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&amp;/g, '&') // absichtlich zuletzt (kein Doppel-Dekodieren)
      .replace(/[ \t\u00a0]+/g, ' ');
  }

  function splitWords(s) {
    return normLower(s).split(/[^a-z0-9äöüß]+/).filter(function (w) { return !!w; });
  }

  // Tags via /(^|\s)#([\w\/-]+)/ (SPEC-07 light); Rückgabe klein, ohne '#'.
  function extractTags(s) {
    var out = [];
    String(s == null ? '' : s).replace(/(^|\s)#([\w\/-]+)/g, function (m, pre, tag) {
      out.push(String(tag).toLowerCase());
      return m;
    });
    return out;
  }

  // Tasks aus Box-HTML: gerenderte Checkboxen (data-marker, ersatzweise
  // checked-Attribut) plus Markdown-Marker "- [ ]"/"- [x]" im reinen Text.
  // "[/]" (halb) zählt weder als todo noch als done.
  function extractTasks(htmls, plain) {
    var todo = [], done = [];
    (Array.isArray(htmls) ? htmls : []).forEach(function (h) {
      var html = String(h == null ? '' : h);
      var re = /<input[^>]*type="checkbox"[^>]*>\s*([^<]*)/gi;
      var m;
      while ((m = re.exec(html)) !== null) {
        var tag = m[0].match(/data-marker="([ xX\/])"/);
        var txt = stripHtml(m[1] || '').trim();
        if (tag) {
          var mk = String(tag[1]).toLowerCase();
          if (mk === 'x') done.push(txt);
          else if (mk !== '/') todo.push(txt);
        } else if (/checked/i.test(m[0])) {
          done.push(txt);
        } else {
          todo.push(txt);
        }
      }
    });
    String(plain == null ? '' : plain).split('\n').forEach(function (ln) {
      var t = ln.match(/-\s*\[\s\]\s*(.*)$/);
      if (t) { todo.push((t[1] || '').trim()); return; }
      var d = ln.match(/-\s*\[[xX]\]\s*(.*)$/);
      if (d) { done.push((d[1] || '').trim()); }
    });
    return { todo: todo, done: done };
  }

  /* ---------- parseQuery ---------- */

  // Zerlegt in Rohtokens { text, negated, phrase, quoted }.
  // ""-Phrasen (fehlendes Schluss-" gilt tolerant als Phrase bis Ende),
  // -Negation (nur direkt vor nicht-Leerzeichen), eingebettete Quotes für
  // Operatorwerte (tag:"a b") bleiben EIN Token.
  function tokenize(src) {
    var tokens = [];
    var s = String(src == null ? '' : src);
    var i = 0, n = s.length;
    while (i < n) {
      while (i < n && /\s/.test(s[i])) i++;
      if (i >= n) break;
      var negated = false;
      if (s[i] === '-' && i + 1 < n && !/\s/.test(s[i + 1])) { negated = true; i++; }
      if (i < n && s[i] === '"') {
        i++;
        var buf = '';
        while (i < n && s[i] !== '"') { buf += s[i]; i++; }
        if (i < n) i++; // schliessendes " verzehren
        tokens.push({ text: buf, negated: negated, phrase: true, quoted: false });
      } else {
        var out = '', q = false;
        while (i < n && !/\s/.test(s[i])) {
          if (s[i] === '"') {
            q = true; i++;
            while (i < n && s[i] !== '"') { out += s[i]; i++; }
            if (i < n) i++;
          } else { out += s[i]; i++; }
        }
        tokens.push({ text: out, negated: negated, phrase: false, quoted: q });
      }
    }
    return tokens;
  }

  var OP_RE = /^(file|path|tag|task-todo|task-done|task):([\s\S]*)$/i;

  function classify(tok) {
    // OR nur in Großschreibung, nicht negiert, keine Phrase/Quote.
    if (!tok.negated && !tok.phrase && !tok.quoted && tok.text === 'OR') return { sep: true };
    if (!tok.phrase) {
      var m = tok.text.match(OP_RE);
      if (m) {
        return { field: m[1].toLowerCase(), value: (m[2] || '').trim(), phrase: !!tok.quoted, negated: tok.negated };
      }
    }
    return { field: 'text', value: String(tok.text).trim(), phrase: !!tok.phrase || !!tok.quoted, negated: tok.negated };
  }

  // Query -> { raw, groups, terms, isEmpty }. Wirft nie.
  // groups: OR-Alternativen, je eine Liste AND-verknüpfter Terme.
  // Term: { field, value, phrase, negated }.
  function parseQuery(q) {
    var raw = (q == null) ? '' : String(q);
    var groups = [], terms = [];
    try {
      var cur = [];
      tokenize(raw).forEach(function (rt) {
        var t = classify(rt);
        if (t.sep) { if (cur.length) { groups.push(cur); cur = []; } return; }
        if (t.value === '' || (t.field === 'text' && t.value === '-')) {
          // Leere Werte: file:/path:/tag:/Text sind neutral (ignorieren);
          // leeres task-todo:/task-done:/task: = Existenz-Check (behalten).
          if (t.field === 'task-todo' || t.field === 'task-done' || t.field === 'task') cur.push(t);
          return;
        }
        cur.push(t);
      });
      if (cur.length) groups.push(cur);
      groups.forEach(function (g) { terms.push.apply(terms, g); });
    } catch (e) { groups = []; terms = []; }
    return { raw: raw, groups: groups, terms: terms, isEmpty: groups.length === 0 };
  }

  /* ---------- Buch-Korpus + Matcher ---------- */

  function bookTitleOf(book) {
    if (!book || book.title == null) return '';
    return (typeof book.title === 'string') ? book.title : String(book.title);
  }

  function bookHtmls(book) {
    var out = [];
    try {
      var pages = (book && Array.isArray(book.pages)) ? book.pages : [];
      pages.forEach(function (p) {
        var texts = (p && Array.isArray(p.texts)) ? p.texts : [];
        texts.forEach(function (t) {
          out.push(t && t.html != null ? String(t.html) : '');
        });
      });
    } catch (e) { /* Bestand darf nie crashen */ }
    return out;
  }

  function buildCorpus(book) {
    var title = bookTitleOf(book);
    var htmls = bookHtmls(book);
    var plain = htmls.map(stripHtml).join('\n');
    var pageCount = 0;
    try { pageCount = (book && Array.isArray(book.pages)) ? book.pages.length : 0; } catch (e) { pageCount = 0; }
    var labels = [];
    for (var k = 1; k <= pageCount; k++) labels.push('seite ' + k);
    var tasks = { todo: [], done: [] };
    try {
      var r = extractTasks(htmls, plain);
      tasks = { todo: r.todo.map(normLower), done: r.done.map(normLower) };
    } catch (e) { tasks = { todo: [], done: [] }; }
    return {
      titleLower: normLower(title),
      fileHayLower: normLower(title + ' ' + labels.join(' ')),
      textLower: normLower(plain),
      tags: extractTags(title + '\n' + plain),
      todo: tasks.todo,
      done: tasks.done
    };
  }

  // Präfix-Match, case-insensitiv (Eingaben bereits kleingeschrieben):
  // Treffer bei Ganz-Präfix oder wenn jedes Wert-Wort Präfix eines
  // Korpus-Worts ist (deckt Einwort- UND Phrasenwerte ab).
  function matchesPrefix(hayLower, needleLower) {
    var hay = String(hayLower || ''), nd = String(needleLower || '');
    if (!nd) return true;
    if (hay.slice(0, nd.length) === nd) return true;
    var hayWords = splitWords(hay);
    var ndWords = splitWords(nd);
    if (!ndWords.length) return hay.indexOf(nd) !== -1;
    return ndWords.every(function (w) {
      return hayWords.some(function (hw) { return hw.slice(0, w.length) === w; });
    });
  }

  // Tag-Match: führende '#' am Wert sind optional, Präfix genügt.
  function tagMatch(tagsLower, rawVal) {
    var v = normLower(rawVal).replace(/^#+/, '').trim();
    if (!v) return true;
    for (var i = 0; i < tagsLower.length; i++) {
      if (tagsLower[i] === v || tagsLower[i].slice(0, v.length) === v) return true;
    }
    return false;
  }

  function taskListMatch(listLower, needleLower) {
    if (!needleLower) return listLower.length > 0; // Existenz-Check
    for (var i = 0; i < listLower.length; i++) {
      if (listLower[i].indexOf(needleLower) !== -1) return true;
    }
    return false;
  }

  function matchTerm(cp, term) {
    var vl = normLower(term.value);
    if (!vl) {
      if (term.field === 'task-todo') return cp.todo.length > 0;
      if (term.field === 'task-done') return cp.done.length > 0;
      if (term.field === 'task') return (cp.todo.length + cp.done.length) > 0;
      return true; // file:/path:/tag:/Text ohne Wert sind neutral
    }
    switch (term.field) {
      case 'file':
      case 'path':
        return matchesPrefix(cp.fileHayLower, vl);
      case 'tag':
        return tagMatch(cp.tags, vl);
      case 'task-todo':
        return taskListMatch(cp.todo, vl);
      case 'task-done':
        return taskListMatch(cp.done, vl);
      case 'task':
        return taskListMatch(cp.todo, vl) || taskListMatch(cp.done, vl);
      default:
        return cp.titleLower.indexOf(vl) !== -1 || cp.textLower.indexOf(vl) !== -1;
    }
  }

  // Buch passt, wenn eine OR-Gruppe komplett (AND) passt; Negation kehrt um.
  // Leere Query passt auf alles. Wirft nie (Fehler -> true = alles zeigen).
  function matchBook(book, parsed) {
    try {
      var p = (typeof parsed === 'string' || parsed == null) ? parseQuery(parsed) : parsed;
      if (!p || p.isEmpty || !Array.isArray(p.groups) || !p.groups.length) return true;
      var cp = buildCorpus(book);
      for (var g = 0; g < p.groups.length; g++) {
        var grp = p.groups[g];
        var ok = true;
        for (var t = 0; t < grp.length; t++) {
          var hit = true;
          try { hit = matchTerm(cp, grp[t]); } catch (e) { hit = true; }
          if (grp[t].negated) hit = !hit;
          if (!hit) { ok = false; break; }
        }
        if (ok) return true;
      }
      return false;
    } catch (e) { return true; }
  }

  // Score eines (nicht-negierten) Terms im Korpus.
  function scoreTerm(cp, term) {
    if (term.negated) return 0;
    var vl = normLower(term.value);
    if (!vl) {
      if (term.field === 'task-todo') return cp.todo.length ? SCORE_TASK : 0;
      if (term.field === 'task-done') return cp.done.length ? SCORE_TASK : 0;
      if (term.field === 'task') return (cp.todo.length + cp.done.length) ? SCORE_TASK : 0;
      return 0;
    }
    switch (term.field) {
      case 'file':
      case 'path':
        return matchesPrefix(cp.fileHayLower, vl) ? SCORE_TITLE : 0;
      case 'tag':
        return tagMatch(cp.tags, vl) ? SCORE_TAG : 0;
      case 'task-todo':
        return taskListMatch(cp.todo, vl) ? SCORE_TASK : 0;
      case 'task-done':
        return taskListMatch(cp.done, vl) ? SCORE_TASK : 0;
      case 'task':
        return (taskListMatch(cp.todo, vl) || taskListMatch(cp.done, vl)) ? SCORE_TASK : 0;
      default: {
        var s = 0;
        if (cp.titleLower.indexOf(vl) !== -1) s += SCORE_TITLE;
        if (tagMatch(cp.tags, vl)) s += SCORE_TAG;
        if (cp.textLower.indexOf(vl) !== -1) s += SCORE_TEXT;
        return s;
      }
    }
  }

  function scoreBook(book, parsed) {
    try {
      var p = (typeof parsed === 'string' || parsed == null) ? parseQuery(parsed) : parsed;
      if (!p || p.isEmpty) return 0;
      var cp = buildCorpus(book);
      var s = 0, g, t;
      for (g = 0; g < p.groups.length; g++) {
        for (t = 0; t < p.groups[g].length; t++) {
          try { s += scoreTerm(cp, p.groups[g][t]); } catch (e) { /* Term zahlt 0 */ }
        }
      }
      return s;
    } catch (e) { return 0; }
  }

  // Filtert + sortiert: [{ book, score, index }], Score absteigend,
  // bei Gleichstand Originalreihenfolge (stabil). Leere Query -> alle
  // in Originalreihenfolge mit Score 0. Wirft nie.
  function rankBooks(books, query) {
    try {
      var list = Array.isArray(books) ? books : [];
      var p = (typeof query === 'string' || query == null) ? parseQuery(query) : query;
      if (!p || p.isEmpty || !Array.isArray(p.groups) || !p.groups.length) {
        return list.map(function (b, i) { return { book: b, score: 0, index: i }; });
      }
      var out = [];
      list.forEach(function (b, i) {
        var ok = false;
        try { ok = matchBook(b, p); } catch (e) { ok = true; }
        if (ok) {
          var s = 0;
          try { s = scoreBook(b, p); } catch (e) { s = 0; }
          out.push({ book: b, score: s, index: i });
        }
      });
      out.sort(function (a, b) { return (b.score - a.score) || (a.index - b.index); });
      return out;
    } catch (e) { return []; }
  }

  return {
    parseQuery: parseQuery,
    matchBook: matchBook,
    rankBooks: rankBooks,
    scoreBook: scoreBook,
    stripHtml: stripHtml,
    extractTags: extractTags,
    extractTasks: extractTasks,
    QUERY_MAX_RESULTS: QUERY_MAX_RESULTS
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GrimoireSearch;
