'use strict';
// SPEC-38: Präsentationsmodus. Reine Logik aus js/presentflow.js ohne Browser
// + Architektur-Guards für die Verdrahtung (Einbau), wie in tests/pageflow.test.js.
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const F = require('../js/presentflow.js');

const root = path.join(__dirname, '..');
const read = (f) => fs.readFileSync(path.join(root, f), 'utf8');

const A4 = { w: 1000, h: 1414 };      // Hochformat
const A4Q = { w: 1414, h: 1000 };     //Querformat

describe('SPEC-38 fitPage', () => {
  it('Hochformat passt in die Höhe und behält das Seitenverhältnis', () => {
    const s = F.fitPage(A4, 1920, 1080, 0);
    assert.equal(s.h, 1080);
    // 1000:1414 ≈ 0,7072 -> Breite = 1080 * 1000/1414
    assert.ok(Math.abs(s.w - Math.floor(1080 * 1000 / 1414)) <= 1, `Breite ${s.w}`);
    assert.ok(Math.abs((s.w / s.h) - (A4.w / A4.h)) < 0.01, 'Seitenverhältnis');
  });

  it('Querformat A4 füllt die Schirmhöhe – die alte Höhen→Breite-Formel schrumpfte es', () => {
    // Schirm 16:9 (1.778) ist breiter als A4 quer (1.414) -> die Höhe ist die
    // Grenze. Genau darin liegt der Unterschied zu `measureFlow()` in app.js,
    // das die Breite aus der Höhe ableitet und auf 760px deckelt: eine
    // Querformat-Seite schrumpfte dort auf 760×537 und ließ die halbe Fläche frei.
    const s = F.fitPage(A4Q, 1920, 1080, 0);
    assert.equal(s.h, 1080, 'nutzt die volle Höhe');
    assert.equal(s.w, 1527, 'breiter als die 760px-Klemme der Hauptansicht');
    assert.ok(Math.abs((s.w / s.h) - (A4Q.w / A4Q.h)) < 0.01, 'Seitenverhältnis');
  });

  it('echt breites Format (Präsentationsfolie/Foto) wird von der Breite begrenzt', () => {
    // 2.5:1 ist breiter als 16:9 -> hier ist die Breite die Grenze. Genau der
    // Fall, an dem eine nur aus der Höhe abgeleitete Breite seitlich auslief.
    const s = F.fitPage({ w: 2000, h: 800 }, 1920, 1080, 0);
    assert.equal(s.w, 1920, 'passt genau in die Breite');
    assert.equal(s.h, 768);
    assert.ok(Math.abs((s.w / s.h) - 2.5) < 0.01, 'Seitenverhältnis');
  });

  it('begrenzt an BEIDEN Achsen: nichts ragt heraus, nichts ist zu klein', () => {
    // Sehr schmales Hochformat auf breitem Schirm -> Höhe ist die Grenze.
    const tall = F.fitPage({ w: 500, h: 2000 }, 3840, 2160, 0);
    assert.ok(tall.h <= 2160 && tall.w <= 3840, 'beide Achsen passen');
    // Breitformat auf winziger Schirm -> Breite ist die Grenze.
    const wide = F.fitPage({ w: 2000, h: 500 }, 800, 600, 0);
    assert.ok(wide.w <= 800 && wide.h <= 600, 'beide Achsen passen');
  });

  it('pad zieht symmetrisch von beiden Achsen ab', () => {
    // 1000×1000 Schirm, A4 hochformat: die Höhe ist immer die Grenze, also
    // wandert die Höhe um genau 2×pad nach unten und die Breite folgt dem
    // Seitenverhältnis.
    const a = F.fitPage(A4, 1000, 1000, 0);
    const b = F.fitPage(A4, 1000, 1000, 50);
    assert.equal(a.h, 1000);
    assert.equal(b.h, 900, 'Höhe genau 2×pad kleiner');
    assert.equal(b.w, Math.floor(900 * 1000 / 1414), 'Breite folgt dem Seitenverhältnis');
    assert.ok(b.w < a.w, 'Seite wird insgesamt kleiner');
  });

  it('maxW deckelt sehr breite Schirme', () => {
    const s = F.fitPage(A4, 3840, 2160, 0, 1200);
    assert.ok(s.w <= 1200, `Breite gedeckelt (${s.w})`);
    assert.ok(Math.abs((s.w / s.h) - (A4.w / A4.h)) < 0.02, 'Deckel darf das Verhältnis nicht verzerren');
  });

  it('überlebt leere Maße, Müll und einen noch nicht im Layout liegenden Schirm', () => {
    assert.equal(F.fitPage(A4, 0, 0, 0).w, 1, '0×0 -> Platzhalter, keine NaN');
    assert.equal(F.fitPage(A4, 0, 0, 0).h, 1);
    assert.equal(F.fitPage(null, 1920, 1080, 0).h, 1080, 'null -> A4-Default');
    assert.equal(F.fitPage({ w: 'x', h: NaN }, 1920, 1080, 0).h, 1080, 'Müll -> A4-Default');
    const s = F.fitPage(A4, -50, -50, 0);
    assert.ok(s.w >= 1 && s.h >= 1, 'negativer Schirm -> Platzhalter');
  });
});

