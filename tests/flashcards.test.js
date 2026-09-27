'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FC = require('../js/flashcards.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'flashcards.js'), 'utf8');
const T0 = 1700000000000;
const DAY = 24 * 60 * 60 * 1000;

function deckWith(cards) {
  return FC.ensureDeck({ id: 'd1', title: 'Deck', pages: [{ id: 'p1', strokes: [], texts: [], images: [], bg: null }], cards }, T0);
}

describe('flashcards/datei', () => {
  it('ist ohne DOM ladbar (rein, kein Browser-Zugriff)', () => {
    assert.ok(FC && typeof FC.gradeCard === 'function');
    assert.ok(!/\bdocument\b/.test(SRC), 'kein document');
    assert.ok(!/\blocalStorage\b/.test(SRC), 'kein localStorage');
    assert.ok(!/\bindexedDB\b/.test(SRC), 'kein indexedDB');
    assert.ok(!/\balert\b/.test(SRC), 'kein alert');
  });
  it('exportiert die vereinbarte API', () => {
    for (const k of ['newCard', 'normalizeCard', 'ensureDeck', 'gradeCard',
      'previewIntervals', 'formatInterval', 'isDue', 'dueCards', 'newCards',
      'buildSession', 'deckStats', 'forecastDue', 'cardText', 'deckText',
      'parseCardCsv', 'cardToCsvRow', 'isDeck']) {
      assert.equal(typeof FC[k], 'function', k);
    }
  });
});

describe('flashcards/modell', () => {
  it('newCard setzt SM-2-Defaults', () => {
    const c = FC.newCard('a', 'b', T0);
    assert.equal(c.front, 'a');
    assert.equal(c.back, 'b');
    assert.equal(c.ease, 2.5);
    assert.equal(c.interval, 0);
    assert.equal(c.reps, 0);
    assert.equal(c.due, T0);
    assert.equal(c.lastReview, null);
  });
  it('normalizeCard heilt kaputte Karten tolerant', () => {
    const c = FC.normalizeCard({ front: 42, ease: 99, interval: -5 }, T0);
    assert.equal(typeof c.id, 'string');
    assert.equal(c.front, '42');
    assert.equal(c.ease, 2.8);
    assert.equal(c.interval, 0);
  });
  it('isDeck erkennt nur flashcards (legacy ohne kind = Notizbuch)', () => {
    assert.equal(FC.isDeck({ kind: 'flashcards' }), true);
    assert.equal(FC.isDeck({}), false);
    assert.equal(FC.isDeck(null), false);
  });
  it('ensureDeck heilt Buch + Karten + Limits', () => {
    const b = FC.ensureDeck({ id: 'x', title: 'D', cards: [{ front: 'f', back: 'b' }], deckOptions: { newPerDay: 9999 } }, T0);
    assert.equal(b.kind, 'flashcards');
    assert.ok(Array.isArray(b.pages) && b.pages.length >= 1);
    assert.equal(b.cards.length, 1);
    assert.ok(b.deckOptions.newPerDay <= 500);
  });
});

describe('flashcards/sm2', () => {
  it('gut-Folge: 1 Tag, dann 6 Tage, dann prev*ease', () => {
    const c = FC.newCard('f', 'b', T0);
    FC.gradeCard(c, 'good', T0);
    assert.equal(c.interval, 1);
    assert.equal(c.reps, 1);
    assert.equal(c.due, T0 + DAY);
    FC.gradeCard(c, 'good', T0 + DAY);
    assert.equal(c.interval, 6);
    assert.equal(c.reps, 2);
    const ease = c.ease;
    FC.gradeCard(c, 'good', T0 + 7 * DAY);
    assert.equal(c.interval, Math.round(6 * ease));
    assert.equal(c.reps, 3);
  });
  it('leicht startet mit 4 Tagen; hart skaliert mit prev*1.2', () => {
    const c = FC.newCard('f', 'b', T0);
    FC.gradeCard(c, 'easy', T0);
    assert.equal(c.interval, 4);
    const d = FC.newCard('f', 'b', T0);
    FC.gradeCard(d, 'good', T0);
    FC.gradeCard(d, 'good', T0 + DAY);
    assert.equal(d.interval, 6);
    FC.gradeCard(d, 'hard', T0 + 7 * DAY);
    assert.equal(d.interval, Math.round(6 * 1.2));
  });
  it('nochmal setzt zurück, zählt lapses, fällig in 10 Minuten', () => {
    const c = FC.newCard('f', 'b', T0);
    FC.gradeCard(c, 'good', T0);
    FC.gradeCard(c, 'again', T0 + DAY);
    assert.equal(c.reps, 0);
    assert.equal(c.lapses, 1);
    assert.equal(c.interval, 0);
    assert.equal(c.due, T0 + DAY + 10 * 60 * 1000);
    assert.equal(c.totalReviews, 2);
    assert.equal(c.correctReviews, 1);
  });
  it('ease folgt SM-2 und ist geclampt', () => {
    assert.equal(FC.easeAfter(2.5, 5), 2.6);
    assert.equal(FC.easeAfter(2.5, 4), 2.5);
    assert.ok(FC.easeAfter(2.5, 3) < 2.5);
    assert.equal(FC.easeAfter(2.5, 0), 2.5);
    assert.equal(FC.easeAfter(99, 5), 2.8);
    assert.equal(FC.easeAfter(-5, 3), 1.3);
  });
  it('unbekanntes grade -> null ohne Mutation', () => {
    const c = FC.newCard('f', 'b', T0);
    assert.equal(FC.gradeCard(c, 'hmm', T0), null);
    assert.equal(c.totalReviews, 0);
  });
  it('preview + format liefern UI-Labels', () => {
    const c = FC.newCard('f', 'b', T0);
    const p = FC.previewIntervals(c);
    assert.deepEqual(p, { again: 0, hard: 1, good: 1, easy: 4 });
    assert.equal(FC.formatInterval(0), '<10m');
    assert.equal(FC.formatInterval(1), '1d');
    assert.equal(FC.formatInterval(60), '2mo');
  });
});

