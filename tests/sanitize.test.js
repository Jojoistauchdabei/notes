// tests/sanitize.test.js – Allowlist-Sanitizer: URL-Schemes, Style-Filter,
// Tag-/Attribut-Policy, der Node-Fallback und die Verdrahtung in der App.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const S = require('../js/sanitize.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

describe('sanitize/safeUrl', () => {
  it('blockiert javascript:/data:-HTML, erlaubt http(s), mailto, blob, relativ', () => {
    assert.equal(S.safeUrl('javascript:alert(1)'), '');
    assert.equal(S.safeUrl('JaVaScRiPt:alert(1)'), '');
    assert.equal(S.safeUrl('java\tscript:alert(1)'), '');
    assert.equal(S.safeUrl('java\nscript:alert(1)'), '');
    assert.equal(S.safeUrl(' javascript:alert(1)'), '');
    assert.equal(S.safeUrl('vbscript:msgbox(1)'), '');
    assert.equal(S.safeUrl('data:text/html;base64,PHNjcmlwdD4='), '');
    assert.equal(S.safeUrl('https://example.org/a?b=1&c=2'), 'https://example.org/a?b=1&c=2');
    assert.equal(S.safeUrl('mailto:a@b.de'), 'mailto:a@b.de');
    assert.equal(S.safeUrl('blob:http://localhost:8123/abc'), 'blob:http://localhost:8123/abc');
    assert.equal(S.safeUrl('./bild.png'), './bild.png');
    assert.equal(S.safeUrl('/pfad/bild.png'), '/pfad/bild.png');
    assert.equal(S.safeUrl('#anker'), '#anker');
  });

  it('data:image/* nur für Bild-URLs', () => {
    assert.equal(S.safeUrl('data:image/png;base64,AAA', true), 'data:image/png;base64,AAA');
    assert.equal(S.safeUrl('data:image/svg+xml;base64,AAA', true), '');
    assert.equal(S.safeUrl('data:text/html,<b>', true), '');
  });
});

describe('sanitize/cleanStyle', () => {
  it('behaelt erlaubte Eigenschaften, wirft url()/expression()/unbekannte raus', () => {
    assert.equal(S.cleanStyle('color: red; font-size: 17px'), 'color:red;font-size:17px');
    assert.equal(S.cleanStyle('background-color:#fff;position:fixed;z-index:99'), 'background-color:#fff');
    assert.equal(S.cleanStyle('background:url(javascript:alert(1))'), '');
    assert.equal(S.cleanStyle('width:expression(alert(1))'), '');
    assert.equal(S.cleanStyle('color:red\\3a  blue'), '');
  });
});

describe('sanitize/Tag- und Attribut-Policy', () => {
  it('erlaubt Formatierungs-Tags, verbietet aktive Tags', () => {
    for (const t of ['b', 'strong', 'i', 'em', 'u', 's', 'p', 'div', 'span', 'ul', 'ol', 'li', 'h1', 'mark', 'code', 'pre', 'blockquote', 'img', 'a', 'input']) {
      assert.ok(S.isAllowedTag(t), t + ' erlaubt');
    }
    for (const t of ['script', 'style', 'iframe', 'object', 'embed', 'svg', 'math', 'form', 'link', 'meta', 'base', 'template', 'noscript']) {
      assert.ok(S.isDropTag(t), t + ' verworfen');
      assert.ok(!S.isAllowedTag(t), t + ' nicht erlaubt');
    }
  });

  it('verwirft Event-Handler und unbekannte data-Attribute', () => {
    assert.equal(S.isAllowedAttr('img', 'onerror'), false);
    assert.equal(S.isAllowedAttr('div', 'onclick'), false);
    assert.equal(S.isAllowedAttr('div', 'onmouseover'), false);
    assert.equal(S.isAllowedAttr('a', 'formaction'), false);
    assert.equal(S.isAllowedAttr('div', 'data-boese'), false);
    assert.equal(S.isAllowedAttr('div', 'data-lang'), true);
    assert.equal(S.isAllowedAttr('a', 'href'), true);
    assert.equal(S.isAllowedAttr('img', 'src'), true);
  });

  it('cleanClass laesst nur Klassennamen zu', () => {
    assert.equal(S.cleanClass('callout callout-note'), 'callout callout-note');
    assert.equal(S.cleanClass('a" onmouseover="x'), '');
  });
});

describe('sanitize/sanitizeHtml (Fallback ohne DOM)', () => {
  it('entfernt Script/Inline-Handler/javascript:-Links', () => {
    const out = S.sanitizeHtml('<img src=x onerror=alert(1)><b>ok</b><script>alert(2)</script>');
    assert.ok(!/onerror/i.test(out), 'onerror entfernt');
    assert.ok(!/<script/i.test(out), 'script entfernt');
    assert.ok(/<b>ok<\/b>/.test(out), 'Formatierung bleibt');
    const link = S.sanitizeHtml('<a href="javascript:alert(1)">x</a>');
    assert.ok(!/javascript:/i.test(link), 'javascript:-Link entfernt');
  });

  it('laesst Klartext unangetastet', () => {
    assert.equal(S.sanitizeHtml('Hallo & Welt'), 'Hallo & Welt');
    assert.equal(S.sanitizeHtml(''), '');
    assert.equal(S.sanitizeHtml(null), '');
  });
});

