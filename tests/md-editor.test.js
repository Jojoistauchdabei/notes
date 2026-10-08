/* Tests für den Markdown-Editor (tests/md-editor.test.js)
 *
 * Läuft mit `npm test` (node --test) ohne Installation: der Parser liegt in
 * js/vendor/, der Sanitizer in js/sanitize.js - beides im Repo, kein
 * node_modules, kein CDN.
 *
 * Geprüft wird das, was später im Browser wegschimmert: Roundtrip
 * (Quelle -> HTML -> Quelle), OFM-Syntax, Sicherheit und der Dokument-Store.
 */
const test = require('node:test');
const assert = require('node:assert');
const path = require('node:path');

const MD = require('../js/md-render.js');
const SAN = require('../js/sanitize.js');
const Store = require('../js/md-store.js');

// Der Sanitizer laeuft im Browser ueber DOMParser; hier nutzen wir seine
// Regex-Ersatzlogik, damit die Tests ohne DOM auskommen.
const sanitize = (html) => SAN.sanitizeHtml(html);

// Roundtrip: Quelle -> HTML -> Quelle -> HTML -> Quelle muss stabil bleiben.
function roundtrip(src) {
  const first = MD.serialize(MD.render(src, { sanitize }));
  const second = MD.serialize(MD.render(first, { sanitize }));
  return { first, second, stable: first === second };
}

// Was der Editor zurueckschreibt, darf von der Vorlage abweichen (z. B.
// "1. a / 1. b" -> "1. a / 2. b"), aber nur einmal und nie im Kreis.
function canonical(src) {
  return roundtrip(src).second.replace(/\s+$/, '');
}

test('render/parser: vendorter WASM-Parser laedt und parst', async () => {
  const engine = await MD.ready();
  assert.ok(engine && typeof engine.parse === 'function', 'markdown-wasm bereit');
  assert.ok(MD.available());
  const html = MD.render('# Hallo\n', { sanitize });
  assert.match(html, /<h1[^>]*>.*Hallo<\/h1>/);
});

test('render/parser: CommonMark-Bausteine', () => {
  assert.match(MD.render('**fett**', { sanitize }), /<b>fett<\/b>/);
  assert.match(MD.render('*kursiv*', { sanitize }), /<em>kursiv<\/em>/);
  assert.match(MD.render('~~weg~~', { sanitize }), /<del>weg<\/del>/);
  assert.match(MD.render('`a < b`', { sanitize }), /<code>a &lt; b<\/code>/);
  assert.match(MD.render('> Zitat', { sanitize }), /<blockquote>/);
  assert.match(MD.render('---', { sanitize }), /<hr>/);
  assert.match(MD.render('#### vier', { sanitize }), /<h4/);
});

test('render/parser: GFM-Tabellen und Aufgabenlisten', () => {
  const table = MD.render('| a | b |\n|---|---|\n| 1 | 2 |\n', { sanitize });
  assert.match(table, /<table>/);
  assert.match(table, /<th>a<\/th>/);
  const tasks = MD.render('- [ ] offen\n- [x] fertig\n', { sanitize });
  assert.match(tasks, /class="task-list-item"/);
  assert.match(tasks, /checked/);
});

