/* Federwerk – Lernen-Missionsmodul (Web-Frontend).
 *
 * "Lernen"-Tab: Fach-Auswahl → Thema eingeben (vorschlagsbasierte Ressourcen) →
 * Mission starten (Duolingo-Style-Quiz) → Fortschritt speichern (PocketBase).
 *
 * - Fach: Physik, Mathe, Chemie, Informatik.
 * - Thema: passende Videos/Webseiten werden vorgeschlagen (mit Thumbnails/Links).
 * - Quiz: Multiple Choice, Zuordnung (Paare matchen), Lückentext.
 * - Gamification: XP, Level, Streak.
 * - Fortschritt: localStorage (Fallback) + window.FederwerkApi (PocketBase-Backend
 *   ueber /api/learn/progress, siehe api/index.js Worker).
 *
 * Das Datenmodell (Subjects/Themen/Fragen/XP/Level/Streak) ist rein und fuer
 * Unit-Tests ohne DOM nutzbar; die Phasen-Rendering-Funktionen halten sich an
 * Id-Strings und helper zum DOM.
 */
(function () {
  'use strict';

  var XP_CORRECT = { mc: 10, cloze: 10, match: 5 };
  var BONUS_ALL_STEPS = 20;

  /* ==================== Gamification: XP / Level / Streak ==================== */

  function levelFromXp(xp) {
    var p = Number(xp) || 0;
    var level = 1;
    var l = 2;
    while (l <= 60) {
      var entry = 100 * (l - 1) * (l - 1); // XP-Einstiegshoehe fuer Stufe l
      if (p >= entry) { level = l; l = l + 1; } else { break; }
    }
    return level;
  }
  function levelTitleFor(level) {
    var t = ['Starter', 'Anfaenger', 'Sicher', 'Fortgeschritten', 'Experte', 'Meister', 'Legende'];
    var i = Math.max(0, Math.min(t.length - 1, (Number(level) || 1) - 1));
    return t[i];
  }
  function levelProgress(xp) {
    var level = levelFromXp(xp);
    var cur = 100 * (level - 1) * (level - 1);
    var next = 100 * level * level;
    var into = (Number(xp) || 0) - cur;
    var span = Math.max(1, next - cur);
    return { level: level, title: levelTitleFor(level), xp: Number(xp) || 0, into: into, span: span, pct: Math.round((into / span) * 100) };
  }
  function dayKey(d) {
    var dt = d instanceof Date ? d : new Date(d);
    var m = String(dt.getMonth() + 1);
    if (m.length < 2) m = '0' + m;
    var day = String(dt.getDate());
    if (day.length < 2) day = '0' + day;
    return dt.getFullYear() + '-' + m + '-' + day;
  }
  function yesterdayKey() { return dayKey(new Date(Date.now() - 24 * 60 * 60 * 1000)); }

  function createStats() {
    return { xp: 0, level: 1, title: 'Anfaenger', streak: 0, lastDay: '', missionsDone: 0, correct: 0, answered: 0 };
  }
  function streakAfter(stats, today) {
    var s = Object.assign({}, stats || createStats());
    var key = dayKey(today);
    var last = String(s.lastDay || '');
    var streak = Number(s.streak) || 0;
    if (last === key) { return s; }
    streak = (last === yesterdayKey()) ? (streak + 1) : 1;
    s.streak = streak;
    s.lastDay = key;
    return s;
  }
  function completeMission(stats, result) {
    var s = Object.assign({}, stats || createStats());
    var r = result || {};
    var next = streakAfter(s, new Date());
    next.xp = (Number(s.xp) || 0) + (Number(r.xp) || 0);
    next.missionsDone = (Number(s.missionsDone) || 0) + 1;
    next.correct = (Number(s.correct) || 0) + (Number(r.correct) || 0);
    next.answered = (Number(s.answered) || 0) + (Number(r.answered) || 0);
    next.level = levelFromXp(next.xp);
    next.title = levelTitleFor(next.level);
    return next;
  }

  /* ==================== Content: Faecher, Themen, Fragen ==================== */

  var SUBJECTS = [
    {
      id: 'physik', label: 'Physik', icon: '⚛️', color: '#3b82f6',
      blurb: 'Mechanik · Energie · Elektrizität · Optik',
      topics: [
        {
          id: 'newtonsches-gesetz', subjectId: 'physik', subjectLabel: 'Physik',
          title: 'Newtonsche Gesetze', subtitle: 'Mechanik',
          resources: [
            { type: 'video', title: 'Newtonsche Gesetze – einfach erklärt', url: 'https://www.youtube.com/results?search_query=Newtonsche+Gesetze+Physik', thumb: '', duration: '' },
            { type: 'website', title: 'Wikipedia: Newtonsches Gesetz / Mechanik', url: 'https://de.wikipedia.org/wiki/Newtonsches_Gesetz', thumb: '', duration: '' },
          ],
          questions: {
            mc: [
              { q: 'Welche Einheit beschreibt Kraft?', options: ['Newton (N)', 'Joule (J)', 'Watt (W)', 'Pascal (Pa)'], answer: 'Newton (N)', explain: 'Kraft wird in Newton (N) angegeben, Energie in Joule (J).' },
              { q: 'Das 2. Newtonsche Gesetz lautet …', options: ['F = m · a', 'F = m · Δv', 'a = F · m', 'F = m · g'], answer: 'F = m · a', explain: 'F = m · a: Die Kraft ist die Masse mal der Beschleunigung. Δv = a · Δt.' },
              { q: 'Was gilt laut 1. Newtonschem Gesetz?', options: ['Körper mit großer Masse sind schwerer', 'Ohne äußere Kraft ändert sich die Geschwindigkeit nicht', 'Beschleunigung benötigt Energie', 'Masse erzeugt eine Kraft'], answer: 'Ohne äußere Kraft ändert sich die Geschwindigkeit nicht', explain: 'Inertialmasse: Erst eine äußere Kraft erzeugt eine Änderung der Geschwindigkeit.' },
            ],
            match: [
              { pairs: [ { left: 'Kraft', right: 'F = m · a' }, { left: 'Masse', right: 'Trägheitsmaß' }, { left: 'Geschwindigkeit', right: 'gemessen in m/s' } ] },
            ],
            cloze: [
              { sentence: 'Das 2. Newtonsche Gesetz: Kraft = Masse × ___', options: ['Beschleunigung (a)', 'Geschwindigkeit (v)', 'Energie (E)'], answer: 'Beschleunigung (a)', explain: 'F = m · a – je größer die Masse oder die Beschleunigung, desto größer die Kraft.' },
            ],
          },
        },
        {
          id: 'energie', subjectId: 'physik', subjectLabel: 'Physik',
          title: 'Energie & Erhaltung', subtitle: 'Physiktheorie',
          resources: [
            { type: 'video', title: 'Energieerhaltung – so funktioniert sie', url: 'https://www.youtube.com/results?search_query=Energieerhaltung+Physik', thumb: '', duration: '' },
            { type: 'website', title: 'Wikipedia: Energie', url: 'https://de.wikipedia.org/wiki/Energie', thumb: '', duration: '' },
          ],
          questions: {
            mc: [
              { q: 'Die Einheit der Energie ist …', options: ['Joule (J)', 'Newton (N)', 'Watt (W)', 'Pascal (Pa)'], answer: 'Joule (J)', explain: 'Arbeit und Energie werden in Joule (J) angegeben.' },
              { q: 'Das Arbeits-Energie-Theorem besagt …', options: ['ΔE = W_net', 'E = m · c²', 'F = m · g', 'p = m · v'], answer: 'ΔE = W_net', explain: 'Die zugefasste netto Arbeit entspricht der Änderung der Energie: ΔE = W_net.' },
            ],
            match: [
              { pairs: [ { left: 'Energie', right: 'bleibt erhalten' }, { left: 'Leistung', right: 'P = ΔE / Δt' }, { left: 'Arbeit', right: 'Energieübertragung' } ] },
            ],
            cloze: [
              { sentence: 'Energie wird weder ___ noch vernichtet, sie wandelt sich nur um.', options: ['erschaffen', 'verbraucht', 'umwandelt sich'], answer: 'umwandelt sich', explain: 'Erhaltung der Energie: Die Gesamtenergie bleibt in einem abgeschlossenen System konstant.' },
            ],
          },
        },
      ],
    },
    {
      id: 'mathe', label: 'Mathe', icon: '🔢', color: '#f59e0b',
      blurb: 'Algebra · Analysis · Geometrie · Zahlen',
      topics: [
        {
          id: 'potenzfunktionen', subjectId: 'mathe', subjectLabel: 'Mathe',
          title: 'Potenzfunktionen & Wurzeln', subtitle: 'Algebra',
          resources: [
            { type: 'video', title: 'Potenzfunktionen und Wurzeln', url: 'https://www.youtube.com/results?search_query=Potenzfunktionen+Wurzeln+Mathe', thumb: '', duration: '' },
            { type: 'website', title: 'Wikipedia: Potenz (Mathematik)', url: 'https://de.wikipedia.org/wiki/Potenz_(Mathematik)', thumb: '', duration: '' },
          ],
          questions: {
            mc: [
              { q: 'Die Quadratwurzel aus 144 ist …', options: ['12', '14', '144', '24'], answer: '12', explain: '√144 = 12, denn 12 · 12 = 144.' },
              { q: '(a · b)ⁿ = aⁿ · bⁿ nennt man …', options: ['Potenzgesetz', 'Quadratwurzel', 'Termvorschrift', 'Nullsummenregel'], answer: 'Potenzgesetz', explain: 'Potenzgesetz: (a·b)ⁿ = aⁿ·bⁿ.' },
            ],
            match: [
              { pairs: [ { left: 'Potenz', right: 'xⁿ' }, { left: 'Wurzel', right: '√x' }, { left: 'Potenzgesetz', right: '(ab)ⁿ = aⁿbⁿ' } ] },
            ],
            cloze: [
              { sentence: 'Für x² = 9 gilt: x = ___.', options: ['3', '9', '√9'], answer: '3', explain: 'Quadratwurzel: x² = 9 → x = ±3.' },
            ],
          },
        },
        {
          id: 'ableitung', subjectId: 'mathe', subjectLabel: 'Mathe',
          title: 'Ableitung (Analysis)', subtitle: 'Analysis',
          resources: [
            { type: 'video', title: 'Die Ableitung einfach erklärt', url: 'https://www.youtube.com/results?search_query=Ableitung+Mathe+erklaert', thumb: '', duration: '' },
            { type: 'website', title: 'Wikipedia: Ableitung', url: 'https://de.wikipedia.org/wiki/Ableitung', thumb: '', duration: '' },
          ],
          questions: {
            mc: [
              { q: 'Die Ableitung von f(x) = x² ist …', options: ['2x', 'x² / 2', '2x²', 'x'], answer: '2x', explain: 'f′(x) = lim (x+h)² − x² / h = 2x.' },
              { q: 'Die Ableitung beschreibt …', options: ['die Kurvenänderung (Steigung)', 'die Fläche unter der Kurve', 'die Nullstelle', 'den y-Achsenabschnitt'], answer: 'die Kurvenänderung (Steigung)', explain: 'Die Ableitung ist der Differentialquotient: lokale Steigung der Funktion.' },
            ],
            match: [
              { pairs: [ { left: 'Ableitung', right: 'Differenzenquotient' }, { left: 'Steigung', right: 'Ableitung an x' } ] },
            ],
            cloze: [
              { sentence: 'Die erste Ableitung von f(x) = ___ ergibt die Steigung der Funktion.', options: ['x²', '2x', 'x³'], answer: 'x²', explain: 'f′(x) = 2x ist die Steigung der Parabel.' },
            ],
          },
        },
      ],
    },
    {
      id: 'chemie', label: 'Chemie', icon: '🧪', color: '#10b981',
      blurb: 'Periodensystem · Reaktionen · Trends',
      topics: [
        {
          id: 'periodensystem', subjectId: 'chemie', subjectLabel: 'Chemie',
          title: 'Periodensystem & Elemente', subtitle: 'Elemente',
          resources: [
            { type: 'video', title: 'Das Periodensystem einfach erklärt', url: 'https://www.youtube.com/results?search_query=Periodensystem+Chemie+erklaert', thumb: '', duration: '' },
            { type: 'website', title: 'Wikipedia: Periodensystem', url: 'https://de.wikipedia.org/wiki/Periodensystem', thumb: '', duration: '' },
          ],
          questions: {
            mc: [
              { q: 'Welche Ordnungszahl gehört zu Kohlenstoff (C)?', options: ['6', '12', '16', '8'], answer: '6', explain: 'Ordnungszahl = Anzahl der Protonen im Atomkern.' },
              { q: 'Welches Element hat die Ordnungszahl 79?', options: ['Gold (Au)', 'Silber (Ag)', 'Platin (Pt)', 'Blei (Pb)'], answer: 'Gold (Au)', explain: 'Ordnungszahl 79 = Gold.' },
            ],
            match: [
              { pairs: [ { left: 'Helium', right: 'Ordnungszahl 2' }, { left: 'Wasserstoff', right: 'Ordnungszahl 1' }, { left: 'Kohlenstoff', right: 'Ordnungszahl 6' } ] },
            ],
            cloze: [
              { sentence: 'Die Ordnungszahl eines Elements entspricht der Anzahl der Protonen im ___.', options: ['Atomkern', 'Elektronenhülle'], answer: 'Atomkern', explain: 'Ordnungszahl = Kernladungszahl = Protonenzahl.' },
            ],
          },
        },
        {
          id: 'reaktionen', subjectId: 'chemie', subjectLabel: 'Chemie',
          title: 'Chemische Reaktionen', subtitle: 'Reaktionschemie',
          resources: [
            { type: 'video', title: 'Chemische Reaktionen – Grundlagen', url: 'https://www.youtube.com/results?search_query=Chemische+Reaktionen+Grundlagen', thumb: '', duration: '' },
            { type: 'website', title: 'Wikipedia: Chemische Reaktion', url: 'https://de.wikipedia.org/wiki/Chemische_Reaktion', thumb: '', duration: '' },
          ],
          questions: {
            mc: [
              { q: 'Welches Gesetz gilt in jeder chemischen Reaktion?', options: ['Erhaltung der Masse', 'Erhaltung der Entropie', 'Gleichung der Ströme', 'Gesetz der Äquivalenz'], answer: 'Erhaltung der Masse', explain: 'Die Masse wird weder erzeugt noch vernichtet – sie bleibt erhalten.' },
            ],
            match: [
              { pairs: [ { left: 'Reaktionsgleichung', right: 'Reaktanten + Produkte' }, { left: 'Katalysator', right: 'beschleunigt, bleibt selbst unverändert' } ] },
            ],
            cloze: [
              { sentence: 'Bei einer chemischen Reaktion verändern sich ___ und Produkte.', options: ['Stoffe', 'Nur Energie'], answer: 'Stoffe', explain: 'Stoffe werden in andere umgewandelt; Energie bleibt in Summe erhalten.' },
            ],
          },
        },
      ],
    },
    {
      id: 'informatik', label: 'Informatik', icon: '💻', color: '#8b5cf6',
      blurb: 'Algorithmen · Datenstrukturen · Netzwerke',
      topics: [
        {
          id: 'algorithmus', subjectId: 'informatik', subjectLabel: 'Informatik',
          title: 'Algorithmen & Komplexität', subtitle: 'Algorithmik',
          resources: [
            { type: 'video', title: 'Komplexität (Big O) einfach erklärt', url: 'https://www.youtube.com/results?search_query=Komplexitaet+Big+O+Algorithmus', thumb: '', duration: '' },
            { type: 'website', title: 'Wikipedia: Komplexität', url: 'https://de.wikipedia.org/wiki/Komplexitaet', thumb: '', duration: '' },
          ],
          questions: {
            mc: [
              { q: 'Die Komplexität einer Binärsuche über n Elemente ist …', options: ['O(log n)', 'O(n)', 'O(n²)', 'O(1)'], answer: 'O(log n)', explain: 'Bei Verdopplung der Elemente halbiert sich die Anzahl der Schritte bei Binärsuche.' },
              { q: 'Wie wird eine lineare Suche über n Elemente beschrieben?', options: ['O(n)', 'O(log n)', 'O(1)', 'O(n · log n)'], answer: 'O(n)', explain: 'Lineare Suche: maximal n Prüfungen – einmal durchlaufen.' },
            ],
            match: [
              { pairs: [ { left: 'Binärsuche', right: 'O(log n)' }, { left: 'Lineare Suche', right: 'O(n)' } ] },
            ],
            cloze: [
              { sentence: 'Die effiziente Sortierung großer Datenmengen nutzt oft einen Algorithmus mit Komplexität ___.', options: ['O(n · log n)', 'O(n²)', 'O(1)'], answer: 'O(n · log n)', explain: 'Merge-Sort: lineareithmetische Sortierung O(n log n).' },
            ],
          },
        },
        {
          id: 'datenstrukturen', subjectId: 'informatik', subjectLabel: 'Informatik',
          title: 'Datenstrukturen (Stacks & Queues)', subtitle: 'Datenstrukturen',
          resources: [
            { type: 'video', title: 'Datenstrukturen einfach erklärt', url: 'https://www.youtube.com/results?search_query=Datenstrukturen+Stacks+Queues', thumb: '', duration: '' },
            { type: 'website', title: 'Wikipedia: Datenstruktur', url: 'https://de.wikipedia.org/wiki/Datenstruktur', thumb: '', duration: '' },
          ],
          questions: {
            mc: [
              { q: 'Welches Prinzip beschreibt einen Stack?', options: ['LIFO (Last In, First Out)', 'FIFO (First In, First Out)', 'LRU', 'AVL'], answer: 'LIFO (Last In, First Out)', explain: 'Stack: Das zuletzt hinzugefügte Element wird zuerst wieder entfernt.' },
            ],
            match: [
              { pairs: [ { left: 'Stack', right: 'LIFO' }, { left: 'Queue', right: 'FIFO' } ] },
            ],
            cloze: [
              { sentence: 'In einer ___ werden Elemente am rechten Ende angehängt (Push) und am linken wieder entfernt (Pop).', options: ['Stack', 'Queue', 'Graph'], answer: 'Stack', explain: 'Stack = LIFO.' },
            ],
          },
        },
      ],
    },
  ];

  function allTopics() {
    var out = [];
    SUBJECTS.forEach(function (s) { (s.topics || []).forEach(function (t) { out.push(t); }); });
    return out;
  }
  function topicsFor(subjectId) {
    var s = SUBJECTS.filter(function (x) { return x.id === subjectId; })[0];
    return s ? (s.topics || []) : [];
  }
  function subjectFor(subjectId) {
    return SUBJECTS.filter(function (x) { return x.id === subjectId; })[0] || null;
  }
  function topicFor(topicId) {
    return allTopics().filter(function (t) { return t.id === topicId; })[0] || null;
  }
  function resourcesFor(topicId) {
    var t = topicFor(topicId);
    if (!t) return [];
    var out = (t.resources || []).slice();
    out.forEach(function (r) {
      if (r.type === 'website' && !r.thumb) {
        try {
          var u = String(r.url || '');
          var host = '';
          var m2 = /https?:\/\/([^\/]+)/.exec(u);
          host = m2 ? m2[1] : '';
          var dot = host.indexOf('.');
          host = dot > 0 ? host.slice(dot + 1) : host;
          r.thumb = 'https://www.google.com/s2/favicons?domain=' + encodeURIComponent(host) + '&sz=128';
        } catch (e) { /* ignore */ }
      }
    });
    return out;
  }

  /* ==================== Quiz: Mission bauen ==================== */

  function shuffleArr(arr, rnd) {
    var a = (arr || []).slice();
    var r = (typeof rnd === 'function') ? rnd : Math.random;
    for (var i = a.length - 1; i > 0; i--) {
      var j = Math.floor(r() * (i + 1));
      var tmp = a[i]; a[i] = a[j]; a[j] = tmp;
    }
    return a;
  }
  function buildMission(topic, rnd) {
    var r = (typeof rnd === 'function') ? rnd : Math.random;
    var pick = function (list, n) { return shuffleArr(list || [], r).slice(0, Math.max(0, Math.min(n, (list || []).length))); };
    var steps = [];
    pick(topic.questions && topic.questions.mc, 2).forEach(function (q) { steps.push({ type: 'mc', question: q }); });
    pick(topic.questions && topic.questions.cloze, 2).forEach(function (q) { steps.push({ type: 'cloze', question: q }); });
    pick(topic.questions && topic.questions.match, 1).forEach(function (q) { steps.push({ type: 'match', question: q }); });
    shuffleArr(steps, r);
    return {
      id: 'mission-' + Date.now(),
      subjectId: topic.subjectId || 'physik',
      topicId: topic.id,
      title: (topic.subjectLabel || '') + ' · ' + topic.title,
      steps: steps,
      score: { xp: 0, correctCount: 0, answered: 0 },
    };
  }
  function stepXp(step, correct) {
    if (!step) return 0;
    if (step.type === 'match') {
      if (correct && step.question && Array.isArray(step.question.pairs)) {
        return (step.question.pairs.length || 0) * XP_CORRECT.match;
      }
      return 0;
    }
    return correct ? (XP_CORRECT[step.type] || 10) : 0;
  }

  /* ---------- Backend: Missionen aus der RAG-Pipeline (Fallback: lokaler Katalog) ---------- */

  async function callApi(path, body) {
    try {
      var w = (typeof window !== 'undefined') ? window : {};
      var api = w.FederwerkApi;
      if (api && typeof api.call === 'function') { return await api.call('POST', path, body || {}); }
    } catch (e) { /* Backend nicht erreichbar -> Fallback unten */ }
    return null;
  }
  function missionFromRemote(m) {
    if (!m) return null;
    var t = String(m.type || '');
    if (t === 'quiz') {
      var options = (Array.isArray(m.options) ? m.options : []).map(function (o) { return String(o); }).filter(function (o) { return o; });
      var answer = String(m.correctAnswer || '');
      if (!answer && Array.isArray(m.options)) { var ci = Number(m.correctIndex); if (Number.isInteger(ci) && m.options[ci] != null) answer = String(m.options[ci]); }
      if (!answer) return null;
      var opts = options.length ? options : [answer];
      return { type: 'mc', question: String(m.question || ''), options: opts, answer: answer, explain: String(m.explanation || m.instruction || '') };
    }
    if (t === 'zuordnung') {
      var pairs = [];
      (Array.isArray(m.pairs) ? m.pairs : []).forEach(function (p) { var l = String((p && p.left) || ''); var r = String((p && p.right) || ''); if (l && r) pairs.push({ left: l, right: r }); });
      if (!pairs.length) return null;
      return { type: 'match', pairs: pairs };
    }
    if (t === 'lueckentext') {
      var text = String(m.text || m.instruction || '');
      var cleaned = text.replace(/\[\[\d+\]\]/g, '___');
      var blanks = Array.isArray(m.blanks) ? m.blanks : [];
      var answers = Array.isArray(m.answers) ? m.answers.map(function (a) { return String(a); }).filter(function (a) { return a; }) : (blanks.length ? blanks.map(function (b) { return String((b && b.answer) || ''); }) : []);
      if (!cleaned && !answers.length) return null;
      var uniq = answers.filter(function (a, i) { return answers.indexOf(a) === i; });
      if (!uniq.length) return null;
      return { type: 'cloze', sentence: cleaned, options: uniq, answer: uniq[0], explain: String(m.explanation || m.instruction || '') };
    }
    return null;
  }
  async function fetchRemoteSteps(subjectLabel, topicText, count) {
    var list = await callApi('/api/content/missions', { subject: subjectLabel, topic: topicText, difficulty: 'easy', count: Math.max(1, Math.min(6, count || 3)) });
    var arr = Array.isArray(list) ? list : ((list && (list.missions || list.missionen || list.items)) || []);
    var steps = [];
    (arr || []).forEach(function (m) { var s = missionFromRemote(m); if (s) steps.push(s); });
    return steps;
  }
  function topicForText(topicText) {
    var t = String(topicText || '').toLowerCase().trim();
    var all = allTopics();
    for (var i = 0; i < all.length; i++) { var x = all[i]; if (x.title.toLowerCase().indexOf(t) >= 0 || (x.subtitle || '').toLowerCase().indexOf(t) >= 0) return x; }
    return null;
  }
  async function startMissionFromSubjectTopic(subjectLabel, topicText) {
    var steps = await fetchRemoteSteps(subjectLabel, topicText, 3);
    if (steps.length) {
      return { id: 'remote-' + Date.now(), subjectId: subjectLabel, topicId: topicText, title: subjectLabel + ' · ' + topicText, steps: steps, score: { xp: 0, correctCount: 0, answered: 0 } };
    }
    var localTopic = topicForText(topicText) || topicFor(learnTopicId);
    var localMission = localTopic ? buildMission(localTopic, Math.random) : null;
    return localMission;
  }

  /* ==================== Fortschritt (Speichern/Laden) ==================== */

  var STATS_KEY = 'federwerkLearnStats';
  function loadStats() {
    var fallback = createStats();
    try {
      var w = (typeof window !== 'undefined') ? window : {};
      var raw = null;
      if (w.localStorage) { raw = w.localStorage.getItem(STATS_KEY); }
      if (raw) {
        var parsed = JSON.parse(raw);
        fallback = Object.assign({}, createStats(), parsed);
      }
    } catch (e) { /* Fallback */ }
    return fallback;
  }
  function saveStats(s) {
    var next = Object.assign({}, s || createStats());
    try {
      var w = (typeof window !== 'undefined') ? window : {};
      if (w.localStorage) { w.localStorage.setItem(STATS_KEY, JSON.stringify(next)); }
    } catch (e) { /* ignore */ }
    try {
      var api = (typeof window !== 'undefined') ? window.FederwerkApi : null;
      if (api && api.saveLearnProgress) { api.saveLearnProgress(next).catch(function () { /* offline ok */ }); }
    } catch (e) { /* ignore */ }
    return next;
  }

  /* ==================== DOM-Helper + Phasen ==================== */

  function $(id) { try { return document.getElementById(id); } catch (e) { return null; } }

  var learnPhase = 'subjects';
  var learnSubjectId = null;
  var learnTopicId = null;
  var mission = null;
  var missionStep = 0;
  var stepResult = null;
  var matchDeck = null;
  var matchSel = null;
  var stats = loadStats();

  function openLearn() {
    var o = $('learnOverlay');
    if (o) { o.classList.add('active'); }
    learnPhase = 'subjects';
    mission = null; missionStep = 0; stepResult = null; matchDeck = null; matchSel = null;
    renderLearn();
  }
  function closeLearn() {
    var o = $('learnOverlay');
    if (o) { o.classList.remove('active'); }
    learnPhase = 'subjects';
    mission = null; missionStep = 0; stepResult = null; matchDeck = null; matchSel = null;
  }
  function setPhase(p) { learnPhase = p; renderLearn(); }

  function currentStep() { return (mission && mission.steps && mission.steps[missionStep]) || null; }

  function renderLearn() {
    var body = $('learnBody');
    if (!body) return;
    if (learnPhase === 'subjects') renderSubjects(body);
    else if (learnPhase === 'topics') renderTopics(body);
    else if (learnPhase === 'resources') renderResources(body);
    else if (learnPhase === 'mission') renderMission(body);
    else if (learnPhase === 'result') renderResult(body);
  }

  /* ---------- Rendern: Faecher ---------- */

  function learnStatsBar() {
    var lp = levelProgress(stats.xp || 0);
    return '<div class="learn-stats-row">'
      + '<span class="learn-stat" title="Punkte (XP)">⭐ XP <b>' + esc(stats.xp) + '</b></span>'
      + '<span class="learn-stat" title="Level">🎚 Level <b>' + esc(lp.level) + '</b> (' + esc(lp.title) + ')</span>'
      + '<span class="learn-stat" title="Aktuelle Streak">🔥 Streak <b>' + esc(stats.streak) + '</b> Tage</span>'
      + '</div>';
  }
  function renderSubjects(body) {
    var h = '<div class="learn-hero box">'
      + '<div class="learn-hero-title">📚 Lernen</div>'
      + '<div class="learn-hero-sub">Wähle einen Fach – starte eine Mission und lerne spielerisch mit XP, Streak und Level.</div>'
      + learnStatsBar()
      + '</div>'
      + '<div class="section-title">Fach wählen</div>'
      + '<div class="learn-subject-grid">';
    SUBJECTS.forEach(function (s) {
      h += '<button type="button" class="learn-subject" style="--lc:' + esc(s.color) + '" onclick="federwerkLearnPickSubject(\'' + esc(s.id) + '\')">'
        + '<span class="learn-subject-icon">' + esc(s.icon) + '</span>'
        + '<span class="learn-subject-label">' + esc(s.label) + '</span>'
        + '<span class="learn-subject-blurb">' + esc(s.blurb) + '</span>'
        + '</button>';
    });
    h += '</div>';
    if (body) body.innerHTML = h;
  }
  function renderTopics(body) {
    var s = subjectFor(learnSubjectId);
    var h = '<div class="learn-hero box">'
      + '<div class="learn-hero-title">' + esc(s ? s.icon + ' ' + s.label : '') + '</div>'
      + '<div class="learn-hero-sub">' + esc(s ? s.blurb : '') + '</div>'
      + learnStatsBar()
      + '</div>'
      + '<div class="learn-navrow">'
      + '<button type="button" class="mini-button" onclick="federwerkLearnBack()">← Fächer</button>'
      + '</div>'
      + '<div class="section-title">Themen für ' + esc(s ? s.label : '') + '</div>'
      + '<div class="learn-topic-list">';
    (s ? s.topics || [] : []).forEach(function (t) {
      h += '<button type="button" class="learn-topic" onclick="federwerkLearnPickTopic(\'' + esc(t.id) + '\')">'
        + '<span class="learn-topic-title">' + esc(t.title) + '</span>'
        + (t.subtitle ? '<span class="learn-topic-sub">' + esc(t.subtitle) + '</span>' : '')
        + '</button>';
    });
    h += '</div>';
    if (body) body.innerHTML = h;
  }
  function resourceThumb(r) {
    if (r && r.thumb) { return '<img class="learn-thumb" src="' + esc(r.thumb) + '" alt="" loading="lazy">'; }
    return '<div class="learn-thumb learn-thumb-fallback">' + (r && r.type === 'video' ? '▶' : '🌐') + '</div>';
  }
  function renderResources(body) {
    var t = topicFor(learnTopicId);
    var h = '<div class="learn-hero box">'
      + '<div class="learn-hero-title">🎯 Mission: ' + esc(t ? t.title : '') + '</div>'
      + '<div class="learn-hero-sub">' + esc(t ? (t.subtitle || '') : '') + '</div>'
      + learnStatsBar()
      + '</div>'
      + '<div class="section-title">Passende Videos &amp; Webseiten zum Thema</div>'
      + '<div class="learn-resource-list">';
    (resourcesFor(learnTopicId) || []).forEach(function (r) {
      h += '<div class="learn-resource">'
        + '<div class="learn-resource-thumb-wrap">' + resourceThumb(r) + '</div>'
        + '<div class="learn-resource-body">'
        + '<div class="learn-resource-title">' + esc(r.title) + '</div>'
        + '<div class="learn-resource-meta">' + (r.type === 'video' ? '🎥 Video' : '🌐 Webseite') + (r.duration ? ' · ' + esc(r.duration) : '') + '</div>'
        + '</div>'
        + '<a class="mini-button" href="' + esc(r.url) + '" target="_blank" rel="noopener" style="text-decoration:none">Öffnen ↗</a>'
        + '</div>';
    });
    h += '</div>';
    h += '<div class="learn-navrow" style="justify-content:space-between">'
      + '<button type="button" class="mini-button" onclick="federwerkLearnBack()">← Thema wählen</button>'
      + '<button type="button" class="mini-button" id="learnStartMissionBtn" onclick="federwerkLearnStartMission()">🎯 Mission starten</button>'
      + '</div>';
    if (body) body.innerHTML = h;
  }

  /* ---------- Rendern: Mission (Quiz) ---------- */

  function renderMission(body) {
    if (!body) return;
    var st = currentStep();
    if (!st) { setPhase('subjects'); return; }
    var qHtml = '';
    if (st.type === 'mc') {
      qHtml += '<div class="learn-q">' + esc(st.question.q) + '</div>'
        + '<div class="learn-opts">';
      st.question.options.forEach(function (o, i) {
        var cls = 'learn-opt';
        if (String(o) === String(st.question.answer)) cls += ' is-answer';
        qHtml += '<button type="button" class="' + cls + '" data-mi="' + i + '" onclick="federwerkLearnPickMC(this)">' + esc(o) + '</button>';
      });
      qHtml += '</div>';
      qHtml += '<div class="learn-explain" hidden></div>';
    } else if (st.type === 'cloze') {
      qHtml += '<div class="learn-q">' + esc(st.question.sentence) + '</div>'
        + '<div class="learn-opts">';
      st.question.options.forEach(function (o, i) {
        var cls = 'learn-opt';
        if (String(o) === String(st.question.answer)) cls += ' is-answer';
        qHtml += '<button type="button" class="' + cls + '" data-ci="' + i + '" onclick="federwerkLearnPickCloze(this)">' + esc(o) + '</button>';
      });
      qHtml += '</div>';
      qHtml += '<div class="learn-explain" hidden></div>';
    } else if (st.type === 'match') {
      var pairs = (st.question && st.question.pairs) || [];
      var lefts = shuffleArr(pairs, Math.random).map(function (p) { return { p: p, side: 'left' }; });
      var rights = shuffleArr(pairs, Math.random).map(function (p) { return { p: p, side: 'right' }; });
      matchDeck = { pairs: pairs, lefts: lefts, rights: rights, matched: {}, sel: null };
      var matchedCount = function () {
        var n = 0;
        (pairs || []).forEach(function (p) { if (matchDeck && matchDeck.matched[p.left]) n++; });
        return n;
      };
      var allMatched = function () { return matchedCount() >= (pairs || []).length; };
      qHtml += '<div class="learn-match">'
        + '<div class="learn-match-cols">'
        + '<div class="learn-match-col"><div class="learn-match-head">Begriffe</div>'
          + lefts.map(function (l) { return '<button type="button" class="learn-match-item' + (matchDeck.matched[l.p.left] ? ' matched' : '') + '" data-pair="' + esc(l.p.left) + '" onclick="federwerkLearnMatchTap(this, \'left\')">' + esc(l.p.left) + '</button>'; }).join('')
          + '</div>'
          + '<div class="learn-match-col"><div class="learn-match-head">Antworten / Formeln</div>'
            + rights.map(function (r) { return '<button type="button" class="learn-match-item" data-pair="' + esc(r.p.right) + '" onclick="federwerkLearnMatchTap(this, \'right\')">' + esc(r.p.right) + '</button>'; }).join('')
          + '</div>'
          + '</div>'
          + '<div class="flash-progress" id="learnMatchCount">Gematcht: ' + matchedCount() + ' / ' + (pairs || []).length + '</div>';
    }
    var h = '<div class="learn-hero box">'
      + '<div class="learn-hero-title">🎯 Mission</div>'
      + '<div class="learn-hero-sub">' + esc(mission ? mission.title : '') + '</div>'
      + learnStatsBar()
      + '</div>'
      + '<div class="flash-progress">Aufgabe ' + (missionStep + 1) + ' / ' + mission.steps.length + '</div>'
      + qHtml;
    body.innerHTML = h;
    var foot = $('learnFoot');
    if (foot) {
      foot.innerHTML = '<span style="font-size:12px;align-self:center;opacity:.75">Quiz läuft …</span>'
        + '<span style="display:flex;gap:8px;align-items:center">'
        + '<button type="button" class="inactive" onclick="federwerkLearnAbort()">Abbrechen</button>'
        + '<button type="button" id="learnNextBtn" class="mini-button" onclick="federwerkLearnNext()" disabled>Weiter →</button>'
        + '</span>';
    }
  }

  function renderResult(body) {
    var lp = levelProgress(stats.xp || 0);
    var pct = 0;
    if (mission && mission.steps && mission.steps.length) {
      pct = Math.round(((mission.score.correctCount || 0) / mission.steps.length) * 100);
    }
    var h = '<div class="learn-hero box">'
      + '<div class="learn-hero-title">✅ Mission abgeschlossen!</div>'
      + '<div class="learn-hero-sub">Thema: ' + esc(mission ? mission.title : '') + '</div>'
      + '<div class="learn-stats-row">'
      + '<span class="learn-stat">⭐ XP <b>' + esc(mission ? mission.score.xp : 0) + '</b> verdient</span>'
      + '<span class="learn-stat">🎚 Level <b>' + esc(lp.level) + '</b> · Gesamt: <b>' + esc(stats.xp) + '</b></span>'
      + '<span class="learn-stat">🔥 Streak <b>' + esc(stats.streak) + '</b> Tage</span>'
      + '</div>'
      + '<div class="flash-progress">Trefferquote: <b>' + esc(pct) + ' %</b> (' + esc(mission ? mission.score.correctCount : 0) + ' / ' + esc(mission ? mission.steps.length : 0) + ' Aufgaben richtig)</div>'
      + '</div>';
    if (body) body.innerHTML = h;
  }

  /* ---------- Quiz-Aktionen ---------- */

  function markAnswer(el, correct) {
    if (!el) return;
    var btn = el;
    if (correct) {
      btn.classList.add('is-answer', 'is-correct');
      btn.disabled = true;
    } else {
      btn.classList.add('is-wrong');
      btn.disabled = true;
      // Richtigste Antwort markieren
      var parent = el.closest ? el.closest('.learn-opts') : null;
      if (parent) {
        parent.querySelectorAll('.learn-opt').forEach(function (b) {
          if (String(b.textContent) === String(currentStep().question.answer)) b.classList.add('is-answer');
        });
      }
    }
  }
  function setExplain(html) {
    var ex = $('learnBody').querySelector ? $('learnBody').querySelector('.learn-explain') : null;
    if (ex) { ex.hidden = false; ex.innerHTML = html; }
  }

  function federfunkPick(stepType, el) {
    var st = currentStep();
    if (!st) return;
    var q = st.question;
    var idx = -1;
    if (stepType === 'mc') idx = Number((el && el.dataset && el.dataset.mi) || -1);
    else idx = Number((el && el.dataset && el.dataset.ci) || -1);
    if (idx < 0 || idx >= (stepType === 'mc' ? (q.options || []).length : (q.options || []).length)) return;
    var opt = q.options[idx];
    var correct = String(opt) === String(q.answer);
    stepResult = { correct: correct, xp: stepXp(st, correct) };
    mission.score.xp = (mission.score.xp || 0) + stepResult.xp;
    if (correct) mission.score.correctCount = (mission.score.correctCount || 0) + 1;
    mission.score.answered = (mission.score.answered || 0) + 1;
    if (stepType === 'mc') markAnswer(el, correct);
    else markAnswer(el, correct);
    if (correct) setExplain('<div class="learn-explain-ok">✅ Richtig! ' + esc(q.explain || '') + '</div>');
    else setExplain('<div class="learn-explain-wrong">❌ Leider falsch. ' + esc(q.explain || '') + '</div>');
    var nextBtn = $('learnNextBtn');
    if (nextBtn) nextBtn.disabled = false;
  }

  function federfunkLearnPickMC(el) { federfunkPick('mc', el); }
  function federfunkLearnPickCloze(el) { federfunkPick('cloze', el); }

  function federfunkLearnNext() {
    if (!mission) return;
    if (missionStep >= mission.steps.length) { return; }
    if (missionStep < mission.steps.length - 1) {
      missionStep = missionStep + 1;
      stepResult = null;
      mission.score.xp = 0;
      mission.score.correctCount = 0;
      mission.score.answered = 0;
      renderMission($('learnBody'));
      return;
    }
    finalizeMission();
  }

  function finalizeMission() {
    if (!mission) return;
    var allOk = ((mission.score.correctCount || 0) >= mission.steps.length) && (mission.steps.length > 0);
    var finalXp = (mission.score.xp || 0) + (allOk ? BONUS_ALL_STEPS : 0);
    mission.score.xp = finalXp;
    var finalStats = completeMission(stats, { xp: finalXp, correct: (mission.score.correctCount || 0), answered: (mission.score.answered || 0) });
    stats = finalStats;
    saveStats(finalStats);
    mission.finished = true;
    setPhase('result');
  }

  function federfunkLearnMatchTap(el, side) {
    if (!mission) return;
    var st = mission.steps[missionStep];
    if (!st || st.type !== 'match' || !matchDeck) return;
    if (side === 'left') {
      var pairId = el.getAttribute ? el.getAttribute('data-pair') : null;
      var same = matchDeck.sel && matchDeck.sel.pairId === pairId;
      matchDeck.sel = same ? null : { pairId: pairId };
      renderMission($('learnBody'));
      return;
    }
    var pairIdR = el.getAttribute ? el.getAttribute('data-pair') : null;
    if (matchDeck.sel && matchDeck.sel.pairId === pairIdR) {
      var p = (matchDeck.pairs || []).filter(function (x) { return String(x.left) === String(pairIdR) || String(x.right) === String(pairIdR); })[0];
      if (!p) { matchDeck.sel = null; renderMission($('learnBody')); return; }
      matchDeck.matched[p.left] = true;
      matchDeck.sel = null;
      var all = (matchDeck.pairs || []).every(function (x) { return !!matchDeck.matched[x.left]; });
      if (all) {
        stepResult = { correct: true, xp: stepXp(st, true) };
        mission.score.xp = (mission.score.xp || 0) + stepResult.xp;
        mission.score.correctCount = (mission.score.correctCount || 0) + 1;
        mission.score.answered = (mission.score.answered || 0) + 1;
        var nextBtn = $('learnNextBtn');
        if (nextBtn) nextBtn.disabled = false;
      } else {
        var nextBtn2 = $('learnNextBtn');
        if (nextBtn2) nextBtn2.disabled = true;
      }
      var cntEl = document.querySelector ? document.querySelector('#learnMatchCount') : null;
      if (cntEl) cntEl.innerHTML = 'Gematcht: ' + Object.keys(matchDeck.matched).length + ' / ' + (matchDeck.pairs || []).length;
      return;
    }
    matchDeck.sel = null;
    renderMission($('learnBody'));
  }

  /* ---------- Phasen-Uebernahme: Buttons (HTML-Einbindung) ---------- */

  function federfunkLearnPickSubject(id) { learnSubjectId = id; learnPhase = 'topics'; renderLearn(); }
  function federfunkLearnPickTopic(id) { learnTopicId = id; learnPhase = 'resources'; renderLearn(); }
  function federfunkLearnBack() {
    if (learnPhase === 'topics') setPhase('subjects');
    else if (learnPhase === 'resources') setPhase('topics');
    else if (learnPhase === 'mission') closeLearn();
  }
  function federfunkLearnStartMission() {
    return startMissionFromSubjectTopic(
      (subjectFor(learnSubjectId) || { label: '' }).label || '',
      (topicFor(learnTopicId) || { title: '' }).title || '',
    ).then(function (m) {
      if (!m) return false;
      mission = m;
      missionStep = 0;
      stepResult = null;
      mission.score = { xp: 0, correctCount: 0, answered: 0 };
      matchDeck = null;
      matchSel = null;
      learnPhase = 'mission';
      renderMission($('learnBody'));
      return true;
    });
  }
  function federfunkLearnReset() {
    var t = topicFor(learnTopicId);
    if (!t) return;
    federfunkLearnStartMission();
  }
  function federfunkLearnAbort() { closeLearn(); }

  /* ---------- API ---------- */

  var api = {
    SUBJECTS: SUBJECTS,
    topicsFor: topicsFor,
    resourcesFor: resourcesFor,
    buildMission: buildMission,
    stepXp: stepXp,
    missionFromRemote: missionFromRemote,
    fetchRemoteSteps: fetchRemoteSteps,
    levelFromXp: levelFromXp,
    levelTitleFor: levelTitleFor,
    levelProgress: levelProgress,
    dayKey: dayKey,
    createStats: createStats,
    completeMission: completeMission,
    streakAfter: streakAfter,
    getStats: function () { return stats; },
    saveStats: saveStats,
    resetStats: function () { stats = saveStats(createStats()); return stats; },
    open: openLearn,
    close: closeLearn,
    pickSubject: federfunkLearnPickSubject,
    pickTopic: federfunkLearnPickTopic,
    startMission: federfunkLearnStartMission,
    resetMission: federfunkLearnReset,
    back: federfunkLearnBack,
    abort: federfunkLearnAbort,
    next: federfunkLearnNext,
    pickMC: federfunkLearnPickMC,
    pickCloze: federfunkLearnPickCloze,
    matchTap: federfunkLearnMatchTap,
    render: renderLearn,
  };

  if (typeof window !== 'undefined') {
    window.FederwerkLearn = api;
    window.federwerkLearnPickSubject = federfunkLearnPickSubject;
    window.federwerkLearnPickTopic = federfunkLearnPickTopic;
    window.federwerkLearnStartMission = federfunkLearnStartMission;
    window.federwerkLearnBack = federfunkLearnBack;
    window.federwerkLearnAbort = federfunkLearnAbort;
    window.federwerkLearnReset = federfunkLearnReset;
    window.federwerkLearnNext = federfunkLearnNext;
    window.federwerkLearnPickMC = federfunkLearnPickMC;
    window.federwerkLearnPickCloze = federfunkLearnPickCloze;
    window.federwerkLearnMatchTap = federfunkLearnMatchTap;
    window.federwerkLearnOpen = openLearn;
    window.federwerkLearnClose = closeLearn;
  }
  if (typeof module !== 'undefined' && module.exports) module.exports = api;
})();