describe('SPEC-38 safeDims', () => {
  it('akzeptiert gültige Maße und rundet sie', () => {
    assert.deepEqual(F.safeDims({ w: 1000.4, h: 1414.6 }), { w: 1000, h: 1415 });
  });
  it('weist Müll aus der Leitung ab', () => {
    for (const bad of [null, undefined, {}, { w: 10, h: 10 }, { w: 0, h: 1414 },
      { w: 1000, h: 0 }, { w: 99999, h: 1414 }, { w: NaN, h: 1000 }, { w: 'a', h: 'b' }]) {
      assert.equal(F.safeDims(bad), null, JSON.stringify(bad));
    }
  });
  it('Grenzen decken sich mit pageDimsOf() in app.js', () => {
    assert.equal(F.MIN_DIM, 200);
    assert.equal(F.MAX_DIM, 2400);
  });
});

describe('SPEC-38 stepIndex', () => {
  it('blättert vor/zurück', () => {
    assert.equal(F.stepIndex(0, 1, 3, false), 1);
    assert.equal(F.stepIndex(2, -1, 3, false), 1);
  });
  it('am Rand ohne Rundlauf: null (PowerPoint bricht ab)', () => {
    assert.equal(F.stepIndex(2, 1, 3, false), null);
    assert.equal(F.stepIndex(0, -1, 3, false), null);
  });
  it('mit Rundlauf: am Ende wieder auf 0', () => {
    assert.equal(F.stepIndex(2, 1, 3, true), 0);
    assert.equal(F.stepIndex(0, -1, 3, true), 2);
  });
  it('leeres Deck und dir=0', () => {
    assert.equal(F.stepIndex(0, 1, 0, false), null);
    assert.equal(F.stepIndex(1, 0, 3, false), 1, 'dir=0 bleibt stehen');
  });
  it('Index ausserhalb wird geklemmt statt zu crashen', () => {
    assert.equal(F.stepIndex(99, -1, 3, false), 1);
    assert.equal(F.stepIndex(-5, 1, 3, false), 1);
  });
});

describe('SPEC-38 planSlides', () => {
  const pages = [{ id: 'a' }, { id: 'b' }, { id: 'c' }];
  it('Folienliste aus dem Dokument, Start bei der gelesenen Seite', () => {
    const p = F.planSlides(pages, 1, false);
    assert.deepEqual(p.ids, ['a', 'b', 'c']);
    assert.equal(p.start, 1);
    assert.equal(p.count, 3);
  });
  it('Start ausserhalb -> vorne', () => {
    assert.equal(F.planSlides(pages, 99, false).start, 0);
    assert.equal(F.planSlides(pages, -1, false).start, 0);
    assert.equal(F.planSlides(pages, null, false).start, 0);
  });
  it('leeres Dokument ergibt eine leere, benutzbare Liste', () => {
    for (const bad of [[], null, undefined, 7]) {
      const p = F.planSlides(bad, 0, false);
      assert.deepEqual(p.ids, []);
      assert.equal(p.count, 0);
    }
  });
  it('Seiten ohne id bekommen einen leeren Platzhalter statt undefined', () => {
    assert.deepEqual(F.planSlides([{}, { id: 'x' }], 0, false).ids, ['', 'x']);
  });
});