test('render: Marker nur fuer die Live-Ansicht, mit contenteditable=false', () => {
  const live = MD.render('## Titel\n\n**fett** `code`', { sanitize, editable: true });
  assert.match(live, /<span class="md-marker" contenteditable="false">## <\/span>/);
  assert.match(live, /<span class="md-marker" contenteditable="false">\*\*<\/span><b>fett<\/b>/);
  const read = MD.render('**fett**', { sanitize, editable: false });
  assert.doesNotMatch(read, /md-marker/, 'Leseansicht ohne Marker');
});

test('render: Ueberschriften bekommen Anker fuer die Gliederung', () => {
  const html = MD.render('# Erster Teil\n\n### Unter Teil\n', { sanitize, editable: true });
  assert.match(html, /id="h-erster-teil"/);
  assert.match(html, /id="h-unter-teil"/);
});

test('OFM: Wikilinks, Embeds, Highlight, Kommentar, halbe Aufgabe', () => {
  const html = MD.render('[[Notiz]] [[Ziel|Alias]] ![[bild.png|300]] ==wichtig== %%intern%%',
    { sanitize });
  assert.match(html, /<a class="wikilink" href="#wl:Notiz">Notiz<\/a>/);
  assert.match(html, /<a class="wikilink" href="#wl:Ziel">Alias<\/a>/);
  assert.match(html, /<img class="md-embed" src="bild\.png"[^>]*width="300"/);
  assert.match(html, /<mark>wichtig<\/mark>/);
  assert.match(html, /<span class="md-comment" contenteditable="false">intern<\/span>/);

  const half = MD.render('- [/] halb', { sanitize });
  assert.match(half, /md-half/, 'Halb-Marker vorhanden');
});

test('OFM: Callouts werden eigene Kaesten', () => {
  const html = MD.render('> [!warning]- Einklappt\n> Body', { sanitize });
  assert.match(html, /class="md-callout md-callout-warning"/);
  assert.match(html, /data-fold="closed"/);
  assert.match(html, /md-callout-title">Einklappt</);
  assert.match(html, /md-callout-body">Body</);
  const unknown = MD.render('> [!fancy] Titel\n> Body', { sanitize });
  assert.match(unknown, /md-callout-note/, 'unbekannter Typ faellt auf note zurueck');
});

test('serialize: HTML laeuft ohne DOM zurueck nach Markdown', () => {
  assert.equal(MD.serialize('<h2>Head</h2><p>Text mit <b>fett</b></p>'), '## Head\n\nText mit **fett**');
  assert.equal(MD.serialize('<ul><li>a</li><li>b</li></ul>'), '- a\n- b');
  assert.equal(MD.serialize('<ol><li>a</li><li>b</li></ol>'), '1. a\n2. b');
  assert.equal(MD.serialize('<ul><li>a<ul><li>b</li></ul></li></ul>'), '- a\n  - b');
  assert.equal(MD.serialize('<p><del>weg</del></p>'), '~~weg~~');
  assert.equal(MD.serialize('<p><mark>m</mark></p>'), '==m==');
  assert.equal(MD.serialize('<p><a href="https://x.de">https://x.de</a></p>'), '<https://x.de>');
  assert.equal(MD.serialize('<p><a href="https://x.de">Text</a></p>'), '[Text](https://x.de)');
  assert.equal(MD.serialize('<p><img src="b.png" alt="a"></p>'), '![a](b.png)');
  assert.equal(MD.serialize('<blockquote><p>Zitat</p></blockquote>'), '> Zitat');
  assert.equal(MD.serialize('<table><thead><tr><th>a</th></tr></thead><tbody><tr><td>1</td></tr></tbody></table>'),
    '| a |\n| --- |\n| 1 |');
  assert.equal(MD.serialize('<pre><code class="language-js">x = 1;</code></pre>'), '```js\nx = 1;\n```');
});

test('serialize: Aufgaben und Callouts bleiben erhalten', () => {
  const tasks = '<ul><li class="task-list-item"><input type="checkbox">offen</li>'
    + '<li class="task-list-item"><input type="checkbox" checked>fertig</li>'
    + '<li class="task-list-item"><input type="checkbox"><span class="md-half"></span>halb</li></ul>';
  assert.equal(MD.serialize(tasks), '- [ ] offen\n- [x] fertig\n- [/] halb');
  const callout = '<div class="md-callout md-callout-tip" data-fold="open">'
    + '<div class="md-callout-title">Titel</div><div class="md-callout-body">Body</div></div>';
  assert.equal(MD.serialize(callout), '> [!tip]+ Titel\n> Body');
});

test('serialize: Marker-Spans erzeugen keine doppelten Zeichen', () => {
  const live = MD.render('**fett** und *kursiv* und [[Ziel|Alias]]', { sanitize, editable: true });
  assert.match(live, /md-marker/, 'Marker vorhanden');
  assert.equal(MD.serialize(live), '**fett** und *kursiv* und [[Ziel|Alias]]');
});

test('serialize: Browser-Reste (div, b, i, br, styles) werden aufgeraeumt', () => {
  assert.equal(MD.serialize('<div>Zeile eins</div><div>Zeile zwei</div>'), 'Zeile eins\n\nZeile zwei');
  assert.equal(MD.serialize('<p style="font-weight:normal">x</p>'), 'x');
  assert.equal(MD.serialize('<p>a<br>b</p>'), 'a  \nb');
  assert.equal(MD.serialize('<p>a<span class="md-marker" contenteditable="false">**</span>b</p>'), 'ab');
});

test('serialize: Text mit Markdown-Zeichen wird escaped, nicht neu gedeutet', () => {
  assert.equal(MD.serialize('<p>5 * 3 = 15 _ok_ [x]</p>'), '5 \\* 3 = 15 \\_ok\\_ \\[x\\]');
  assert.equal(MD.serialize('<p>- beginnt mit Strich</p>'), '\\- beginnt mit Strich');
  assert.equal(MD.serialize('<p>a &amp; b &lt; c</p>'), 'a & b \\< c');
});

test('Roundtrip: typische Notizen bleiben byte-identisch', () => {
  const sources = [
    '# Titel\n\nAbsatz mit **fett**, *kursiv*, ~~durch~~ und `code`.',
    '## Liste\n\n- a\n- b\n  - b1\n    - b2\n- c',
    '1. eins\n2. zwei',
    '- [ ] offen\n- [x] fertig\n- [/] halb',
    '| a | b |\n| --- | --- |\n| 1 | 2 |',
    '> Zitat\n\n> [!note] Titel\n> Inhalt',
    '```js\nlet a = 1 < 2;\n```',
    'Text mit `inline <tag> & code`, ==Highlight== und %%intern%%.',
    'Wikilink: [[Notiz]] und [[Ziel|Alias]] und [[Notiz#Teil]]',
    'Embed: ![[bild.png|300]]',
    'Bild ![alt](https://x.de/a.png), Link [L](https://x.de)',
    '---\n\nNach dem Trenner.',
    'Hart  \numbruch mit zwei Leerzeichen.',
    'Tiefe Gliederung\n\n## Zwei\n\n### Drei\n\n#### Vier',
  ];
  for (const src of sources) {
    const { first, second, stable } = roundtrip(src);
    assert.ok(stable, `instabil: ${JSON.stringify(src)} -> ${JSON.stringify(first)} -> ${JSON.stringify(second)}`);
    assert.equal(first.replace(/\s+$/, ''), src.replace(/\s+$/, ''), `Roundtrip: ${JSON.stringify(src)}`);
  }
});

test('Roundtrip: kaputte Syntax crasht nicht und bleibt stabil', () => {
  for (const bad of ['[[offen', '==offen', '%%offen', '```js\nohne zu', '> [!', '| a |\n|---|', '![](', '****']) {
    const { first, second, stable } = roundtrip(bad);
    assert.ok(typeof first === 'string', `kein Absturz bei ${JSON.stringify(bad)}`);
    assert.ok(stable, `instabil bei ${JSON.stringify(bad)}: ${JSON.stringify(first)} -> ${JSON.stringify(second)}`);
  }
});

test('Sicherheit: rohes HTML und gefaehrliche Links werden entschaerft', () => {
  const script = MD.render('<script>alert(1)</script>\n\nok\n', { sanitize });
  assert.doesNotMatch(script, /<script/i);
  const jsUri = MD.render('[x](javascript:alert(1))', { sanitize });
  assert.doesNotMatch(jsUri, /javascript:/i);
  const onErr = MD.render('<img src=x onerror="alert(1)">\n', { sanitize });
  assert.doesNotMatch(onErr, /onerror/i);
  // Kommentar-Inhalt wird escaped, nicht interpretiert:
  const comment = MD.render('%%<img src=x onerror=alert(1)>%%', { sanitize });
  assert.doesNotMatch(comment, /<img[^>]*onerror/i);
});

test('render: nackte Autolinks werden beim Roundtrip zu <…> kanonisiert', () => {
  // GFM rendert eine nackte URL als <a>; zurueck schreiben wir die eindeutige
  // spitze Klammer-Form. Beide sind fuer sich gueltig, danach bleibt es stabil.
  assert.equal(canonical('siehe https://autolink.de\n'), 'siehe <https://autolink.de>');
});

test('render: ohne WASM gibt es Text statt Absturz', async () => {
  MD._internals._setEngine(null);
  try {
    const html = MD.render('# x <b>y</b>', { sanitize });
    assert.ok(typeof html === 'string' && html.length > 0);
    assert.doesNotMatch(html, /<b>/, 'kein ungeprueftes HTML im Notfallpfad');
    assert.match(html, /&lt;b&gt;/);
  } finally {
    await MD.ready();
  }
});

test('outline/stats: Gliederung und Kennzahlen aus der Quelle', () => {
  const src = '# Titel\n\nText\n\n## Unter\n\n```\n# kein Titel im Code\n```\n\n### Drittes\n';
  assert.deepEqual(MD.outline(src).map((h) => [h.level, h.text]), [[1, 'Titel'], [2, 'Unter'], [3, 'Drittes']]);
  const s = MD.stats(src);
  assert.ok(s.words > 0 && s.chars === src.length);
  assert.equal(s.headings, 3);
  assert.equal(MD.titleFromSource('# Titel\n\nx'), 'Titel');
  assert.equal(MD.titleFromSource('nur text'), 'nur text');
});

test('store: anlegen, lesen, sortieren, umbenennen, loeschen (ohne IndexedDB)', async () => {
  Store._internals._setForceMemory(true);
  Store._internals._reset();
  const a = await Store.create('Alpha', '# A\n');
  const b = await Store.create('Beta', '# B\n');
  assert.ok(a.id && a.id !== b.id);
  const list = await Store.list();
  assert.deepEqual(list.map((d) => d.title).sort(), ['Alpha', 'Beta']);
  const got = await Store.get(a.id);
  assert.equal(got.source, '# A\n');
  const renamed = await Store.rename(a.id, 'Alpha 2');
  assert.equal(renamed.title, 'Alpha 2');
  assert.equal((await Store.get(a.id)).title, 'Alpha 2');
  const copy = await Store.duplicate(a.id);
  assert.equal(copy.source, got.source);
  assert.match(copy.title, /Kopie/);
  await Store.remove(b.id);
  assert.equal(await Store.get(b.id), null);
  assert.equal((await Store.list()).length, 2);
});

test('store: init legt ein Startdokument mit Beispiel an', async () => {
  Store._internals._setForceMemory(true);
  Store._internals._reset();
  const first = await Store.init();
  assert.ok(first && first.source.indexOf('## Was geht') > 0, 'Beispieltext vorhanden');
  const second = await Store.init();
  assert.equal(second.id, first.id, 'kein zweites Dokument beim zweiten Start');
});

test('store: put normalisiert Felder (Title-Laenge, Zeitstempel)', () => {
  const clean = Store._internals.normalize({ id: 'x', title: 'T'.repeat(500), source: 42 });
  assert.equal(clean.title.length, 200);
  assert.equal(clean.source, '42');
  assert.ok(clean.createdAt > 0 && clean.updatedAt > 0);
  assert.equal(Store._internals.normalize(null), null);
  assert.equal(Store._internals.normalize({ title: 'ohne id' }), null);
});

test('store: sortiert nach Aktualisierung', () => {
  const sorted = Store._internals.sortDocs([
    { id: 'a', title: 'A', updatedAt: 100 },
    { id: 'b', title: 'B', updatedAt: 300 },
    { id: 'c', title: 'C', updatedAt: 200 },
  ]);
  assert.deepEqual(sorted.map((d) => d.id), ['b', 'c', 'a']);
});

test('Seite: md.html laedt die erwarteten Dateien und verlinkt sie aus index.html', () => {
  const fs = require('node:fs');
  const root = path.join(__dirname, '..');
  const html = fs.readFileSync(path.join(root, 'md.html'), 'utf8');
  for (const rel of ['css/md-editor.css', 'js/sanitize.js', 'js/dialog.js', 'js/md-render.js',
    'js/md-store.js', 'js/md-editor.js', 'js/vendor/markdown.js', 'js/themes.js']) {
    assert.ok(html.includes('"' + rel + '"'), `md.html laedt ${rel}`);
    assert.ok(fs.existsSync(path.join(root, rel)), `${rel} existiert`);
  }
  // Der WASM-Laedepfad ist relativ zum Skript: die .wasm muss daneben liegen.
  assert.ok(fs.existsSync(path.join(root, 'js', 'vendor', 'markdown.wasm')), 'markdown.wasm liegt neben dem JS');
  // build-dist.js buendelt nur Skript-Tags ohne Attribute - data-wasm muss
  // draufbleiben, sonst laeuft der Editor ohne Parser.
  assert.match(html, /<script src="js\/vendor\/markdown\.js" data-wasm><\/script>/);
  assert.match(html, /id="mdLive"[^>]*contenteditable="true"/);
  const index = fs.readFileSync(path.join(root, 'index.html'), 'utf8');
  assert.match(index, /md\.html/, 'index.html verlinkt den Markdown-Editor');
});
