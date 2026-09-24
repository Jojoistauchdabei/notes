var GrimoireSanitize = (function () {
  'use strict';

  var TAGS = {
    a: 1, b: 1, big: 1, blockquote: 1, br: 1, code: 1, del: 1, details: 1, div: 1,
    em: 1, font: 1, h1: 1, h2: 1, h3: 1, h4: 1, h5: 1, h6: 1, hr: 1, i: 1,
    img: 1, input: 1, ins: 1, li: 1, mark: 1, ol: 1, p: 1, pre: 1, s: 1,
    small: 1, span: 1, strike: 1, strong: 1, sub: 1, summary: 1, sup: 1,
    table: 1, tbody: 1, td: 1, tfoot: 1, th: 1, thead: 1, tr: 1, u: 1, ul: 1
  };

  var DROP_TAGS = {
    script: 1, style: 1, iframe: 1, frame: 1, frameset: 1, object: 1, embed: 1,
    applet: 1, link: 1, meta: 1, base: 1, form: 1, svg: 1, math: 1, template: 1,
    noscript: 1, title: 1, head: 1, html: 1, body: 1, portal: 1, audio: 1,
    video: 1, source: 1, track: 1, canvas: 1, marquee: 1, dialog: 1, slot: 1
  };

  var GLOBAL_ATTRS = {
    class: 1, title: 1, style: 1, dir: 1, lang: 1,
    'data-fold': 1, 'data-marker': 1, 'data-lang': 1
  };

  var TAG_ATTRS = {
    a: { href: 1, target: 1, rel: 1 },
    img: { src: 1, alt: 1, width: 1, height: 1, loading: 1 },
    input: { type: 1, checked: 1, disabled: 1 },
    font: { color: 1, face: 1, size: 1 },
    td: { colspan: 1, rowspan: 1 },
    th: { colspan: 1, rowspan: 1 },
    ol: { start: 1, type: 1 },
    li: { value: 1 }
  };

  var URL_ATTRS = { href: 1, src: 1 };
  var NUM_ATTRS = { width: 1, height: 1, colspan: 1, rowspan: 1, start: 1, value: 1, size: 1 };

  var STYLE_PROPS = {
    color: 1, 'background-color': 1, 'font-size': 1, 'font-family': 1,
    'font-style': 1, 'font-weight': 1, 'text-align': 1, 'text-decoration': 1,
    'text-decoration-line': 1, 'line-height': 1, 'margin-left': 1,
    'margin-right': 1, 'text-indent': 1, 'letter-spacing': 1
  };

  var SCHEMES = /^(?:https?|mailto|tel|blob|ftp)$/i;
  var DATA_IMAGE = /^data:image\/(?:png|jpe?g|gif|webp|avif|bmp|x-icon)[;,]/i;
  var CONTROL = new RegExp('[\\u0000-\\u0020\\u007f\\u00a0\\u2028\\u2029\\ufeff]', 'g');
  var UNSAFE_CHARS = new RegExp('[\\u0000-\\u0008\\u000b\\u000c\\u000e-\\u001f\\u007f]', 'g');
  var CLASS_OK = /^[A-Za-z0-9_ -]+$/;
  var STYLE_VALUE_OK = /^[A-Za-z0-9#%.,()'" -]+$/;
  var STYLE_VALUE_BAD = /(?:url\(|expression\(|javascript:|@import|\\)/i;

  function isAllowedTag(name) { return !!TAGS[String(name || '').toLowerCase()]; }
  function isDropTag(name) { return !!DROP_TAGS[String(name || '').toLowerCase()]; }

  function isAllowedAttr(tag, name) {
    var n = String(name || '').toLowerCase();
    if (n.slice(0, 2) === 'on') return false;
    if (n.slice(0, 5) === 'data-') return !!GLOBAL_ATTRS[n];
    if (GLOBAL_ATTRS[n]) return true;
    return !!(TAG_ATTRS[tag] && TAG_ATTRS[tag][n]);
  }

  function safeUrl(value, allowDataImage) {
    var raw = String(value == null ? '' : value);
    if (!raw) return '';
    var probe = raw.replace(CONTROL, '');
    if (probe.charAt(0) === '#') return raw;
    var m = /^([a-z][a-z0-9+.-]*):/i.exec(probe);
    if (!m) return raw;
    var scheme = m[1].toLowerCase();
    if (SCHEMES.test(scheme)) return raw;
    if (allowDataImage && DATA_IMAGE.test(probe)) return raw;
    return '';
  }

  function cleanStyle(value) {
    var parts = String(value == null ? '' : value).split(';');
    var out = [];
    for (var i = 0; i < parts.length; i++) {
      var part = parts[i];
      var ix = part.indexOf(':');
      if (ix < 0) continue;
      var prop = part.slice(0, ix).trim().toLowerCase();
      var val = part.slice(ix + 1).trim();
      if (!STYLE_PROPS[prop]) continue;
      if (!val) continue;
      if (STYLE_VALUE_BAD.test(val)) continue;
      if (!STYLE_VALUE_OK.test(val)) continue;
      out.push(prop + ':' + val);
      if (out.length >= 12) break;
    }
    return out.join(';');
  }

  function cleanClass(value) {
    var v = String(value || '');
    return CLASS_OK.test(v) ? v : '';
  }

  function sanitizeElement(el) {
    var tag = String(el.tagName || '').toLowerCase();
    if (tag === 'input' && String(el.getAttribute('type') || '').toLowerCase() !== 'checkbox') {
      el.remove();
      return;
    }
    var attrs = Array.prototype.slice.call(el.attributes || []);
    for (var i = 0; i < attrs.length; i++) {
      var rawName = attrs[i].name;
      var val = attrs[i].value;
      if (!isAllowedAttr(tag, rawName)) { el.removeAttribute(rawName); continue; }
      var name = String(rawName).toLowerCase();
      if (name === 'style') {
        val = cleanStyle(val);
        if (val) el.setAttribute('style', val); else el.removeAttribute('style');
        continue;
      }
      if (name === 'class') {
        val = cleanClass(val);
        if (val) el.setAttribute('class', val); else el.removeAttribute('class');
        continue;
      }
      if (URL_ATTRS[name]) {
        val = safeUrl(val, name === 'src' && tag === 'img');
        if (val) el.setAttribute(name, val); else el.removeAttribute(name);
        continue;
      }
      if (NUM_ATTRS[name]) {
        val = String(val).trim();
        if (/^\d{1,5}$/.test(val)) el.setAttribute(name, val); else el.removeAttribute(name);
        continue;
      }
      if (name === 'target') {
        el.setAttribute('target', String(val) === '_blank' ? '_blank' : '_self');
        continue;
      }
      if (name === 'rel') { el.setAttribute('rel', 'noopener noreferrer nofollow'); continue; }
      if (name === 'type') {
        el.setAttribute('type', String(val).toLowerCase() === 'checkbox' ? 'checkbox' : 'text');
        continue;
      }
    }
    if (tag === 'input') el.setAttribute('disabled', 'disabled');
    if (tag === 'a' && el.getAttribute('target') === '_blank') {
      el.setAttribute('rel', 'noopener noreferrer nofollow');
    }
  }

  function unwrap(el) {
    var parent = el.parentNode;
    if (!parent) return;
    while (el.firstChild) parent.insertBefore(el.firstChild, el);
    parent.removeChild(el);
  }

  function sanitizeTree(root) {
    var list = root.querySelectorAll('*');
    for (var i = 0; i < list.length; i++) {
      var el = list[i];
      var tag = String(el.tagName || '').toLowerCase();
      if (isDropTag(tag)) { el.remove(); continue; }
      if (!isAllowedTag(tag)) { unwrap(el); continue; }
      sanitizeElement(el);
    }
  }

  function sanitizeHtml(html) {
    if (html == null) return '';
    var src = String(html);
    if (!src) return '';
    if (src.indexOf('<') === -1 && src.indexOf('>') === -1) return src;
    if (typeof DOMParser === 'undefined' || typeof document === 'undefined') return fallback(src);
    var doc = null;
    try {
      doc = new DOMParser().parseFromString('<!DOCTYPE html><html><body>' + src + '</body></html>', 'text/html');
    } catch (e) { return fallback(src); }
    if (!doc || !doc.body) return fallback(src);
    sanitizeTree(doc.body);
    return doc.body.innerHTML;
  }

  function fallback(src) {
    return src
      .replace(/<\s*(script|style|iframe|object|embed|form|svg|math|link|meta|base|template|noscript)\b[\s\S]*?(?:<\/\s*\1\s*>|$)/gi, '')
      .replace(/<\/?[a-z][^>]*>/gi, function (tag) {
        var closing = /^<\s*\//.test(tag);
        var name = (/^<\s*\/?\s*([a-z0-9-]+)/i.exec(tag) || [])[1] || '';
        if (isDropTag(name)) return '';
        if (!isAllowedTag(name)) return '';
        if (closing) return '</' + name.toLowerCase() + '>';
        if (/^<\s*input\b/i.test(tag) && !/type\s*=\s*["']?checkbox/i.test(tag)) return '';
        return tag
          .replace(/\son[a-z]+\s*=\s*("[^"]*"|'[^']*'|[^\s>]+)/gi, '')
          .replace(/\s(href|src)\s*=\s*("([^"]*)"|'([^']*)'|([^\s>]+))/gi, function (m, attr, q, dq, sq, bare) {
            var v = dq != null ? dq : (sq != null ? sq : (bare || ''));
            var safe = safeUrl(v, String(attr).toLowerCase() === 'src');
            return safe ? ' ' + String(attr).toLowerCase() + '="' + safe.replace(/"/g, '&quot;') + '"' : '';
          });
      });
  }

  function sanitizeText(value) {
    return String(value == null ? '' : value).replace(UNSAFE_CHARS, '').slice(0, 20000);
  }

  return {
    sanitizeHtml: sanitizeHtml,
    safeUrl: safeUrl,
    cleanStyle: cleanStyle,
    cleanClass: cleanClass,
    isAllowedTag: isAllowedTag,
    isDropTag: isDropTag,
    isAllowedAttr: isAllowedAttr,
    sanitizeText: sanitizeText
  };
})();

if (typeof module !== 'undefined' && module.exports) module.exports = GrimoireSanitize;