describe('SPEC-38 detectTransport', () => {
  const base = { secure: true, presentationRequest: true, broadcastChannel: true, windowOpen: true };
  it('Chrome/Edge: Presentation API hat Vorrang', () => {
    const t = F.detectTransport(base);
    assert.equal(t.mode, 'presentation');
    assert.equal(t.canPresent, true);
  });
  it('Safari: kein PresentationRequest -> Fenster-Fallback (Apple TV über AirPlay)', () => {
    const t = F.detectTransport({ ...base, presentationRequest: false });
    assert.equal(t.mode, 'window');
    assert.equal(t.canPresent, false);
    assert.equal(t.canWindow, true);
  });
  it('unsicherer Kontext (file://, http) -> nichts', () => {
    const t = F.detectTransport({ ...base, secure: false });
    assert.equal(t.mode, 'none');
    assert.equal(t.canLoop, false);
  });
  it('ohne BroadcastChannel UND ohne PresentationRequest -> nichts', () => {
    const t = F.detectTransport({ ...base, presentationRequest: false, broadcastChannel: false });
    assert.equal(t.mode, 'none');
  });
  it('die Empfängerseite erkennt sich selbst', () => {
    assert.equal(F.detectTransport({ ...base, receiver: true }).mode, 'receiver');
  });
  it('Kanalname und Empfängerseite sind fest verdrahtet', () => {
    const t = F.detectTransport(base);
    assert.equal(t.channel, 'federwerk-present');
    assert.equal(t.page, 'present.html');
    assert.equal(F.CHANNEL, 'federwerk-present');
  });
});

