/* Federwerk Markdown-Editor - Render-Pipeline (js/md-render.js)
 *
 * Aufbau (SPEC-39):
 *   Quelle -> OFM-Vorbereitung -> markdown-wasm (CommonMark+GFM)
 *          -> OFM-Nachbearbeitung -> Sanitizer -> Marker -> HTML
 *   HTML   -> Normalisierung -> Bloecke -> Markdown
 *
 * markdown-wasm liegt vendored in js/vendor/ (kein CDN, kein node_modules,
 * MIT). Der WASM-Parser macht den eigentlichen Job; darueber liegt der
 * OFM-Layer aus SPEC-13: Wikilinks, Embeds, Callouts, ==Highlight==,
 * %%Kommentar%% und die halbe Aufgabe "- [/]".
 *
 * Fuer die Live-Vorschau (markText-Idee) werden zusaetzlich Marker-Spans
 * eingefuegt, die die Markdown-Zeichen tragen ("**", "## ", ...). Sie sind
 * per CSS unsichtbar und werden sichtbar geschaltet, sobald der Cursor im
 * Block steht. Der Serializer ignoriert diese Spans und schreibt die Zeichen
 * aus den Elementen heraus - die Marker sind also nur Anzeige, nie Quelle.
 *
 * Bewusst strings rein, strings raus (kein DOM): dadurch sind Render und
 * Roundtrip ohne Browser testbar (tests/md-editor.test.js).
 */
