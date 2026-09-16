'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const SRC_PATH = path.join(__dirname, '..', 'js', 'markdown.js');
const SRC = fs.readFileSync(SRC_PATH, 'utf8');
const M = require('../js/markdown.js');

describe('markdown/datei', () => {
  it('ist ohne DOM ladbar (reine Funktionen, kein Browser-Zugriff)', () => {
    assert.ok(M && typeof M.mdToHtml === 'function');
    // Darf weder auf Top-Level noch in Funktionen Browser-APIs anfassen.
    assert.ok(!/\b(document|window|navigator|localStorage|alert)\b/.test(SRC),
      'js/markdown.js muss ohne DOM auskommen');
  });
  it('exportiert die vereinbarte API (+ Aliase)', () => {
    for (const k of ['mdToHtml', 'htmlToMd', 'markdownToHtml', 'htmlToMarkdown', 'isMarkdown']) {
      assert.equal(typeof M[k], 'function', k);
    }
    assert.equal(M.markdownToHtml, M.mdToHtml);
    assert.equal(M.htmlToMarkdown, M.htmlToMd);
  });
});

describe('markdown/mdToHtml', () => {
  it('headings h1-h3 (h4 bleibt Text, light-Subset)', () => {
    assert.equal(M.mdToHtml('# Titel'), '<h1>Titel</h1>');
    assert.equal(M.mdToHtml('## Mittel'), '<h2>Mittel</h2>');
    assert.equal(M.mdToHtml('### Klein'), '<h3>Klein</h3>');
    assert.match(M.mdToHtml('#### Tief'), /<p>#### Tief<\/p>/);
  });
  it('bold / italic / strike (je zwei Varianten)', () => {
    assert.match(M.mdToHtml('**fett**'), /<strong>fett<\/strong>/);
    assert.match(M.mdToHtml('__fett__'), /<strong>fett<\/strong>/);
    assert.match(M.mdToHtml('*kursiv*'), /<em>kursiv<\/em>/);
    assert.match(M.mdToHtml('_kursiv_'), /<em>kursiv<\/em>/);
    assert.match(M.mdToHtml('~~weg~~'), /<del>weg<\/del>/);
  });
  it('listen ul / ol', () => {
    const html = M.mdToHtml('- a\n- b');
    assert.match(html, /<ul>/);
    assert.match(html, /<li>a<\/li>/);
    assert.match(html, /<li>b<\/li>/);
    const ol = M.mdToHtml('1. eins\n2. zwei');
    assert.match(ol, /<ol>/);
    assert.match(ol, /<li>eins<\/li>/);
  });
  it('links + autolinks', () => {
    assert.match(M.mdToHtml('[Text](https://x.de)'), /<a href="https:\/\/x\.de">Text<\/a>/);
    assert.match(M.mdToHtml('siehe https://x.de ok'), /<a href="https:\/\/x\.de">https:\/\/x\.de<\/a>/);
  });
  it('highlight == ==', () => {
    assert.match(M.mdToHtml('==wichtig=='), /<mark>wichtig<\/mark>/);
  });
  it('code inline + block, HTML wird escaped', () => {
    assert.match(M.mdToHtml('`a < b`'), /<code>a &lt; b<\/code>/);
    const block = M.mdToHtml('```\nif (a < b) {}\n```');
    assert.match(block, /<pre><code>if \(a &lt; b\) \{\}<\/code><\/pre>/);
    const evil = M.mdToHtml('<script>alert(1)</script>');
    assert.ok(!evil.includes('<script>'), 'kein HTML-Injection aus Markdown-Quelle');
  });
  it('kommentare %% %% werden nicht gerendert', () => {
    assert.equal(M.mdToHtml('a %%intern%% b').trim(), '<p>a  b</p>');
    assert.match(M.mdToHtml('==offen'), /==offen/); // ungeschlossen = Text
  });
  it('wikilinks bleiben als Text erhalten', () => {
    for (const w of ['[[Notiz]]', '[[Notiz|Alias]]', '[[Notiz#Header]]', '[[Notiz#^block]]']) {
      const html = M.mdToHtml('Link ' + w);
      assert.ok(html.includes(w), w + ' muss im HTML stehen: ' + html);
    }
    assert.match(M.mdToHtml('[[offen'), /\[\[offen/); // kaputt = Plain-Text, kein Crash
  });
  it('callouts rendern als div.callout (Fallback note)', () => {
    const html = M.mdToHtml('> [!note] Hinweis\n> Inhalt hier');
    assert.match(html, /<div class="callout callout-note">/);
    assert.match(html, /<div class="callout-title">Hinweis<\/div>/);
    assert.match(html, /<div class="callout-body">Inhalt hier<\/div>/);
    const fancy = M.mdToHtml('> [!fancy] Titel\n> Body');
    assert.match(fancy, /callout-note/); // unbekannter Typ faellt zurueck
    const folded = M.mdToHtml('> [!warning]- Zu\n> Body');
    assert.match(folded, /callout-warning/);
    assert.match(folded, /data-fold="closed"/);
  });
  it('tasks - [ ] / - [x] / - [/]', () => {
    const html = M.mdToHtml('- [ ] offen\n- [x] fertig\n- [/] halb');
    assert.match(html, /<ul class="task-list">/);
    assert.match(html, /data-marker=" "/);
    assert.match(html, /data-marker="x" checked/);
    assert.match(html, /data-marker="\/"/);
  });
});

describe('markdown/htmlToMd', () => {
  it('grundlagen: h1, bold, italic, strike, highlight, hr', () => {
    assert.equal(M.htmlToMd('<h1>Titel</h1>'), '# Titel');
    assert.equal(M.htmlToMd('<h2>M</h2>'), '## M');
    assert.equal(M.htmlToMd('<p>Hallo <b>Welt</b></p>'), 'Hallo **Welt**');
    assert.equal(M.htmlToMd('<p><i>k</i> und <s>w</s></p>'), '*k* und ~~w~~');
    assert.equal(M.htmlToMd('<p><mark>m</mark></p>'), '==m==');
    assert.equal(M.htmlToMd('<p>a</p><hr><p>b</p>'), 'a\n\n---\n\nb');
  });
  it('links (autolink bleibt nackte URL)', () => {
    assert.equal(M.htmlToMd('<a href="https://x.de">Text</a>'), '[Text](https://x.de)');
    assert.equal(M.htmlToMd('<a href="https://x.de">https://x.de</a>'), 'https://x.de');
  });
  it('listen + tasks aus Editor-HTML', () => {
    assert.equal(M.htmlToMd('<ul><li>a</li><li>b</li></ul>'), '- a\n- b');
    assert.equal(M.htmlToMd('<ol><li>a</li><li>b</li></ol>'), '1. a\n2. b');
    const md = M.htmlToMd('<ul class="task-list"><li class="task-list-item">' +
      '<input type="checkbox" disabled data-marker=" "> offen</li>' +
      '<li class="task-list-item"><input type="checkbox" disabled data-marker="x" checked> fertig</li></ul>');
    assert.equal(md, '- [ ] offen\n- [x] fertig');
  });
  it('callout-div wird zur > [!typ]-Zeile', () => {
    const md = M.htmlToMd('<div class="callout callout-note"><div class="callout-title">Hinweis</div>' +
      '<div class="callout-body">Inhalt hier</div></div>');
    assert.equal(md, '> [!note] Hinweis\n> Inhalt hier');
  });
  it('wikilink-spans + entities', () => {
    assert.equal(M.htmlToMd('<span class="wikilink">[[N|A]]</span>'), '[[N|A]]');
    assert.equal(M.htmlToMd('<p>a &lt; b &amp; c</p>'), 'a < b & c');
  });
});

describe('markdown/roundtrip', () => {
  const fixtures = [
    '# Titel',
    'Fett **stark** und *kursiv*, ~~weg~~, ==mark==.',
    '- a\n- b',
    '1. eins\n2. zwei',
    '- [ ] offen\n- [x] fertig\n- [/] halb',
    '> [!note] Hinweis\n> Inhalt hier',
    '> [!warning]- Zu\n> Body',
    'Wikilink [[Notiz|Alias]] und [[Ziel#Header]] plus [Link](https://x.de).',
    '`code` und\n\n```\nblock <tag>\n```',
    '# Mix\n\nAbsatz mit **fett**.\n\n- [ ] Task\n- normal\n\n> [!tip] T\n> B',
  ];
  for (const md of fixtures) {
    it('stabil: ' + JSON.stringify(md.slice(0, 40)), () => {
      const h1 = M.mdToHtml(md);
      const back = M.htmlToMd(h1);
      const h2 = M.mdToHtml(back);
      assert.equal(h2, h1, 'HTML-Ebene muss stabil sein, sonst zerstoert Editieren: ' + back);
    });
  }
  it('kanonisch: md -> html -> md', () => {
    assert.equal(M.htmlToMd(M.mdToHtml('# T')), '# T');
    assert.equal(M.htmlToMd(M.mdToHtml('**f** und *k*')), '**f** und *k*');
    assert.equal(M.htmlToMd(M.mdToHtml('- [ ] a\n- [x] b')), '- [ ] a\n- [x] b');
  });
  it('kaputte OFM-Syntax crasht nicht', () => {
    for (const bad of ['[[offen', '> [!fancy', '==offen', '~~halb', '**fett', '> [!note]', '- [ ]']) {
      assert.doesNotThrow(() => M.mdToHtml(bad));
      assert.doesNotThrow(() => M.htmlToMd(M.mdToHtml(bad)));
    }
  });
});

describe('markdown/isMarkdown', () => {
  it('erkennt Markdown-Quelle', () => {
    for (const md of ['# T', '**f**', '- a\n- b', '[[N]]', '> [!note] x', '==m==', '- [ ] t', '[a](http://b)']) {
      assert.equal(M.isMarkdown(md), true, md);
    }
  });
  it('lehnt HTML + Plain-Text ab (alte Boxen laden unveraendert)', () => {
    assert.equal(M.isMarkdown('<p>Hallo <b>Welt</b></p>'), false);
    assert.equal(M.isMarkdown('<h1>T</h1><ul><li>a</li></ul>'), false);
    assert.equal(M.isMarkdown('nur Text ohne Syntax'), false);
    assert.equal(M.isMarkdown(''), false);
    assert.equal(M.isMarkdown(null), false);
  });
});