describe('SPEC-38 Einbau', () => {
  it('Empfängerseite existiert mit Bühne, Leiste und Wartetext', () => {
    const h = read('present.html');
    assert.match(h, /id="presentRoot"/);
    assert.match(h, /id="presentPage"/);
    assert.match(h, /class="stage present-page"/, 'Papier-Optik aus .stage wiederverwenden');
    for (const part of ['bgLayer', 'drawCanvas', 'imgLayer', 'textLayer']) {
      assert.match(h, new RegExp(`data-part="${part}"`), part);
    }
    assert.match(h, /id="presentBar"/, 'Bedienleiste');
    assert.match(h, /id="presentCount"/, 'Seitenzähler');
    assert.match(h, /id="presentWait"/, 'Wartetext, solange nichts angekommen ist');
    assert.match(h, /id="presentLaser"/, 'eigene Laserebene über der Seite');
  });

  it('die Empfängerseite lädt nur, was sie zum Zeichnen braucht', () => {
    const h = read('present.html');
    for (const s of ['js/sanitize.js', 'js/pencil.js', 'js/inkdraw.js', 'js/laser.js', 'js/presentflow.js', 'js/present-view.js']) {
      assert.match(h, new RegExp(`<script src="${s.replace(/\//g, '\\/')}"><\\/script>`), s);
    }
    // Kein app.js: die Empfängerseite kennt das Dokument nicht.
    assert.ok(!/<script src="js\/app\.js">/.test(h), 'kein app.js auf dem Schirm');
    assert.match(h, /<link rel="stylesheet" href="css\/styles\.css">/, 'ein Stylesheet, das der Build umhängen kann');
  });

  it('present-view.js steht NICHT in index.html – sonst fängt es die Meldungen ab', () => {
    const h = read('index.html');
    assert.ok(!/<script src="js\/present-view\.js">/.test(h),
      'der Empfänger gehört nicht ins App-Bundle: er würde auf BroadcastChannel lauschen');
  });

  it('Ladereihenfolge: Renderer vor app.js, Controller danach', () => {
    const h = read('index.html');
    const at = (s) => h.indexOf(`<script src="${s}">`);
    assert.ok(at('js/inkdraw.js') > 0, 'inkdraw.js eingebunden');
    assert.ok(at('js/inkdraw.js') < at('js/app.js'), 'Renderer muss VOR app.js laden (app.js bindet ihn beim Start)');
    assert.ok(at('js/presentflow.js') < at('js/present.js'), 'present.js braucht presentflow.js');
    assert.ok(at('js/present.js') > at('js/app.js'), 'der Controller liest das Dokument aus der App');
  });

  it('die Haupt-UI bekommt nur einen Knopf und einen Chip – keine Präsentations-Umgehung', () => {
    const h = read('index.html');
    assert.match(h, /id="presentBtn"[^>]*onclick="presentToggle\(\)"/);
    assert.match(h, /id="presentChip"/);
    assert.match(h, /id="presentStopBtn"[^>]*onclick="presentStop\(\)"/);
    // Nichts, was die Hauptansicht umbaut: kein Vollbild, kein Overlay, kein
    // Ausblenden von Header/Toolbar/Rail.
    assert.ok(!/requestFullscreen/.test(h), 'kein requestFullscreen im Hauptfenster');
    assert.ok(!/id="presentOverlay"/.test(h), 'kein Präsentations-Overlay im Hauptfenster');
  });

  it('app.js meldet Seitenwechsel, Inhaltsänderungen und Laser an den Controller', () => {
    const src = read('js/app.js');
    assert.match(src, /FederwerkPresent\.onPage\(pid\)/, 'Seitenwechsel steuert die Show');
    assert.match(src, /FederwerkPresent\.onCanvas\(\)/, 'Inhaltsänderung folgt auf den Schirm');
    assert.match(src, /FederwerkPresent\.onLaser\(idx, pos\)/, 'Laserpointer wird weitergereicht');
    // Die Haken dürfen die Hauptansicht nicht verändern.
    assert.ok(src.includes('try { if (typeof window !== \'undefined\' && window.FederwerkPresent)'),
      'jeder Haken ist optional gekapselt');
  });

  it('der Strich-Renderer liegt in js/inkdraw.js und wird von beiden Seiten benutzt', () => {
    const ink = read('js/inkdraw.js');
    assert.match(ink, /function drawStroke\(c, s\)/);
    assert.match(ink, /window\.FederwerkInk = api/);
    assert.match(read('js/present-view.js'), /Ink\.drawStroke\(ctx, st\)/, 'Empfänger zeichnet mit demselben Renderer');
    assert.match(read('js/app.js'), /FederwerkInk\.drawStroke/, 'app.js zeichnet mit demselben Renderer');
  });

  it('CSS: Chip im Hauptfenster, eigenes Layout für den Schirm', () => {
    const css = read('css/styles.css');
    assert.match(css, /\.present-chip\b/);
    assert.match(css, /\.present-stop\b/);
    assert.match(css, /#presentBtn\.picked/);
    assert.match(css, /\.present-root\b/);
    assert.match(css, /\.present-page\b/);
    assert.match(css, /\.present-bar\b/);
    assert.match(css, /\.present-black \.present-page \{ visibility: hidden; \}/, 'Schwarzbild blendet die Seite aus');
  });

  it('sw.js precacht den Schirm mit – offline präsentierbar', () => {
    const sw = read('sw.js');
    for (const a of ['present.html', 'js/presentflow.js', 'js/present.js', 'js/present-view.js', 'js/inkdraw.js']) {
      assert.match(sw, new RegExp(`'${a.replace(/\//g, '\\/')}'`), a + ' in ASSETS');
    }
  });

  it('der Build bündelt die Empfängerseite mit, ohne index.html anzufassen', () => {
    const b = read('scripts/build-dist.js');
    assert.match(b, /bundlePage\('index\.html', 'app\.bundle', true\)/);
    assert.match(b, /bundlePage\('present\.html', 'present\.bundle', false\)/,
      'present.html ist optional: ein Checkout ohne die Datei darf den Build nicht brechen');
    assert.match(b, /'present\.html'/);
  });
});
