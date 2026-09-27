'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');
const PF = require('../js/pageflow.js');

const root = path.join(__dirname, '..');
const read = f => fs.readFileSync(path.join(root, f), 'utf8');

/* Continuous Scroll ist Architektur, nicht nur Logik: die Seiten muessen im
 * Scroller liegen, das Modul muss geladen werden, und der alte Wheel-Hijack
 * darf nicht zurueckkommen (er wuerde das native Scrollen wieder schlucken). */
describe('pageflow/einbau', () => {
  it('js/pageflow.js existiert und ist in index.html + sw.js eingebunden', () => {
    assert.ok(fs.existsSync(path.join(root, 'js/pageflow.js')), 'js/pageflow.js existiert');
    assert.ok(read('index.html').includes('js/pageflow.js'), 'index.html laedt pageflow.js');
    assert.ok(read('sw.js').includes('js/pageflow.js'), 'sw.js cacht pageflow.js (offline nutzbar)');
  });

  it('die Buehne liegt in einem Scroll-Container, nicht direkt in .stage-wrap', () => {
    const html = read('index.html');
    assert.ok(html.includes('class="stage-scroll" id="stageScroll"'), 'Pane A hat .stage-scroll');
    assert.ok(html.includes('class="stage-scroll" id="stageScrollB"'), 'Pane B hat .stage-scroll');
    assert.ok(html.includes('class="stage-stack" id="stageStack"'), 'Pane A hat .stage-stack');
    // Slot-Rahmen fuer die Seiten-Geometrie
    assert.ok(/class="stage" id="stage"[^>]*data-part="stage"/.test(html), '#stage ist als data-part markiert');
    assert.ok(/id="bgLayer"[^>]*data-part="bgLayer"/.test(html), 'Ebenen tragen data-part (ID-Wanderung)');
    assert.ok(/id="drawCanvas"[^>]*data-part="drawCanvas"/.test(html), 'Canvas traegt data-part');
  });

  it('der alte Wheel-/Swipe-Hijack ist entfernt (kein preventDefault auf Wheel)', () => {
    const app = read('js/app.js');
    assert.ok(!app.includes("addEventListener('wheel'"), 'kein wheel-Listener mehr');
    assert.ok(!app.includes('scrollNavEnabled'), 'kein Scroll-Nav-Status mehr');
    assert.ok(!app.includes('GrimoireScrollNav'), 'keine Referenz auf das alte Modul');
    assert.ok(!fs.existsSync(path.join(root, 'js/scrollnav.js')), 'js/scrollnav.js geloescht');
  });

  it('das Scroller-Styling ist im CSS vorhanden', () => {
    const css = read('css/styles.css');
    assert.ok(/\.stage-scroll\s*\{[^}]*overflow-y:\s*auto/.test(css), '.stage-scroll scrollt vertikal');
    assert.ok(/\.stage-scroll\s*\{[^}]*touch-action:\s*pan-y/.test(css), 'vertikales Panning bleibt nativ');
    // Slot-Hoehe kommt aus dem Slot, nicht aus dem Inhalt -> Mounten ruckt nicht
    assert.ok(/\.page-slot\s*\{[^}]*aspect-ratio/.test(css), '.page-slot definiert die Hoehe');
  });
});

const A4 = 1000;   // Seitenhoehen in px (A4 hoch, 1000 breit)

function layout(n, h, gap) { return PF.buildLayout(new Array(n).fill(h), gap); }

describe('pageflow/buildLayout', () => {
  it('setzt tops fortlaufend mit Luecke', () => {
    const l = PF.buildLayout([100, 200, 300], 20);
    assert.deepEqual(l.tops, [0, 120, 340]);
    assert.equal(l.height, 100 + 200 + 300 + 40);
    assert.equal(l.count, 3);
  });
  it('ohne Seiten ist die Hoehe 0, kein NaN', () => {
    const l = PF.buildLayout([], 20);
    assert.equal(l.count, 0);
    assert.equal(l.height, 0);
    assert.deepEqual(l.tops, []);
  });
  it('kaputte Hoehen (0/NaN/negativ) werden auf 1 gefangen', () => {
    const l = PF.buildLayout([0, NaN, -50, 100], 0);
    assert.deepEqual(l.heights, [1, 1, 1, 100]);
    assert.equal(l.height, 103);
  });
  it('negative Luecke faellt auf den Default zurueck', () => {
    const l = PF.buildLayout([10, 10], -5);
    assert.equal(l.gap, PF.DEFAULT_GAP);
    assert.deepEqual(l.tops, [0, 10 + PF.DEFAULT_GAP]);
  });
});

