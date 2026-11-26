'use strict';
const { describe, it } = require('node:test');
const assert = require('node:assert/strict');
const fs = require('node:fs');
const path = require('node:path');

const FL = require('../js/learn.js');
const SRC = fs.readFileSync(path.join(__dirname, '..', 'js', 'learn.js'), 'utf8');

describe('lernen/datei', () => {
  it('exportiert die vereinbarte API', () => {
    for (const k of ['topicsFor', 'resourcesFor', 'buildMission', 'stepXp',
      'levelFromXp', 'levelTitleFor', 'levelProgress', 'dayKey', 'createStats',
      'completeMission', 'streakAfter', 'getStats', 'saveStats', 'resetStats']) {
      assert.equal(typeof FL[k], 'function', k);
    }
    assert.equal(Array.isArray(FL.SUBJECTS), true);
  });
  it('exponiert ueber window.FederwerkLearn', () => {
    assert.equal(typeof global.window, 'undefined');
  });
});

describe('lernen/fach-und-topics', () => {
  it('hat vier Fächer', () => {
    assert.equal(FL.SUBJECTS.length, 4);
    const ids = FL.SUBJECTS.map((s) => s.id);
    for (const want of ['physik', 'mathe', 'chemie', 'informatik']) {
      assert.ok(ids.indexOf(want) >= 0, 'fehlendes Fach: ' + want);
    }
  });
  it('jeweils mindestens ein Thema pro Fach', () => {
    FL.SUBJECTS.forEach((s) => {
      assert.ok(Array.isArray(s.topics) && s.topics.length >= 1, s.id + ' hat keine Themen');
      s.topics.forEach((t) => assert.ok(t.id && t.title && Array.isArray(t.resources) && t.questions, s.id + '/' + t.id));
    });
  });
  it('themenFor und resourcesFor sind durchsuchbar', () => {
    assert.equal(FL.topicsFor('mathe').length, 2);
    assert.equal(FL.topicsFor('federfrei').length, 0);
    const res = FL.resourcesFor('newtonsches-gesetz');
    assert.ok(res.length >= 1);
    assert.ok(String(res[0].url).indexOf('http') === 0);
  });
});

describe('lernen/quiz', () => {
  it('buildMission erzeugt Aufgaben aller drei Typen', () => {
    const topics = FL.SUBJECTS.flatMap((s) => s.topics);
    let sawMc = false, sawCloze = false, sawMatch = false;
    topics.forEach((t) => {
      const m = FL.buildMission(t, () => 0.5);
      assert.ok(Array.isArray(m.steps) && m.steps.length > 0);
      m.steps.forEach((s) => {
        assert.ok(['mc', 'cloze', 'match'].indexOf(s.type) >= 0, 'unbekannter Typ ' + s.type);
        if (s.type === 'mc') sawMc = true;
        if (s.type === 'cloze') sawCloze = true;
        if (s.type === 'match') sawMatch = true;
        if (s.type === 'mc') {
          assert.ok(Array.isArray(s.question.options) && s.question.options.length >= 2);
          assert.ok(s.question.options.indexOf(s.question.answer) >= 0, 'Antwort nicht in Optionen');
        }
        if (s.type === 'cloze') {
          assert.ok(Array.isArray(s.question.options) && s.question.options.length >= 2);
          assert.ok(s.question.options.indexOf(s.question.answer) >= 0, 'Antwort nicht in Optionen');
        }
        if (s.type === 'match') {
          assert.ok(Array.isArray(s.question.pairs) && s.question.pairs.length >= 1);
          s.question.pairs.forEach((p) => assert.ok(p.left && p.right));
        }
      });
    });
    assert.ok(sawMc && sawCloze && sawMatch, 'Mission muss MC, Zuordnung und Lückentext enthalten');
  });
});

describe('lernen/gamification', () => {
  it('levelFromXp / levelProgress', () => {
    assert.equal(FL.levelFromXp(0), 1);
    assert.equal(FL.levelFromXp(99), 1);
    assert.equal(FL.levelFromXp(100), 2);
    assert.equal(FL.levelFromXp(399), 2);
    assert.equal(FL.levelFromXp(400), 3);
    const lp = FL.levelProgress(150);
    assert.equal(lp.level, 2);
    assert.ok(lp.xp >= 100 && lp.xp < 400);
  });
  it('dayKey ist lokales YYYY-MM-DD', () => {
    const k = FL.dayKey(new Date(2026, 10, 26));
    assert.equal(k, '2026-11-26');
  });
  it('streakAfter: gleicher Tag / gestriger Tag / Reset', () => {
    const today = new Date();
    assert.equal(FL.streakAfter({ streak: 3, lastDay: FL.dayKey(today) }, today).streak, 3);
    const yest = new Date(Date.now() - 24 * 60 * 60 * 1000);
    assert.equal(FL.streakAfter({ streak: 3, lastDay: FL.dayKey(yest) }, today).streak, 4);
    const older = new Date(Date.now() - 5 * 24 * 60 * 60 * 1000);
    assert.equal(FL.streakAfter({ streak: 3, lastDay: FL.dayKey(older) }, today).streak, 1);
  });
  it('completeMission addiert XP und zaehlt Missionen', () => {
    const before = FL.createStats();
    const after = FL.completeMission(before, { xp: 25, correct: 2, answered: 2 });
    assert.equal(after.xp, 25);
    assert.equal(after.missionsDone, 1);
    assert.equal(after.correct, 2);
    assert.equal(after.answered, 2);
    assert.equal(after.level, FL.levelFromXp(25));
  });
  it('stepXp vergibt XP nur bei richtigem Halten', () => {
    const st = { type: 'mc', question: { options: ['a', 'b'], answer: 'b' } };
    assert.equal(FL.stepXp(st, true), 10);
    assert.equal(FL.stepXp(st, false), 0);
    const mst = { type: 'match', question: { pairs: [{ left: 'x', right: 'y' }, { left: 'a', right: 'b' }] } };
    assert.equal(FL.stepXp(mst, true), 10);
    assert.equal(FL.stepXp(mst, false), 0);
  });
});

describe('lernen/quelltext', () => {
  it('enthält die Lern-Phasen-Flaeche', () => {
    assert.ok(SRC.indexOf('learnOverlay') >= 0);
    assert.ok(SRC.indexOf('federwerkLearnPickSubject') >= 0);
  });
});
