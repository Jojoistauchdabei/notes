/* Federwerk Markdown light – OFM-Subset ohne Dependencies, ohne Build.
 *
 * - Reine Funktionen, bewusst ohne Browser-APIs: per <script> im Browser
 *   (global GrimoireMarkdown) und per require() in Node-Tests ladbar.
 * - mdToHtml: Markdown-Quelle -> HTML-Vorschau (h1-h3, bold, italic, strike,
 *   ul/ol, Links/Autolinks, Code, ==highlight==, %%Kommentar%% (unsichtbar),
 *   [[Wikilinks]] (als Text erhalten), Tasks "- [ ]", Callouts "> [!note]").
 * - htmlToMd: Editor-HTML (contenteditable) -> Markdown-Quelle.
 * - isMarkdown: Heuristik, ob ein String Markdown-Quelle ist (HTML -> false,
 *   damit alte HTML-Textboxen unverändert laden und nur beim Toggle
 *   konvertiert wird).
 * - Kein Eval, kein CDN, kein Crash bei kaputter Syntax (Plain-Text-Fallback).
 */
var GrimoireMarkdown = (function () {
  'use strict';

  var CALLOUT_TYPES = ['note', 'tip', 'warning', 'caution', 'danger', 'info', 'example', 'quote'];
  var PH = '\uE000'; // Platzhalter (Private Use U+E000), ueberlebt HTML-Escaping

  function escapeHtml(s) {
    return String(s)
      .replace(/&/g, '&amp;')
      .replace(/</g, '&lt;')
      .replace(/>/g, '&gt;')
      .replace(/"/g, '&quot;');
  }

  function decodeEntities(s) {
    return String(s)
      .replace(/&lt;/g, '<')
      .replace(/&gt;/g, '>')
      .replace(/&quot;/g, '"')
      .replace(/&#39;/g, "'")
      .replace(/&#x27;/gi, "'")
      .replace(/&amp;/g, '&'); // absichtlich zuletzt (kein Doppel-Dekodieren)
  }

  function stripTags(s) {
    return String(s).replace(/<[^>]*>/g, '');
  }

  function safeUrl(value, allowDataImage) {
    var raw = String(value == null ? '' : value);
    if (!raw) return '';
    var probe = raw.replace(new RegExp('[\\u0000-\\u0020\\u007f\\u00a0]', 'g'), '');
    if (probe.charAt(0) === '#') return raw;
    var m = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
    if (!m) return raw;
    var scheme = m[1].toLowerCase();
    if (/^(?:https?|mailto|tel|blob|ftp)$/.test(scheme)) return raw;
    if (allowDataImage && /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)[;,]/i.test(probe)) return raw;
    return '';
  }

  /* ---------- inline: Markdown -> HTML (Eingabe bereits escaped) ---------- */
  function inlineMd(s) {
    var t = String(s);
    // Bilder vor Links (Bild-Syntax enthaelt Link-ahnlichen Teil)
    t = t.replace(/!\[([^\]\n]*?)\]\(([^)\s]+?)(?:\s+&quot;.*?&quot;)?\)/g, function (m, alt, url) {
      return safeUrl(url, true) ? '<img src="' + url + '" alt="' + alt + '">' : alt;
    });
    t = t.replace(/\[([^\]\n]+?)\]\(([^)\s]+?)(?:\s+&quot;.*?&quot;)?\)/g, function (m, label, url) {
      return safeUrl(url, false) ? '<a href="' + url + '">' + label + '</a>' : label;
    });    t = t.replace(/==([^=\n]+?)==/g, '<mark>$1</mark>');
    t = t.replace(/~~([^~\n]+?)~~/g, '<del>$1</del>');
    t = t.replace(/\*\*([^*\n]+?)\*\*/g, '<strong>$1</strong>');
    t = t.replace(/__([^_\n]+?)__/g, '<strong>$1</strong>');
    t = t.replace(/(^|[^*\w])\*([^*\n]+?)\*(?![*\w])/g, '$1<em>$2</em>');
    t = t.replace(/(^|[^\w])_([^_\n]+?)_(?!\w)/g, '$1<em>$2</em>');
    // Wikilinks bleiben als Text erhalten (nur lesbar markiert)
    t = t.replace(/\[\[([^\[\]\n]+?)\]\]/g, '<span class="wikilink">[[$1]]</span>');
    // Autolinks (GFM light); Satzzeichen am Ende gehoert nicht zur URL
    t = t.replace(/(^|\s)(https?:\/\/[^\s<]+)/g, function (m, pre, url) {
      var trail = '';
      var mm = url.match(/[.,;:!?)]+$/);
      if (mm) { trail = mm[0]; url = url.slice(0, -trail.length); }
      if (!url) return m;
      return pre + '<a href="' + url + '">' + url + '</a>' + trail;
    });
    return t;
  }

  function renderQuote(lines) {
    var first = lines[0].match(/^\[!([\w-]+)\]([-+]?)\s?(.*)$/);
    if (!first) {
      return '<blockquote>' + lines.map(function (l) { return inlineMd(l.trim()); }).join('<br>') + '</blockquote>';
    }
    var type = first[1].toLowerCase();
    if (CALLOUT_TYPES.indexOf(type) === -1) type = 'note'; // unbekannt -> note
    var fold = first[2] === '-' ? ' data-fold="closed"' : (first[2] === '+' ? ' data-fold="open"' : '');
    var title = first[3] ? inlineMd(first[3].trim()) : escapeHtml(type);
    var out = '<div class="callout callout-' + type + '"' + fold + '>' +
      '<div class="callout-title">' + title + '</div>';
    var body = lines.slice(1);
    if (body.length) {
      out += '<div class="callout-body">' +
        body.map(function (l) { return inlineMd(l.trim()); }).join('<br>') + '</div>';
    }
    return out + '</div>';
  }

  function isBlockStart(line) {
    return /^\s*&gt;/.test(line) ||
      /^#{1,3}\s+\S/.test(line) ||
      /^\s*(---|\*\*\*|___)\s*$/.test(line) ||
      /^\s*[*+-]\s+/.test(line) ||
      /^\s*\d+[.)]\s+/.test(line) ||
      new RegExp('^\\s*' + PH + 'CB\\d+' + PH + '\\s*$').test(line);
  }

  /* ---------- mdToHtml ---------- */
  function mdToHtml(src) {
    if (src == null) return '';
    var text = String(src).replace(/\r\n?/g, '\n');
    // 1. Codebloecke sichern (Inhalt wird spaeter escaped zurueckgelegt)
    var codeBlocks = [];
    text = text.replace(/```(\w*)\n?([\s\S]*?)(?:```|$)/g, function (m, lang, code) {
      codeBlocks.push({ lang: lang || '', code: code.replace(/\n$/, '') });
      return PH + 'CB' + (codeBlocks.length - 1) + PH;
    });
    // 2. Inline-Code sichern
    var codeSpans = [];
    text = text.replace(/`([^`\n]+?)`/g, function (m, code) {
      codeSpans.push(code);
      return PH + 'CS' + (codeSpans.length - 1) + PH;
    });
    // 3. Kommentare werden nicht gerendert (ungeoeffnete bleiben Text)
    text = text.replace(/%%[\s\S]*?%%/g, '');
    // 4. Rest escapen (Platzhalter ueberleben das Escaping)
    text = escapeHtml(text);
    // 5. Bloecke
    var lines = text.split('\n');
    var html = [];
    var i = 0;
    while (i < lines.length) {
      var line = lines[i];
      if (/^\s*$/.test(line)) { i++; continue; }
      var cbm = line.match(new RegExp('^\\s*' + PH + 'CB(\\d+)' + PH + '\\s*$'));
      if (cbm) {
        var cb = codeBlocks[parseInt(cbm[1], 10)] || { lang: '', code: '' };
        html.push('<pre><code' + (cb.lang ? ' data-lang="' + cb.lang + '"' : '') + '>' +
          escapeHtml(cb.code) + '</code></pre>');
        i++;
        continue;
      }
      if (/^\s*&gt;/.test(line)) {
        var q = [];
        while (i < lines.length && /^\s*&gt;/.test(lines[i])) {
          q.push(lines[i].replace(/^\s*&gt; ?/, ''));
          i++;
        }
        html.push(renderQuote(q));
        continue;
      }
      var hm = line.match(/^(#{1,3})\s+(.*)$/);
      if (hm) {
        var lvl = hm[1].length;
        html.push('<h' + lvl + '>' + inlineMd(hm[2].trim()) + '</h' + lvl + '>');
        i++;
        continue;
      }
      if (/^\s*(---|\*\*\*|___)\s*$/.test(line)) { html.push('<hr>'); i++; continue; }
      if (/^\s*[*+-]\s+/.test(line)) {
        var items = [];
        var hasTask = false;
        while (i < lines.length && /^\s*[*+-]\s+/.test(lines[i])) {
          var um = lines[i].match(/^\s*[*+-]\s+(.*)$/);
          var content = um ? um[1] : '';
          var tm = content.match(/^\[([ xX\/])\]\s*(.*)$/);
          if (tm) { hasTask = true; items.push({ task: true, marker: tm[1], text: tm[2] }); }
          else items.push({ task: false, text: content });
          i++;
        }
        var uo = hasTask ? '<ul class="task-list">' : '<ul>';
        items.forEach(function (it) {
          if (it.task) {
            var mk = it.marker === '/' ? '/' : (String(it.marker).toLowerCase() === 'x' ? 'x' : ' ');
            uo += '<li class="task-list-item"><input type="checkbox" disabled data-marker="' + mk + '"' +
              (mk === 'x' ? ' checked' : '') + '> ' + inlineMd(it.text) + '</li>';
          } else {
            uo += '<li>' + inlineMd(it.text) + '</li>';
          }
        });
        html.push(uo + '</ul>');
        continue;
      }
      if (/^\s*\d+[.)]\s+/.test(line)) {
        var ol = [];
        while (i < lines.length && /^\s*\d+[.)]\s+/.test(lines[i])) {
          ol.push(lines[i].replace(/^\s*\d+[.)]\s+/, ''));
          i++;
        }
        html.push('<ol>' + ol.map(function (t) { return '<li>' + inlineMd(t) + '</li>'; }).join('') + '</ol>');
        continue;
      }
      var para = [line];
      i++;
      while (i < lines.length && !/^\s*$/.test(lines[i]) && !isBlockStart(lines[i])) {
        para.push(lines[i]);
        i++;
      }
      html.push('<p>' + para.map(function (l) { return inlineMd(l.trim()); }).join('<br>') + '</p>');
    }
    var out = html.join('\n');
    // 6. Code zuruecklegen (escaped)
    out = out.replace(new RegExp(PH + 'CS(\\d+)' + PH, 'g'), function (m, n) {
      return '<code>' + escapeHtml(codeSpans[parseInt(n, 10)] || '') + '</code>';
    });
    return out;
  }

  /* ---------- inline: HTML -> Markdown ---------- */
  function inlineHtmlToMd(s, keepEntities) {
    var t = String(s);
    t = t.replace(/<br\s*\/?>/gi, '\n');
    t = t.replace(/<img[^>]*>/gi, function (im) {
      var src = (im.match(/src="([^"]*)"/i) || [])[1] || '';
      var alt = (im.match(/alt="([^"]*)"/i) || [])[1] || '';
      if (!src) return alt;
      return '![' + alt + '](' + src + ')';
    });
    t = t.replace(/<a[^>]*href="([^"]*)"[^>]*>([\s\S]*?)<\/a>/gi, function (m, href, inner) {
      var txt = stripTags(inner).trim();
      if (!txt || txt === href) return href; // Autolink bleibt nackte URL
      return '[' + txt + '](' + href + ')';
    });
    t = t.replace(/<(strong|b)[^>]*>([\s\S]*?)<\/\1>/gi, '**$2**');
    t = t.replace(/<(em|i)[^>]*>([\s\S]*?)<\/\1>/gi, '*$2*');
    t = t.replace(/<(del|s|strike)[^>]*>([\s\S]*?)<\/\1>/gi, '~~$2~~');
    t = t.replace(/<mark[^>]*>([\s\S]*?)<\/mark>/gi, '==$1==');
    t = t.replace(/<(code|tt)[^>]*>([\s\S]*?)<\/(code|tt)>/gi, function (m, o, inner) {
      return '`' + stripTags(inner) + '`';
    });
    t = t.replace(/<input[^>]*type="checkbox"[^>]*>/gi, function (im) {
      var dmm = im.match(/data-marker="([ xX\/])"/);
      var mk = dmm ? dmm[1].toLowerCase() : (/checked/i.test(im) ? 'x' : ' ');
      if (mk === 'X') mk = 'x';
      return '[' + mk + '] ';
    });
    // Wikilink-Spans -> reiner [[...]]-Text; sonstige Spans/Fonts/Unterstrichen -> Inhalt
    t = t.replace(/<span[^>]*class="[^"]*wikilink[^"]*"[^>]*>([\s\S]*?)<\/span>/gi, '$1');
    t = t.replace(/<(span|font|u)[^>]*>([\s\S]*?)<\/\1>/gi, '$2');
    t = stripTags(t);
    if (!keepEntities) t = decodeEntities(t);
    return t;
  }

  function checkboxMarker(inputHtml) {
    var dmm = String(inputHtml).match(/data-marker="([ xX\/])"/);
    var mk = dmm ? dmm[1].toLowerCase() : (/checked/i.test(String(inputHtml)) ? 'x' : ' ');
    return mk === 'X' ? 'x' : mk;
  }

  /* ---------- htmlToMd ---------- */
  function htmlToMd(html) {
    if (html == null) return '';
    var text = String(html).replace(/\r\n?/g, '\n');
    // 1. <pre>-Bloecke sichern
    var pres = [];
    text = text.replace(/<pre[^>]*>([\s\S]*?)<\/pre>/gi, function (m, inner) {
      pres.push(decodeEntities(stripTags(inner)).replace(/^\n+|\n+$/g, ''));
      return '\n\n' + PH + 'PRE' + (pres.length - 1) + PH + '\n\n';
    });
    // 2. Callouts -> "> [!typ]- Titel" + "> Body" (Faltung aus data-fold)
    text = text.replace(/<div[^>]*callout-([\w-]+)[^>]*>\s*<div[^>]*callout-title[^>]*>([\s\S]*?)<\/div>\s*(?:<div[^>]*callout-body[^>]*>([\s\S]*?)<\/div>)?\s*<\/div>/gi,
      function (m, type, title, body) {
        type = String(type).toLowerCase();
        if (CALLOUT_TYPES.indexOf(type) === -1) type = 'note';
        var foldTag = m.match(/data-fold="([^"]*)"/);
        var fold = foldTag && foldTag[1] === 'closed' ? '-' : (foldTag && foldTag[1] === 'open' ? '+' : '');
        var t = inlineHtmlToMd(title, true).trim();
        var out = '> [!' + type + ']' + fold + (t ? ' ' + t : '');
        if (body != null) {
          inlineHtmlToMd(body, true).split('\n').forEach(function (l) {
            out += '\n> ' + l.trim();
          });
        }
        return '\n\n' + out + '\n\n';
      });
    // 3. Ueberschriften (h4-h6 fallen auf h3 zurueck: light-Subset)
    text = text.replace(/<h([1-6])[^>]*>([\s\S]*?)<\/h\1>/gi, function (m, lvl, inner) {
      var n = Math.min(parseInt(lvl, 10), 3);
      var hashes = n === 1 ? '#' : (n === 2 ? '##' : '###');
      return '\n\n' + hashes + ' ' + inlineHtmlToMd(inner, true).trim() + '\n\n';
    });
    text = text.replace(/<hr[^>]*>/gi, '\n\n---\n\n');
    // 4. Listen (innerste zuerst, damit Einrueckungen nicht crashen, sondern flach fallen)
    var prev;
    do {
      prev = text;
      text = text.replace(/<(ul|ol)[^>]*>((?:(?!<(?:ul|ol)[\s>])[\s\S])*?)<\/\1>/gi, function (m, tag, inner) {
        var n = 0;
        var items = [];
        inner.replace(/<li[^>]*>([\s\S]*?)<\/li>/gi, function (lm, lic) {
          n++;
          var marker = null;
          lic = lic.replace(/<input[^>]*type="checkbox"[^>]*>/gi, function (im) {
            marker = checkboxMarker(im);
            return '';
          });
          var t = inlineHtmlToMd(lic, true).trim();
          if (String(tag).toLowerCase() === 'ol') items.push(n + '. ' + t);
          else if (marker !== null) items.push('- [' + marker + '] ' + t);
          else items.push('- ' + t);
          return '';
        });
        return '\n\n' + items.join('\n') + '\n\n';
      });
    } while (text !== prev);
    text = text.replace(/<\/?(li|ul|ol)[^>]*>/gi, '\n');
    // 5. Block-Tags -> Absatzbruch, Tabellen minimal (Zeile/Spalte)
    text = text.replace(/<\/?(p|div|blockquote|section|article|header|footer|tr|table|tbody|thead)[^>]*>/gi, '\n\n');
    text = text.replace(/<\/?(td|th)[^>]*>/gi, ' ');
    // 6. Inline-Rest
    text = inlineHtmlToMd(text, false);
    // 7. <pre>-Platzhalter als Fences zuruecklegen
    text = text.replace(new RegExp('^\\s*' + PH + 'PRE(\\d+)' + PH + '\\s*$', 'gm'), function (m, n) {
      return '```\n' + (pres[parseInt(n, 10)] || '') + '\n```';
    });
    // 8. Aufraeumen
    var cleaned = text.split('\n').map(function (l) { return l.replace(/[ \t]+$/g, ''); });
    return cleaned.join('\n').replace(/\n{3,}/g, '\n\n').replace(/^\n+|\n+$/g, '');
  }

  /* ---------- isMarkdown ---------- */
  var MD_PATTERNS = [
    /^#{1,3}\s+\S/m,
    /\*\*[^*\n]+\*\*/,
    /(^|[^\w*])\*[^*\n]+\*([^\w*]|$)/,
    /__[^_\n]+__/,
    /(^|[^\w])_[^_\n]+_([^\w]|$)/,
    /~~[^~\n]+~~/,
    /==[^=\n]+==/,
    /`[^`\n]+`/,
    /```/,
    /^\s*[-*+]\s+\[[ xX\/]\]/m,
    /^\s*([-*+]\s+|\d+[.)]\s+)\S/m,
    /\[[^\]\n]+\]\([^)\s]+\)/,
    /\[\[[^\[\]\n]+\]\]/,
    /^>\s*\[!/m,
    /^>/m,
    /%%[^%]+%%/,
    /^\s*---\s*$/m
  ];

  function isMarkdown(src) {
    if (src == null) return false;
    var t = String(src);
    if (!t.trim()) return false;
    // Gerendertes/gespeichertes Editor-HTML ist kein Markdown (alte Boxen laden unveraendert).
    if (/<\/(p|div|h[1-6]|ul|ol|li|table|blockquote)>/i.test(t)) return false;
    for (var k = 0; k < MD_PATTERNS.length; k++) {
      if (MD_PATTERNS[k].test(t)) return true;
    }
    return false;
  }

  return {
    mdToHtml: mdToHtml,
    htmlToMd: htmlToMd,
    markdownToHtml: mdToHtml,
    htmlToMarkdown: htmlToMd,
    isMarkdown: isMarkdown
  };
})();
if (typeof module !== 'undefined' && module.exports) module.exports = GrimoireMarkdown;