describe('pageflow/clampScroll', () => {
  it('klemmt oben und unten', () => {
    const l = layout(5, 100, 0);
    assert.equal(PF.clampScroll(-50, l, 300), 0);
    assert.equal(PF.clampScroll(99999, l, 300), 500 - 300);
    assert.equal(PF.clampScroll(100, l, 300), 100);
  });
  it('Sichtbereich groesser als der Stack -> nur 0', () => {
    const l = layout(2, 100, 0);
    assert.equal(PF.clampScroll(0, l, 900), 0);
    assert.equal(PF.maxScrollOf(l, 900), 0);
  });
});

describe('pageflow/pageFromScroll', () => {
  // 4 Seiten a 100px, Sichtbereich 100px -> Scrollbereich 0..300.
  const l = layout(4, 100, 0);
  const V = 100;
  it('Seite an der Fokuslinie', () => {
    assert.equal(PF.pageFromScroll(l, 0, V, 12), 0);
    assert.equal(PF.pageFromScroll(l, 150, V, 12), 1);
    assert.equal(PF.pageFromScroll(l, 250, V, 12), 2);
  });
  it('Fokuslinie zaehlt, nicht die Oberkante', () => {
    // 87px gescrollt: Seite 0 ist noch sichtbar, die Linie (87+12=99) liegt
    // noch auf ihr. Ab 88px liegt die Linie auf Seite 1.
    assert.equal(PF.pageFromScroll(l, 87, V, 12), 0);
    assert.equal(PF.pageFromScroll(l, 88, V, 12), 1);
  });
  it('am unteren Anschlag gilt die letzte Seite', () => {
    assert.equal(PF.pageFromScroll(l, 300, V, 12), 3);
    assert.equal(PF.pageFromScroll(l, 99999, V, 12), 3);
  });
  it('leerer Stack -> -1', () => {
    assert.equal(PF.pageFromScroll(PF.buildLayout([]), 0, V, 12), -1);
  });
  it('Seiten mit Luecke: die Luecke gehoert zur unteren Seite', () => {
    // tops 0,120,240 – die Luecke 100..120 traegt keine Seite.
    const g = layout(3, 100, 20);
    const gv = 100; // maxScroll 240
    assert.equal(PF.pageFromScroll(g, 87, gv, 12), 0); // Linie 99 -> Seite 0
    assert.equal(PF.pageFromScroll(g, 88, gv, 12), 1); // Linie 100 -> Seite 1
    assert.equal(PF.pageFromScroll(g, 0, gv, 12), 0);
    assert.equal(PF.pageFromScroll(g, 120, gv, 12), 1);
  });
});

describe('pageflow/windowRange', () => {
  const l = layout(10, 100, 0);
  it('deckt Sichtbereich plus Overscan ab', () => {
    const w = PF.windowRange(l, 300, 200, 50);
    assert.equal(w.start, 2);
    assert.equal(w.end, 5);
  });
  it('ohne Overscan nur der sichtbare Bereich', () => {
    const w = PF.windowRange(l, 300, 200, 0);
    assert.equal(w.start, 3);
    assert.equal(w.end, 4);
  });
  it('schneidet am oberen Rand', () => {
    const w = PF.windowRange(l, 0, 300, 50);
    assert.equal(w.start, 0);
    assert.equal(w.end, 3);
  });
  it('schneidet am unteren Rand', () => {
    const w = PF.windowRange(l, 700, 300, 50);
    assert.equal(w.start, 6);
    assert.equal(w.end, 9);
  });
  it('leerer Stack -> leeres Fenster', () => {
    const w = PF.windowRange(PF.buildLayout([]), 0, 300, 50);
    assert.equal(w.start, 0);
    assert.equal(w.end, -1);
  });
  it('Sichtbereich groesser als alles -> alles', () => {
    const w = PF.windowRange(layout(3, 100, 0), 0, 900, 0);
    assert.equal(w.start, 0);
    assert.equal(w.end, 2);
  });
});