describe('flashcards/queue-stats', () => {
  it('dueCards sortiert nach Fälligkeit, suspended nie', () => {
    const b = deckWith([
      { ...FC.newCard('a', '1', T0 - 2 * DAY), due: T0 - 2 * DAY },
      { ...FC.newCard('b', '2', T0 - DAY), due: T0 - DAY, suspended: true },
      { ...FC.newCard('c', '3', T0 - 3 * DAY), due: T0 - 3 * DAY },
    ]);
    const due = FC.dueCards(b, T0);
    assert.deepEqual(due.map((c) => c.front), ['c', 'a']);
  });
  it('buildSession: Fällige zuerst, Neue bis Limit', () => {
    const cards = [];
    for (let i = 0; i < 5; i++) {
      const c = FC.newCard('neu' + i, 'x', T0);
      cards.push(c);
    }
    const old = FC.newCard('alt', 'x', T0 - 10 * DAY);
    FC.gradeCard(old, 'good', T0 - 5 * DAY);
    old.due = T0 - DAY; // überfällig
    cards.push(old);
    const b = deckWith(cards);
    const s = FC.buildSession(b, { now: T0, newPerDay: 2, maxReviewsPerDay: 10 });
    assert.equal(s[0].front, 'alt');
    assert.equal(s.length, 3);
  });
  it('deckStats zählt neu/fällig/gelernt + Retention', () => {
    const fresh = FC.newCard('n', 'x', T0);
    const learned = FC.newCard('l', 'x', T0 - 5 * DAY);
    FC.gradeCard(learned, 'good', T0 - 5 * DAY);
    learned.due = T0 + DAY;
    const b = deckWith([fresh, learned]);
    const s = FC.deckStats(b, T0);
    assert.equal(s.total, 2);
    assert.equal(s.fresh, 1);
    assert.equal(s.learned, 1);
    assert.equal(s.due, 1);
    assert.equal(s.retention, 100);
  });
  it('forecastDue verteilt auf Tage (0 = heute/überfällig)', () => {
    const a = FC.newCard('a', 'x', T0); a.due = T0 - DAY;
    const b2 = FC.newCard('b', 'x', T0); b2.due = T0 + DAY + 1000;
    const b = deckWith([a, b2]);
    const f = FC.forecastDue(b, 3, T0);
    assert.equal(f[0], 1);
    assert.equal(f[2], 1);
  });
});

describe('flashcards/text-csv', () => {
  it('cardText strippt HTML', () => {
    assert.equal(FC.cardText({ front: '<b>Hallo</b>', back: '<p>Welt</p>' }), 'Hallo\nWelt');
  });
  it('parseCardCsv liest ; und Quotes', () => {
    const rows = FC.parseCardCsv('a;b\n"mit; drin";hinten\nleer;\n');
    assert.deepEqual(rows, [
      { front: 'a', back: 'b' },
      { front: 'mit; drin', back: 'hinten' },
      { front: 'leer', back: '' },
    ]);
  });
  it('cardToCsvRow quotet bei Bedarf', () => {
    assert.equal(FC.cardToCsvRow({ front: 'a;b', back: 'c' }), '"a;b";c');
  });
});