describe('sanitize/sanitizeText', () => {
  it('entfernt Steuerzeichen und kappt Laenge', () => {
    assert.equal(S.sanitizeText('a\u0000b\u001fc'), 'abc');
    assert.equal(S.sanitizeText('x'.repeat(30000)).length, 20000);
  });
});

describe('sanitize/Verdrahtung', () => {
  it('sanitize.js ist in index.html und sw.js eingebunden', () => {
    assert.ok(read('index.html').includes('js/sanitize.js'), 'index.html lädt sanitize.js');
    assert.ok(read('sw.js').includes('js/sanitize.js'), 'sw.js cacht sanitize.js');
  });

  it('Textbox-HTML wird beim Rendern und Editieren sanitisiert', () => {
    const app = read('js/app.js');
    const ed = read('js/editor.js');
    assert.ok(/d\.innerHTML = sanitizeNoteHtml\(t\.html\)/.test(app), 'renderTextLayerFor sanitisiert');
    assert.ok(!/d\.innerHTML = t\.html;/.test(app), 'kein ungeschütztes t.html');
    assert.ok(/editorContent\.innerHTML = editorSafeHtml\(box\.html/.test(ed), 'Editor lädt sanitisiert');
    assert.ok(/box\.html = editorSafeHtml\(editorContent\.innerHTML\)/.test(ed), 'Editor speichert sanitisiert');
  });

  it('stripHtml nutzt DOMParser statt detached innerHTML (Chrome feuert Handler)', () => {
    const app = read('js/app.js');
    assert.ok(!/createElement\('div'\);\s*d\.innerHTML = h/.test(app), 'kein detached innerHTML in stripHtml');
    assert.ok(app.includes('new DOMParser().parseFromString'), 'stripHtml nutzt DOMParser');
  });

  it('Markdown blockiert javascript:-Links', () => {
    const md = require('../js/markdown.js');
    const out = md.mdToHtml('[x](javascript:alert(1))');
    assert.ok(!/javascript:/i.test(out), 'kein javascript:-Link im HTML');
    assert.ok(/<a href="https:\/\/x\.de">/.test(md.mdToHtml('[x](https://x.de)')), 'https-Link bleibt');
  });

  it('Updater escaped Release-Tag und prüft Download-Host', () => {
    const up = read('js/updater.js');
    assert.ok(up.includes('escHtml(safeTag('), 'Tag wird escaped/geprüft');
    assert.ok(up.includes('safeDownloadUrl(a.browser_download_url)'), 'APK-URL wird geprüft');
    assert.ok(/githubusercontent\.com/.test(up), 'nur GitHub-Hosts erlaubt');
  });

  it('MCP-Server/Worker: timing-sicherer Vergleich, CORS aus, Rate-Limit', () => {
    const w = read('worker.js');
    const s = read('mcp-server.js');
    assert.ok(w.includes('timingSafeEqual(bearerOf(request)'), 'Worker: timingSafeEqual');
    assert.ok(!/bearerOf\(request\) !== String\(env\.MCP_TOKEN\)/.test(w), 'kein direkter !==-Vergleich');
    assert.ok(w.includes('MCP_ALLOW_ORIGIN'), 'Worker: CORS nur opt-in');
    assert.ok(!w.includes("'Access-Control-Allow-Origin': '*'"), 'kein Wildcard-CORS im Worker');
    assert.ok(w.includes('tooManyLogins'), 'Worker: Login-Rate-Limit');
    assert.ok(s.includes('timingSafeEqual(bearerOf(req), TOKEN)'), 'MCP-Server: timingSafeEqual');
    assert.ok(!s.includes("'Access-Control-Allow-Origin': '*'"), 'kein Wildcard-CORS im MCP-Server');
    assert.ok(s.includes("arg('host'"), 'MCP-Server: Host konfigurierbar (Default 127.0.0.1)');
  });
});

describe('sanitize/Import-Guards', () => {
  it('app.js begrenzt Import-Größen und Bild-Pixel', () => {
    const app = read('js/app.js');
    assert.ok(app.includes('const IMPORT_LIMITS = {'), 'IMPORT_LIMITS definiert');
    for (const kind of ['json', 'goodnotes', 'pdf', 'image']) {
      assert.ok(new RegExp('\\b' + kind + ': \\d+ \\* 1024 \\* 1024').test(app), kind + ' hat ein Limit');
    }
    assert.ok(app.includes('imagePixels: 80e6'), 'Pixel-Limit für Bilder');
    assert.ok(app.includes("importTooBig(f, 'goodnotes')"), 'GoodNotes-Import geprüft');
    assert.ok(app.includes("importTooBig(f, 'json')"), 'JSON-Import geprüft');
    assert.ok(app.includes("importTooBig(file, 'pdf')"), 'PDF-Import geprüft');
    assert.ok(app.includes('importTooManyPixels(img.width, img.height)'), 'Pixel-Check beim Bild-Import');
  });
});