describe('pageflow/dominantPageIndex', () => {
  it('die am staerksten sichtbare Seite gewinnt', () => {
    const l = layout(5, 100, 0);
    assert.equal(PF.dominantPageIndex(l, 0, 100), 0);
    assert.equal(PF.dominantPageIndex(l, 100, 150), 1);
    assert.equal(PF.dominantPageIndex(l, 300, 100), 3);
  });
  it('bei Gleichstand gewinnt die oberste sichtbare Seite', () => {
    // Zwei Seiten vollstaendig sichtbar, exakt gleich viel -> die obere.
    assert.equal(PF.dominantPageIndex(layout(5, 100, 0), 0, 200), 0);
  });
  it('leerer Stack -> -1', () => {
    assert.equal(PF.dominantPageIndex(PF.buildLayout([]), 0, 100), -1);
  });
});

describe('pageflow/offsetForPage', () => {
  it('holt eine Seite an die Fokuslinie', () => {
    const l = layout(5, 100, 20); // tops 0,120,240,360,480 – height 580
    const v = 200;               // maxScroll 380 -> Seite 3 ist erreichbar
    assert.equal(PF.offsetForPage(l, 3, v, 12), 348);
    assert.equal(PF.offsetForPage(l, 0, v, 12), 0);
  });
  it('klemmt am unteren Rand', () => {
    const l = layout(5, 100, 0); // height 500, view 300 -> max 200
    assert.equal(PF.offsetForPage(l, 4, 300, 12), 200);
  });
  it('Index ausserhalb -> 0 statt NaN', () => {
    const l = layout(3, 100, 0);
    assert.equal(PF.offsetForPage(l, 99, 300, 12), 0);
    assert.equal(PF.offsetForPage(l, -1, 300, 12), 0);
  });
  it('Runde Fahrt: jede erreichbare Seite landet wieder auf sich selbst', () => {
    const l = layout(12, 100, 18);
    const viewH = 400;
    const maxTop = PF.maxScrollOf(l, viewH);
    for (let i = 0; i < 12; i++) {
      const want = Math.max(0, l.tops[i] - 12); // auch Seite 0 wird geklemmt
      if (want > maxTop) continue; // vom Rand geklemmt -> nicht pruefbar
      const top = PF.offsetForPage(l, i, viewH, 12);
      assert.equal(top, want, 'Offset Seite ' + i);
      assert.equal(PF.pageFromScroll(l, top, viewH, 12), i, 'Seite ' + i);
    }
  });
  it('Runde Fahrt: geklemmte Randseite meldet die letzte Seite', () => {
    // Sichtbereich 400, Stack 1398: ganz unten sieht man die Seiten 9-12,
    // die oberste davon (9) ist kaum sichtbar -> aktiv ist Seite 12.
    const l = layout(12, 100, 18);
    const viewH = 400;
    const last = PF.offsetForPage(l, 11, viewH, 12);
    assert.equal(last, PF.maxScrollOf(l, viewH));
    assert.equal(PF.pageFromScroll(l, last, viewH, 12), 11);
  });
  it('passt alles auf einen Blick, bleibt Seite 0 aktiv', () => {
    const l = layout(3, 100, 0);
    assert.equal(PF.maxScrollOf(l, 900), 0);
    assert.equal(PF.pageFromScroll(l, 0, 900, 12), 0);
  });
});

describe('pageflow/neighborIndex', () => {
  it('ohne Wrap, null an den Raendern', () => {
    assert.equal(PF.neighborIndex(0, -1, 5), null);
    assert.equal(PF.neighborIndex(4, 1, 5), null);
    assert.equal(PF.neighborIndex(0, 1, 5), 1);
    assert.equal(PF.neighborIndex(4, -1, 5), 3);
  });
  it('ungueltige Eingaben -> null', () => {
    assert.equal(PF.neighborIndex(-1, 1, 5), null);
    assert.equal(PF.neighborIndex(2, 0, 5), null);
    assert.equal(PF.neighborIndex(2, 1, 0), null);
  });
});