var FederwerkMarkdown = (function () {
  'use strict';

  /* ---------- Konfiguration ---------- */
  var F = {
    COLLAPSE_WHITESPACE: 1,
    PERMISSIVE_ATX_HEADERS: 2,
    PERMISSIVE_URL_AUTO_LINKS: 4,
    PERMISSIVE_EMAIL_AUTO_LINKS: 8,
    NO_INDENTED_CODE_BLOCKS: 16,
    NO_HTML_BLOCKS: 32,
    NO_HTML_SPANS: 64,
    TABLES: 256,
    STRIKETHROUGH: 512,
    PERMISSIVE_WWW_AUTOLINKS: 1024,
    TASK_LISTS: 2048,
    LATEX_MATH_SPANS: 4096,
    WIKI_LINKS: 8192,
    UNDERLINE: 16384
  };
  /* Rohes HTML bleibt erlaubt, weil der OFM-Layer eigenes Inline-HTML
   * einsetzt (<mark>, <a class="wikilink">, Checkbox-Zustaende). Deshalb ist
   * der Sanitizer (js/sanitize.js) Pflicht und laeuft immer mit - genau wie
   * beim Rich-Text-Editor der Textboxen. NO_HTML_BLOCKS nimmt dennoch ganze
   * HTML-Bloecke aus dem Spiel, die nur als Text erscheinen sollen. */
  var FLAGS = F.COLLAPSE_WHITESPACE | F.PERMISSIVE_ATX_HEADERS | F.PERMISSIVE_URL_AUTO_LINKS
    | F.PERMISSIVE_EMAIL_AUTO_LINKS | F.TABLES | F.STRIKETHROUGH | F.TASK_LISTS
    | F.NO_HTML_BLOCKS;

  var CALLOUT_TYPES = { note: 1, tip: 1, warning: 1, caution: 1, danger: 1, info: 1, example: 1, quote: 1 };
  var IMG_EXT = /\.(?:png|jpe?g|gif|webp|svg|avif|bmp|ico)$/i;
  var WL_PREFIX = '#wl:';
  var PH = '\uE000';  // Platzhalter-Beginn (Private Use, ueberlebt Escaping)
  var PH2 = '\uE001'; // Platzhalter-Ende
  var HARD = '\uE002'; // Umbruch-Marker: erzeugt einen harten Umbruch ("  \n"),
  //                      muss aber die Leerzeichen-Zeihe ueberleben, die
  //                      joinBlocks am Zeilenende entfernt.

  /* ---------- reine Helfer ---------- */
  function esc(s) {
    return String(s == null ? '' : s)
      .replace(/&/g, '&amp;').replace(/</g, '&lt;').replace(/>/g, '&gt;').replace(/"/g, '&quot;');
  }

  var ENTITIES = { amp: '&', lt: '<', gt: '>', quot: '"', apos: "'", nbsp: ' ' };
  function decodeEntities(s) {
    return String(s == null ? '' : s).replace(/&(#x?[0-9a-fA-F]+|[a-zA-Z]+);/g, function (m, body) {
      if (body.charAt(0) === '#') {
        var code = body.charAt(1) === 'x' || body.charAt(1) === 'X'
          ? parseInt(body.slice(2), 16)
          : parseInt(body.slice(1), 10);
        if (!isFinite(code) || code < 0 || code > 0x10ffff) return m;
        try { return String.fromCodePoint(code); } catch (e) { return m; }
      }
      return ENTITIES[body] != null ? ENTITIES[body] : m;
    });
  }

  function slugify(s) {
    var out = decodeEntities(String(s == null ? '' : s))
      .replace(/<[^>]*>/g, '')
      .toLowerCase()
      .replace(/[^\w\u00c0-\u1fff -]+/g, '')
      .trim()
      .replace(/\s+/g, '-')
      .slice(0, 60);
    return out || 'abschnitt';
  }

  function stripMd(s) {
    return String(s == null ? '' : s)
      .replace(/!?\[\[([^\[\]\n|]+)(?:\|([^\[\]\n]+))?\]\]/g, function (m, t, a) { return (a || t).trim(); })
      .replace(/!\[([^\]\n]*)\]\([^)]*\)/g, '$1')
      .replace(/\[([^\]\n]*)\]\([^)]*\)/g, '$1')
      .replace(/[`*_~=]{1,3}/g, '')
      .replace(/\s+/g, ' ')
      .trim();
  }

  /* ---------- Engine (markdown-wasm) ---------- */
  var engine = null;

  function loadEngine() {
    if (engine) return engine;
    if (typeof window !== 'undefined' && window.markdown) { engine = window.markdown; return engine; }
    if (typeof globalThis !== 'undefined' && globalThis.markdown) { engine = globalThis.markdown; return engine; }
    return null;
  }

  /* Node: require() des vendored Builds. Emscripten nimmt im Browser den
   * fetch()-Pfad fuer die .wasm; in Node gibt es fetch auch, das scheitert
   * aber am Windows-Pfad ("unknown scheme"). Deshalb wird fetch fuer die
   * Dauer des require() auf einen Datei-Loader gehaengt - danach laeuft der
   * Build ueber readFileSync weiter. */
  function loadEngineNode() {
    if (typeof module === 'undefined' || !module.exports) return null;
    var fs = null;
    try { fs = require('fs'); } catch (e) { return null; }
    var realFetch = typeof fetch === 'function' ? fetch : null;
    function fileFetch(input) {
      var p = String(input && input.url ? input.url : input);
      if (/^[a-z]:[\\/]/i.test(p) || p.indexOf('file://') === 0) {
        try {
          var buf = fs.readFileSync(p.replace(/^file:\/\//, ''));
          if (typeof Response === 'function') {
            return Promise.resolve(new Response(buf, { headers: { 'content-type': 'application/wasm' } }));
          }
          return Promise.resolve({ ok: true, arrayBuffer: function () { return Promise.resolve(buf.buffer.slice(buf.byteOffset, buf.byteOffset + buf.byteLength)); } });
        } catch (e) { /* Datei fehlt: Original-fetch darf den Fehler zeigen */ }
      }
      if (realFetch) return realFetch.apply(null, arguments);
      return Promise.reject(new Error('markdown-wasm: ' + p + ' nicht lesbar'));
    }
    try {
      globalThis.fetch = fileFetch;
      engine = require('./vendor/markdown.js');
    } catch (e) {
      engine = null;
    } finally {
      if (realFetch) globalThis.fetch = realFetch;
      else try { delete globalThis.fetch; } catch (e) { /* ignore */ }
    }
    return engine;
  }

  function available() { return !!loadEngine(); }

  function ready() {
    var e = loadEngine() || loadEngineNode();
    if (!e) return Promise.reject(new Error('markdown-wasm fehlt (js/vendor/markdown.js)'));
    return e.ready ? e.ready.then(function () { return e; }) : Promise.resolve(e);
  }

  /* ---------- Stufe 1: Quelle -> Parser-Eingabe ---------- */
  function hold(blocks, item) {
    blocks.push(item);
    return PH + blocks.length + PH2;
  }

  /* Code zuerst wegsichern: innerhalb von ``` und ` wird nichts umgeschrieben
   * (kein ==, keine Wikilinks) und spaeter wieder als echter Code eingesetzt. */
  function protectCode(text, blocks) {
    var out = String(text).replace(/(^|\n)([ \t]*)(`{3,}|~{3,})([^\n]*)\n([\s\S]*?)(?:\n[ \t]*\3[ \t]*(?=\n|$)|$)/g,
      function (m, lead, indent, fence, info, body) {
        var lang = String(info || '').trim();
        return lead + indent + hold(blocks, { block: true, lang: lang.split(/\s+/)[0] || '', code: body });
      });
    out = out.replace(/(`+)([^`\n]+)\1/g, function (m, ticks, code) {
      return hold(blocks, { block: false, code: code });
    });
    return out;
  }

  /* OFM-Syntaxen, die es als HTML braucht, in rohes Inline-HTML uebersetzen.
   * Reihenfolge ist bedeutsam: Embeds zuerst, sonst frisst der Wikilink die
   * eckigen Klammern von ![[...]] mit. */
  function ofmPrepare(text, blocks) {
    var out = protectCode(text, blocks);

    out = out.replace(/!\[\[([^\[\]\n]+?)\]\]/g, function (m, inner) {
      var pipe = inner.indexOf('|');
      var target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
      var size = pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
      if (!target) return m;
      if (IMG_EXT.test(target)) {
        var w = /^\d{1,4}$/.test(size) ? ' width="' + size + '"' : '';
        return '<img class="md-embed" src="' + esc(target) + '" alt="' + esc(target) + '"' + w + '>';
      }
      return '<a class="md-embed" href="' + WL_PREFIX + esc(target) + '">' + esc(target) + '</a>';
    });

    out = out.replace(/\[\[([^\[\]\n]+?)\]\]/g, function (m, inner) {
      var pipe = inner.indexOf('|');
      var target = (pipe >= 0 ? inner.slice(0, pipe) : inner).trim();
      var alias = pipe >= 0 ? inner.slice(pipe + 1).trim() : '';
      if (!target) return m;
      return '<a class="wikilink" href="' + WL_PREFIX + esc(target) + '">' + esc(alias || target) + '</a>';
    });

    out = out.replace(/==(?=\S)([^\n]*?\S)==/g, function (m, inner) {
      return '<mark>' + esc(inner) + '</mark>';
    });

    out = out.replace(/%%([^\n]*?)%%/g, function (m, inner) {
      return '<span class="md-comment">' + esc(inner) + '</span>';
    });

    // halbe Aufgabe: GFM kennt nur [ ] und [x], OFM hat zusaetzlich [/]
    out = out.replace(/^([ \t]*[-*+][ \t]+)\[\/\][ \t]*/gm, '$1[ ] <span class="md-half"></span>');
    return out;
  }

  /* ---------- Stufe 2: Parser ---------- */
  function parse(text, blocks) {
    var e = loadEngine();
    if (!e) return null;
    var flags = FLAGS;
    if (e.ParseFlags) {
      var P = e.ParseFlags;
      flags = P.COLLAPSE_WHITESPACE | P.PERMISSIVE_ATX_HEADERS | P.PERMISSIVE_URL_AUTO_LINKS
        | P.PERMISSIVE_EMAIL_AUTO_LINKS | P.TABLES | P.STRIKETHROUGH | P.TASK_LISTS | P.NO_HTML_BLOCKS;
    }
    return e.parse(text, { parseFlags: flags });
  }

  /* ---------- Stufe 3: Nachbearbeitung des HTML ---------- */
  function restoreCode(html, blocks, withMarkers) {
    var M = markerSpan;
    // Der Platzhalter steht allein in einer Zeile und landet damit in einem
    // <p> - den leeren Absatz wegraeumen, sonst steckt der Codeblock in einem.
    html = html.replace(new RegExp('<p>\\s*' + PH + '(\\d+)' + PH2 + '\\s*</p>', 'g'), PH + '$1' + PH2);
    return html.replace(new RegExp(PH + '(\\d+)' + PH2, 'g'), function (m, n) {
      var b = blocks[parseInt(n, 10) - 1];
      if (!b) return '';
      if (!b.block) return '<code>' + esc(b.code) + '</code>';
      var open = withMarkers ? M('```' + b.lang) : '```' + b.lang;
      var cls = b.lang ? ' class="language-' + esc(b.lang) + '"' : '';
      return '<pre>' + open + '\n<code' + cls + '>' + esc(b.code) + '\n</code>' + (withMarkers ? M('```') : '```') + '</pre>';
    });
  }

  /* "> [!note] Titel" ist im HTML nur ein Blockquote -> Callout-Div. */
  function callouts(html) {
    return html.replace(/<blockquote>\s*<p>([\s\S]*?)<\/p>\s*<\/blockquote>/g, function (m, inner) {
      var nl = inner.indexOf('\n');
      var head = nl < 0 ? inner : inner.slice(0, nl);
      var body = nl < 0 ? '' : inner.slice(nl + 1);
      var m2 = /^\s*\[!([a-zA-Z][\w-]*)\]([-+]?)\s*([\s\S]*)$/.exec(head);
      if (!m2) return m;
      var type = m2[1].toLowerCase();
      if (!CALLOUT_TYPES[type]) type = 'note';
      var fold = m2[2] === '-' ? 'closed' : (m2[2] === '+' ? 'open' : '');
      var title = m2[3] || type;
      return '<div class="md-callout md-callout-' + type + '" data-fold="' + fold + '">' +
        '<div class="md-callout-title">' + title + '</div>' +
        (body ? '<div class="md-callout-body">' + body + '</div>' : '') + '</div>';
    });
  }

  function markerSpan(text) {
    return '<span class="md-marker">' + text + '</span>';
  }

  /* Marker einhängen. Erst nach dem Sanitizer, weil der Sanitizer
   * contenteditable entfernen würde. */
  function injectMarkers(html) {
    // Leere Anker aus dem Parser (Überschriften-Sprungmarken) sind im Editor
    // nur störend - die Gliederung kommt aus der Quelle (outline()).
    html = html.replace(/<a\b[^>]*class="[^"]*\banchor\b[^"]*"[^>]*>\s*<\/a>/g, '');
    html = html.replace(/<a\b[^>]*aria-hidden="true"[^>]*>\s*<\/a>/g, '');

    var parts = html.split(/(<pre>[\s\S]*?<\/pre>)/g);
    html = parts.map(function (seg, i) {
      if (i % 2 === 1) return seg; // Codeblock: Marker stehen schon drin
      var M = markerSpan;
      seg = seg.replace(/<h([1-6])>/g, function (_m, lvl) {
        return '<h' + lvl + '>' + M(new Array(parseInt(lvl, 10) + 1).join('#') + ' ');
      });
      seg = seg.replace(/<h([1-6])([^>]*)>([\s\S]*?)<\/h\1>/g, function (m, lvl, attrs, inner) {
        var text = stripMd(inner.replace(/<[^>]*>/g, ''));
        var id = 'h-' + slugify(text);
        if (new RegExp('\\sid="').test(attrs)) return m;
        return '<h' + lvl + ' id="' + id + '"' + attrs + '>' + inner + '</h' + lvl + '>';
      });
      seg = seg.replace(/<b>|<strong>/g, function (t) { return M('**') + t; })
        .replace(/<\/b>|<\/strong>/g, function (t) { return t + M('**'); })
        .replace(/<em>|<i>/g, function (t) { return M('*') + t; })
        .replace(/<\/em>|<\/i>/g, function (t) { return t + M('*'); })
        .replace(/<del>|<s>|<strike>/g, function (t) { return M('~~') + t; })
        .replace(/<\/del>|<\/s>|<\/strike>/g, function (t) { return t + M('~~'); })
        .replace(/<mark>/g, function (t) { return M('==') + t; })
        .replace(/<\/mark>/g, function (t) { return t + M('=='); })
        .replace(/<code>/g, function (t) { return M('`') + t; })
        .replace(/<\/code>/g, function (t) { return t + M('`'); })
        .replace(/<blockquote>/g, function (t) { return t + M('&gt; '); })
        .replace(/<hr>/g, function (t) { return t + M('---'); })
        // Aufgaben-Kästchen: der Sanitizer sperrt alle Checkboxen, im Editor
        // sollen sie klickbar sein (der Controller zykliert den Zustand, der
        // Serializer schreibt [ ] / [x] / [/]).
        .replace(/<input\b([^>]*)>/g, function (m, attrs) {
          if (!/type="checkbox"/.test(attrs)) return m;
          return '<input' + attrs.replace(/\s*disabled(="[^"]*")?/g, '') + ' class="md-check" contenteditable="false">';
        });
      seg = seg.replace(/<a class="wikilink"([^>]*)>/g, function (t) { return M('[[') + t; })
        // </a> der Wikilinks gezielt schliessen: der Marker gehoert danach.
        .replace(/(<a class="wikilink"[^>]*>[\s\S]*?<\/a>)/g, function (m) { return m + M(']]'); });
      return seg;
    }).join('');
    return html;
  }

  function editableSpans(html) {
    // Marker und Kommentare duerfen nicht beschrieben werden.
    return html
      .replace(/<span class="md-marker">/g, '<span class="md-marker" contenteditable="false">')
      .replace(/<span class="md-comment">/g, '<span class="md-comment" contenteditable="false">');
  }

  /* ---------- Stufe 4: Sanitizer ---------- */
  function defaultSanitize(html) {
    if (typeof GrimoireSanitize !== 'undefined' && GrimoireSanitize.sanitizeHtml) {
      return GrimoireSanitize.sanitizeHtml(html);
    }
    if (typeof window !== 'undefined' && window.GrimoireSanitize && window.GrimoireSanitize.sanitizeHtml) {
      return window.GrimoireSanitize.sanitizeHtml(html);
    }
    // Ohne Sanitizer (z. B. Node ohne js/sanitize.js) wird alles escaped:
    // lieber Quelltext anzeigen als rohes HTML ausliefern.
    return html;
  }

  function harden(html) {
    return html.replace(/&(?!(?:[a-zA-Z][a-zA-Z0-9]*|#\d+|#x[0-9a-fA-F]+);)/g, '&amp;')
      .replace(/</g, '&lt;').replace(/>/g, '&gt;');
  }

  /* ---------- Stufe 5: oeffentliche Render-API ---------- */
  function render(src, opts) {
    opts = opts || {};
    var editable = opts.editable !== false;
    var sanitize = typeof opts.sanitize === 'function' ? opts.sanitize : defaultSanitize;
    var text = String(src == null ? '' : src).replace(/\r\n?/g, '\n');
    var blocks = [];
    var prepared = ofmPrepare(text, blocks);
    var html = parse(prepared, blocks);
    if (html == null) html = '<p>' + esc(text) + '</p>'; // WASM nicht bereit
    html = restoreCode(html, blocks, editable);
    html = callouts(html);
    if (sanitize) {
      try { html = sanitize(html); } catch (e) { html = harden(html); }
    } else {
      html = harden(html);
    }
    if (editable) html = editableSpans(injectMarkers(html));
    return html;
  }

  /* ---------- Stufe 6: HTML -> Markdown ---------- */
  var VOID = { br: 1, hr: 1, img: 1, input: 1, meta: 1, link: 1, wbr: 1, col: 1, area: 1, base: 1, source: 1, track: 1, embed: 1 };

  function parseAttrs(s) {
    var attrs = {};
    var re = /([a-zA-Z_:][-a-zA-Z0-9_:.]*)\s*(?:=\s*("([^"]*)"|'([^']*)'|([^\s"'>]+)))?/g;
    var m;
    while ((m = re.exec(String(s || '')))) {
      var name = m[1].toLowerCase();
      attrs[name] = m[3] != null ? m[3] : (m[4] != null ? m[4] : (m[5] != null ? m[5] : ''));
    }
    return attrs;
  }

  function cls(attrs) {
    return String((attrs && attrs.class) || '').split(/\s+/).filter(Boolean);
  }

  function hasClass(attrs, name) {
    return cls(attrs).indexOf(name) >= 0;
  }

  /* Passende Gegenstelle eines Tags suchen (nur gleiche Tags zaehlen - das
   * HTML aus dem Parser ist verschachtelt, aber sauber). */
  function findClosing(html, from, tag) {
    var re = new RegExp('<(/?)' + tag + '(?=[\\s/>])', 'gi');
    re.lastIndex = from;
    var depth = 1, m;
    while ((m = re.exec(html))) {
      if (m[1] === '/') {
        depth--;
        if (depth === 0) {
          var gt = html.indexOf('>', m.index);
          return { start: m.index, end: gt < 0 ? html.length : gt + 1 };
        }
      } else {
        var gt2 = html.indexOf('>', m.index);
        if (gt2 > 0 && html.charAt(gt2 - 1) === '/') continue; // selbst schliessend
        depth++;
      }
    }
    return null;
  }

  function splitNodes(html) {
    var out = [], i = 0;
    var src = String(html == null ? '' : html);
    while (i < src.length) {
      if (src.charAt(i) !== '<') {
        var j = src.indexOf('<', i);
        if (j < 0) j = src.length;
        if (j > i) out.push({ text: src.slice(i, j) });
        i = j;
        continue;
      }
      var m = /^<([a-zA-Z][a-zA-Z0-9:-]*)((?:"[^"]*"|'[^']*'|[^>])*?)\/?>/.exec(src.slice(i));
      if (!m) { out.push({ text: '<' }); i++; continue; }
      var tag = m[1].toLowerCase();
      var attrs = parseAttrs(m[2]);
      var selfClosing = /\/\s*>$/.test(m[0]);
      if (selfClosing || VOID[tag]) {
        out.push({ tag: tag, attrs: attrs });
        i += m[0].length;
        continue;
      }
      var close = findClosing(src, i + m[0].length, tag);
      if (!close) { out.push({ text: src.slice(i) }); break; }
      out.push({ tag: tag, attrs: attrs, inner: src.slice(i + m[0].length, close.start), raw: src.slice(i, close.end) });
      i = close.end;
    }
    return out;
  }

  function escapeMd(s, lineStart) {
    var out = String(s == null ? '' : s);
    /* Reihenfolge: erst die Sonderzeichen, danach die Blockanfangs-Marker.
     * Umgekehrt wuerde der eingesetzte Backslash noch einmal escaped und aus
     * "\- beginnt" wuerde "\\- beginnt". */
    out = out.replace(/[\\`*_~[\]<>]|!(?=\[)/g, function (m) { return '\\' + m; });
    out = out.replace(/%(?=%)/g, '\\%');
    if (lineStart) out = out.replace(/^([ \t]*)(#{1,6}|>|[-+*]|\d{1,9}[.)])([ \t])/, '$1\\$2$3');
    return out;
  }

  function inlineCode(text) {
    var runs = String(text).match(/`+/g) || [''];
    var max = 1;
    runs.forEach(function (r) { if (r.length > max) max = r.length; });
    var fence = new Array(max + 1).join('`');
    var body = String(text);
    /* Nur Backticks am Rand brauchen die Polsterung - Leerzeichen am Rand
     * wuerden sonst beim erneuten Rendern mitverschoben. */
    if (/^`|`$/.test(body)) body = ' ' + body + ' ';
    return fence + body + fence;
  }

  function linkMd(node) {
    var attrs = node.attrs || {};
    var href = decodeEntities(String(attrs.href || ''));
    var inner = inlineMd(splitNodes(node.inner));
    if (href.indexOf(WL_PREFIX) === 0) {
      var target = href.slice(WL_PREFIX.length);
      if (hasClass(attrs, 'md-embed')) return '![[' + target + ']]';
      return '[[' + target + ((inner && inner !== target) ? '|' + inner : '') + ']]';
    }
    if (!href) return inner;
    if (!inner || inner === href) return '<' + href + '>';
    return '[' + inner + '](' + href + ')';
  }

  function imgMd(node) {
    var attrs = node.attrs || {};
    var src = decodeEntities(String(attrs.src || ''));
    var alt = decodeEntities(String(attrs.alt || ''));
    if (!src) return alt;
    if (hasClass(attrs, 'md-embed')) {
      var w = String(attrs.width || '').trim();
      return '![[' + src + (/^\d{1,4}$/.test(w) ? '|' + w : '') + ']]';
    }
    return '![' + alt + '](' + src + ')';
  }

  function inlineMd(nodes) {
    var out = '';
    var lineStart = true;
    for (var i = 0; i < nodes.length; i++) {
      var nd = nodes[i];
      if (nd.text != null) {
        var t = decodeEntities(nd.text).replace(/\u00a0/g, ' ');
        if (/^\s*$/.test(t)) { if (out && !/\n\s*$/.test(out)) out += ' '; lineStart = false; continue; }
        // Nach <br> bzw. am Blockanfang steht im HTML noch der Zeilenumbruch
        // der Serialisierung - der gehoert nicht in die Markdown-Zeile.
        if (lineStart) t = t.replace(/^[ \t]*\r?\n/, '');
        out += escapeMd(t, lineStart);
        lineStart = /\n\s*$/.test(out);
        continue;
      }
      var tag = nd.tag;
      var inner = nd.inner == null ? '' : nd.inner;
      switch (tag) {
        case 'br': out += '  ' + HARD + '\n'; lineStart = true; break;
        case 'b': case 'strong': out += '**' + inlineMd(splitNodes(inner)) + '**'; lineStart = false; break;
        case 'i': case 'em': out += '*' + inlineMd(splitNodes(inner)) + '*'; lineStart = false; break;
        case 'del': case 's': case 'strike': out += '~~' + inlineMd(splitNodes(inner)) + '~~'; lineStart = false; break;
        case 'mark': out += '==' + inlineMd(splitNodes(inner)) + '=='; lineStart = false; break;
        case 'code': out += inlineCode(decodeEntities(inner).replace(/\u00a0/g, ' ')); lineStart = false; break;
        case 'a': out += linkMd(nd); lineStart = false; break;
        case 'img': out += imgMd(nd); lineStart = false; break;
        case 'input': out += isCheckbox(nd) ? '' : ''; break;
        case 'hr': out += '\n\n---\n\n'; lineStart = true; break;
        case 'span': {
          if (hasClass(nd.attrs, 'md-marker')) break;      // nur Anzeige
          if (hasClass(nd.attrs, 'md-half')) { out += '/'; break; }
          if (hasClass(nd.attrs, 'md-comment')) { out += '%%' + inlineMd(splitNodes(inner)) + '%%'; break; }
          out += inlineMd(splitNodes(inner));
          lineStart = false;
          break;
        }
        case 'font': case 'u': case 'small': case 'big': case 'sub': case 'sup':
          out += inlineMd(splitNodes(inner));
          lineStart = false;
          break;
        default:
          if (nd.inner != null) { out += inlineMd(splitNodes(inner)); lineStart = false; }
          break;
      }
    }
    return out;
  }

  function isCheckbox(node) {
    var a = node.attrs || {};
    return node.tag === 'input' && String(a.type || '').toLowerCase() === 'checkbox';
  }

  function preMd(node) {
    var kids = splitNodes(String(node.inner || ''));
    var codeNode = null;
    for (var i = 0; i < kids.length; i++) if (kids[i].tag === 'code') { codeNode = kids[i]; break; }
    var attrs = codeNode ? codeNode.attrs : {};
    var lang = '';
    cls(attrs).forEach(function (c) { if (c.indexOf('language-') === 0) lang = c.slice(9); });
    if (!lang && attrs['data-lang']) lang = String(attrs['data-lang']).trim();
    var raw = codeNode ? codeNode.inner : String(node.inner || '');
    var code = decodeEntities(String(raw).replace(/<[^>]*>/g, '')).replace(/\n$/, '');
    var fence = '```';
    var runs = code.match(/`{3,}/g);
    if (runs) {
      var max = 3;
      runs.forEach(function (r) { if (r.length + 1 > max) max = r.length + 1; });
      fence = new Array(max).join('`');
    }
    return fence + lang + '\n' + code + '\n' + fence;
  }

  function tableMd(node) {
    var rows = [];
    (function walk(n) {
      var kids = splitNodes(String(n.inner || ''));
      for (var i = 0; i < kids.length; i++) {
        var k = kids[i];
        if (k.tag === 'tr') rows.push(k);
        else if (k.tag === 'thead' || k.tag === 'tbody' || k.tag === 'tfoot' || k.tag === 'table') walk(k);
      }
    })(node);
    if (!rows.length) return '';
    function cellsOf(tr) {
      var cells = [];
      splitNodes(String(tr.inner || '')).forEach(function (k) {
        if (k.tag === 'th' || k.tag === 'td') {
          cells.push(inlineMd(splitNodes(String(k.inner || ''))).replace(/\|/g, '\\|').trim());
        }
      });
      return cells;
    }
    var head = cellsOf(rows[0]);
    if (!head.length) return '';
    var lines = ['| ' + head.join(' | ') + ' |', '| ' + head.map(function () { return '---'; }).join(' | ') + ' |'];
    for (var r = 1; r < rows.length; r++) {
      var cells = cellsOf(rows[r]);
      lines.push('| ' + cells.join(' | ') + ' |');
    }
    return lines.join('\n');
  }

  /* <li> wird aus zwei Teilen gebaut: dem Teil bis zur ersten Unterliste
   * (Text, evtl. mit Aufgabe) und der Unterliste selbst. Die Unterliste wird
   * um die Breite des eigenen Markers eingerückt, damit CommonMark sie wieder
   * als Kinderliste erkennt (2+ Leerzeichen bei "- ", 4+ bei "10. "). */
  function listMd(node, indent) {
    var ordered = node.tag === 'ol';
    var start = parseInt(String((node.attrs || {}).start || '1'), 10);
    if (!isFinite(start)) start = 1;
    var items = splitNodes(String(node.inner || '')).filter(function (k) { return k.tag === 'li'; });
    var pad0 = indent || '';
    var out = [];
    items.forEach(function (li, i) {
      var marker = ordered ? (start + i) + '. ' : '- ';
      var rest = splitNodes(String(li.inner || ''));
      var task = null;
      // Aufgabe: fuehrender Checkbox-Input, optional mit Halb-Marker daneben.
      if (rest.length && isCheckbox(rest[0])) {
        task = ('checked' in (rest[0].attrs || {})) ? 'x' : ' ';
        rest.shift();
      }
      if (rest.length && rest[0].tag === 'span' && hasClass(rest[0].attrs, 'md-half')) {
        task = '/';
        rest.shift();
      }
      var head = [];
      while (rest.length && rest[0].tag !== 'ul' && rest[0].tag !== 'ol') head.push(rest.shift());
      // Einruecken um die Breite des eigenen Markers - auch bei Aufgaben, wo
      // der Prefix "[ ] " mitzaehlt: "- [ ] x" und "  - [ ] y" sind genau die
      // Form, die GitHub/Obsidian auch schreiben (2 Leerzeichen genuegen).
      var pad = pad0 + new Array(marker.length + 1).join(' ');
      var itemMd = (task != null ? '[' + task + '] ' : '') + inlineMd(head);
      var itemLines = itemMd.split('\n').map(function (line, k) {
        if (k === 0) return pad0 + marker + line;
        return line.trim() ? pad + line.trim() : '';
      });
      if (rest.length) {
        var sub = listMd(rest[0], pad);
        if (sub) itemLines.push(sub);
      }
      out.push(itemLines.join('\n'));
    });
    return out.join('\n');
  }

  function calloutMd(node) {
    var type = 'note';
    cls(node.attrs).forEach(function (c) {
      if (c.indexOf('md-callout-') === 0) type = c.slice(11).toLowerCase();
    });
    if (!CALLOUT_TYPES[type]) type = 'note';
    var fold = String((node.attrs || {})['data-fold'] || '');
    var mark = fold === 'closed' ? '-' : (fold === 'open' ? '+' : '');
    var title = '';
    var body = '';
    splitNodes(String(node.inner || '')).forEach(function (k) {
      if (k.tag !== 'div') return;
      if (hasClass(k.attrs, 'md-callout-title')) title = inlineMd(splitNodes(String(k.inner || ''))).trim();
      else if (hasClass(k.attrs, 'md-callout-body')) body = blocksToMd(splitNodes(String(k.inner || '')));
    });
    var out = '> [!' + type + ']' + mark + (title ? ' ' + title : '');
    if (body) {
      out += '\n' + body.split('\n').map(function (l) { return '> ' + l; }).join('\n');
    }
    return out;
  }

  function blockMd(node) {
    var tag = node.tag;
    var inner = node.inner == null ? '' : node.inner;
    if (/^h[1-6]$/.test(tag)) {
      var lvl = parseInt(tag.slice(1), 10);
      var body = inlineMd(splitNodes(inner)).trim();
      return new Array(lvl + 1).join('#') + (body ? ' ' + body : '');
    }
    switch (tag) {
      case 'p': {
        var t = inlineMd(splitNodes(inner)).trim();
        return t || '';
      }
      case 'hr': return '---';
      case 'pre': return preMd(node);
      case 'blockquote': {
        var q = blocksToMd(splitNodes(inner));
        return q ? q.split('\n').map(function (l) { return '> ' + l; }).join('\n') : '';
      }
      case 'ul': case 'ol': return listMd(node, '');
      case 'table': return tableMd(node);
      case 'li': return inlineMd(splitNodes(inner)).trim();
      case 'div': case 'section': case 'article':
        if (hasClass(node.attrs, 'md-callout')) return calloutMd(node);
        return blocksToMd(splitNodes(inner));
      default:
        return inlineMd(splitNodes(inner)).trim();
    }
  }

  function joinBlocks(list) {
    var out = [];
    list.forEach(function (b) {
      if (b == null) return;
      var s = String(b).replace(/[ \t]+$/gm, '').trim();
      if (s) out.push(s);
    });
    return out.join('\n\n').replace(/\n{3,}/g, '\n\n');
  }

  function blocksToMd(nodes) {
    var out = [];
    nodes.forEach(function (nd) {
      if (nd.text != null) {
        if (/^\s*$/.test(nd.text)) return;
        var t = inlineMd([nd]).trim();
        if (t) out.push(t);
        return;
      }
      var md = blockMd(nd);
      if (md) out.push(md);
    });
    return joinBlocks(out);
  }

  /* Was der Browser aus contenteditable macht, auf das erwartete Format
   * bringen: Marker weg, Inline-Styles weg, <div>/<b>/<i> sind erlaubt. */
  function normalizeBrowserHtml(html) {
    return String(html == null ? '' : html)
      .replace(/<span class="md-marker"[^>]*>[\s\S]*?<\/span>/g, '')
      .replace(/\s(?:style|dir|lang|title)="[^"]*"/g, '')
      .replace(/<(script|style)\b[\s\S]*?<\/\1>/gi, '')
      .replace(/<br\s*\/?>/gi, '<br>');
  }

  function serialize(html) {
    return blocksToMd(splitNodes(normalizeBrowserHtml(html))).split(HARD).join('');
  }

  /* ---------- Gliederung und Kennzahlen ---------- */
  function outline(src) {
    var out = [];
    var fence = null;
    String(src == null ? '' : src).split('\n').forEach(function (line) {
      var f = /^\s*(`{3,}|~{3,})/.exec(line);
      if (f) { fence = fence ? null : f[1]; return; }
      if (fence) return;
      var m = /^(#{1,6})\s+(.*?)\s*$/.exec(line);
      if (!m) return;
      var text = stripMd(m[2]);
      out.push({ level: m[1].length, text: text, id: 'h-' + slugify(text) });
    });
    return out;
  }

  function stats(src) {
    var text = String(src == null ? '' : src);
    var plain = text
      .replace(/```[\s\S]*?```/g, ' ')
      .replace(/`[^`\n]*`/g, ' ')
      .replace(/!?\[\[[^\]\n]*\]\]/g, ' ')
      .replace(/!?\[[^\]\n]*\]\([^)]*\)/g, ' ')
      .replace(/^\s{0,3}#{1,6}\s+/gm, '')
      .replace(/^\s{0,3}>\s?/gm, '')
      .replace(/^\s*[-*+]\s+/gm, '')
      .replace(/^\s*\d{1,9}[.)]\s+/gm, '')
      .replace(/^\s*\|.*\|\s*$/gm, ' ')
      .replace(/[*_~=`|]/g, ' ');
    var words = (plain.match(/[^\s]+/g) || []).length;
    var chars = text.length;
    return {
      words: words,
      chars: chars,
      charsNoSpace: text.replace(/\s/g, '').length,
      lines: text ? text.split('\n').length : 0,
      minutes: Math.max(1, Math.round(words / 200)),
      headings: outline(text).length
    };
  }

  function titleFromSource(src) {
    var heads = outline(src);
    if (heads.length) return heads[0].text.slice(0, 80);
    var line = String(src == null ? '' : src).split('\n').filter(function (l) { return l.trim(); })[0] || '';
    return stripMd(line).slice(0, 80) || 'Ohne Titel';
  }

  return {
    ready: ready,
    available: available,
    render: render,
    serialize: serialize,
    outline: outline,
    stats: stats,
    titleFromSource: titleFromSource,
    slugify: slugify,
    stripMd: stripMd,
    flags: FLAGS,
    calloutTypes: Object.keys(CALLOUT_TYPES),
    _internals: {
      escapeMd: escapeMd,
      inlineCode: inlineCode,
      splitNodes: splitNodes,
      decodeEntities: decodeEntities,
      ofmPrepare: ofmPrepare,
      injectMarkers: injectMarkers,
      callouts: callouts,
      normalizeBrowserHtml: normalizeBrowserHtml,
      _setEngine: function (e) { engine = e; }
    }
  };
})();

/* Im Browser lädt die Seite js/vendor/markdown.js selbst (UMD, hängt sich an
 * window.markdown). In Node zieht das Modul den vendored Build per require()
 * nach - ohne node_modules, damit `npm test` ohne Installation durchläuft. */
if (typeof window !== 'undefined') window.FederwerkMarkdown = FederwerkMarkdown;
if (typeof module !== 'undefined' && module.exports) module.exports = FederwerkMarkdown;