describe('flashcards/auswertung', () => {
  it('maturity stuft neu/lernend/jung/reif ein', () => {
    assert.equal(FC.maturity(FC.newCard('f', 'b', T0)), 'new');
    const l = FC.newCard('f', 'b', T0);
    FC.gradeCard(l, 'good', T0);
    assert.equal(FC.maturity(l), 'learning');
    FC.gradeCard(l, 'good', T0 + DAY);
    assert.equal(FC.maturity(l), 'young');
    l.interval = 21;
    assert.equal(FC.maturity(l), 'mature');
    assert.equal(FC.maturityLabel('mature'), 'Reif');
  });
  it('masteryScore wächst mit Intervall, accuracyOf zählt Quote', () => {
    assert.equal(FC.masteryScore(FC.newCard('f', 'b', T0)), 0);
    assert.equal(FC.masteryScore({ lastReview: T0, interval: 30 }), 100);
    assert.equal(FC.accuracyOf({ totalReviews: 4, correctReviews: 3 }), 75);
    assert.equal(FC.accuracyOf({ totalReviews: 0, correctReviews: 0 }), null);
  });
  it('leeches findet schwierige Karten (lapses oder Ease-Minimum)', () => {
    const ok = FC.newCard('ok', 'x', T0);
    const bad = FC.newCard('bad', 'x', T0);
    bad.lapses = 5;
    const hard = FC.newCard('hard', 'x', T0);
    hard.ease = 1.3;
    const b = deckWith([ok, bad, hard]);
    const l = FC.leeches(b);
    assert.equal(l.length, 2);
    assert.equal(l[0].front, 'bad');
  });
  it('logReview + gradeAndLog schreiben Verlauf (gedeckelt, tolerant)', () => {
    const b = deckWith([FC.newCard('f', 'b', T0)]);
    const c = b.cards[0];
    assert.ok(FC.gradeAndLog(b, c.id, 'good', T0));
    assert.equal(b.reviewLog.length, 1);
    assert.deepEqual([b.reviewLog[0].g, typeof b.reviewLog[0].t], ['good', 'number']);
    assert.equal(FC.gradeAndLog(b, 'falsch', 'good', T0), null);
    assert.equal(FC.logReview(b, c.id, 'hmm', T0), false);
    assert.deepEqual(FC.ensureDeck({ cards: 'kaputt' }).reviewLog, []);
  });
  it('activityByDay + currentStreak zählen Tage korrekt', () => {
    const b = deckWith([FC.newCard('f', 'b', T0)]);
    const c = b.cards[0];
    FC.gradeAndLog(b, c.id, 'good', T0 - 2 * DAY);
    FC.gradeAndLog(b, c.id, 'again', T0 - 2 * DAY);
    FC.gradeAndLog(b, c.id, 'good', T0);
    const act = FC.activityByDay(b, 3, T0);
    assert.equal(act.length, 3);
    assert.equal(act[0].total, 2);
    assert.equal(act[0].correct, 1);
    assert.equal(act[2].total, 1);
    assert.equal(FC.currentStreak(b, T0), 1);
    assert.equal(FC.currentStreak({ reviewLog: [] }, T0), 0);
  });
  it('deckStats liefert Reife-Verteilung, Streak und Tageswerte', () => {
    const fresh = FC.newCard('n', 'x', T0);
    const learned = FC.newCard('l', 'x', T0 - 5 * DAY);
    FC.gradeCard(learned, 'good', T0 - 5 * DAY);
    const b = deckWith([fresh, learned]);
    FC.gradeAndLog(b, learned.id, 'good', T0);
    const s = FC.deckStats(b, T0);
    assert.equal(s.maturity.new, 1);
    assert.equal(s.streak, 1);
    assert.equal(s.todayReviews, 1);
    assert.equal(s.todayAccuracy, 100);
    assert.ok(s.weekReviews >= 1);
  });
  it('formatDue formuliert Fälligkeiten lesbar', () => {
    assert.equal(FC.formatDue(T0, T0), 'heute fällig');
    assert.equal(FC.formatDue(T0 + DAY, T0), 'morgen fällig');
    assert.equal(FC.formatDue(T0 + 3 * DAY, T0), 'in 3 Tagen fällig');
    assert.equal(FC.formatDue(T0 - DAY, T0), 'seit 1 Tag überfällig');
    assert.equal(FC.formatDue(T0 - 5 * DAY, T0), 'seit 5 Tagen überfällig');
  });
});
