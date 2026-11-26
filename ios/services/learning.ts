/** Federwerk iOS – Lernen-Modul: Fächer, Themen, Ressourcen, Quiz-Missionen, XP/Level/Streak. */

export type LearnSubjectId = 'physik' | 'mathe' | 'chemie' | 'informatik';
export type LearnResourceType = 'video' | 'website';

export interface LearnResource {
  type: LearnResourceType;
  title: string;
  url: string;
  duration?: string;
}

export interface LearnPair { left: string; right: string; }

export interface LearnMcQuestion { type: 'mc'; q: string; options: string[]; answer: string; explain: string; }
export interface LearnClozeQuestion { type: 'cloze'; sentence: string; options: string[]; answer: string; explain: string; }
export interface LearnMatchQuestion { type: 'match'; pairs: LearnPair[]; }

export type LearnStep = LearnMcQuestion | LearnClozeQuestion | LearnMatchQuestion;

export interface LearnMission {
  id: string;
  subjectId: string;
  topicId: string;
  title: string;
  steps: LearnStep[];
}

export interface LearnQuestions {
  mc: LearnMcQuestion[];
  match: LearnMatchQuestion[];
  cloze: LearnClozeQuestion[];
}

export interface LearnTopic {
  id: string;
  subjectId: string;
  subjectLabel: string;
  title: string;
  subtitle: string;
  resources: LearnResource[];
  questions: LearnQuestions;
}

export interface LearnSubject {
  id: string;
  label: string;
  icon: string;
  color: string;
  blurb: string;
  topics: LearnTopic[];
}

export interface LearnStats {
  xp: number;
  level: number;
  title: string;
  streak: number;
  lastDay: string;
  missionsDone: number;
  correct: number;
  answered: number;
}

export const BONUS_ALL_STEPS = 20;
export const XP_CORRECT = { mc: 10, cloze: 10, match: 5 } as const;

const SUBJECTS: LearnSubject[] = [
  {
    id: 'physik',
    label: 'Physik',
    icon: '⚛️',
    color: '#3b82f6',
    blurb: 'Mechanik · Energie · Elektrizität · Optik',
    topics: [
      {
        id: 'newtonsches-gesetz',
        subjectId: 'physik',
        subjectLabel: 'Physik',
        title: 'Newtonsche Gesetze',
        subtitle: 'Mechanik',
        resources: [
          { type: 'video', title: 'Newtonsche Gesetze – einfach erklärt', url: 'https://www.youtube.com/results?search_query=Newtonsche+Gesetze+Physik', duration: '' },
          { type: 'website', title: 'Wikipedia: Newtonsches Gesetz / Mechanik', url: 'https://de.wikipedia.org/wiki/Newtonsches_Gesetz', duration: '' },
        ],
        questions: {
          mc: [
            { type: 'mc', q: 'Welche Einheit beschreibt Kraft?', options: ['Newton (N)', 'Joule (J)', 'Watt (W)', 'Pascal (Pa)'], answer: 'Newton (N)', explain: 'Kraft wird in Newton (N) angegeben, Energie in Joule (J).' },
            { type: 'mc', q: 'Das 2. Newtonsche Gesetz lautet …', options: ['F = m · a', 'F = m · Δv', 'a = F · m', 'F = m · g'], answer: 'F = m · a', explain: 'F = m · a: Die Kraft ist die Masse mal der Beschleunigung. Δv = a · Δt.' },
            { type: 'mc', q: 'Was gilt laut 1. Newtonschem Gesetz?', options: ['Körper mit großer Masse sind schwerer', 'Ohne äußere Kraft ändert sich die Geschwindigkeit nicht', 'Beschleunigung benötigt Energie', 'Masse erzeugt eine Kraft'], answer: 'Ohne äußere Kraft ändert sich die Geschwindigkeit nicht', explain: 'Inertialmasse: Erst eine äußere Kraft erzeugt eine Änderung der Geschwindigkeit.' },
          ],
          match: [
            { type: 'match', pairs: [
              { left: 'Kraft', right: 'F = m · a' },
              { left: 'Masse', right: 'Trägheitsmaß' },
              { left: 'Geschwindigkeit', right: 'gemessen in m/s' },
            ] },
          ],
          cloze: [
            { type: 'cloze', sentence: 'Das 2. Newtonsche Gesetz: Kraft = Masse × ___', options: ['Beschleunigung (a)', 'Geschwindigkeit (v)', 'Energie (E)'], answer: 'Beschleunigung (a)', explain: 'F = m · a – je größer die Masse oder die Beschleunigung, desto größer die Kraft.' },
          ],
        },
      },
      {
        id: 'energie',
        subjectId: 'physik',
        subjectLabel: 'Physik',
        title: 'Energie & Erhaltung',
        subtitle: 'Physiktheorie',
        resources: [
          { type: 'video', title: 'Energieerhaltung – so funktioniert sie', url: 'https://www.youtube.com/results?search_query=Energieerhaltung+Physik', duration: '' },
          { type: 'website', title: 'Wikipedia: Energie', url: 'https://de.wikipedia.org/wiki/Energie', duration: '' },
        ],
        questions: {
          mc: [
            { type: 'mc', q: 'Die Einheit der Energie ist …', options: ['Joule (J)', 'Newton (N)', 'Watt (W)', 'Pascal (Pa)'], answer: 'Joule (J)', explain: 'Arbeit und Energie werden in Joule (J) angegeben.' },
            { type: 'mc', q: 'Das Arbeits-Energie-Theorem besagt …', options: ['ΔE = W_net', 'E = m · c²', 'F = m · g', 'p = m · v'], answer: 'ΔE = W_net', explain: 'Die zugefasste netto Arbeit entspricht der Änderung der Energie: ΔE = W_net.' },
          ],
          match: [
            { type: 'match', pairs: [
              { left: 'Energie', right: 'bleibt erhalten' },
              { left: 'Leistung', right: 'P = ΔE / Δt' },
              { left: 'Arbeit', right: 'Energieübertragung' },
            ] },
          ],
          cloze: [
            { type: 'cloze', sentence: 'Energie wird weder ___ noch vernichtet, sie wandelt sich nur um.', options: ['erschaffen', 'verbraucht', 'umwandelt sich'], answer: 'umwandelt sich', explain: 'Erhaltung der Energie: Die Gesamtenergie bleibt in einem abgeschlossenen System konstant.' },
          ],
        },
      },
    ],
  },
  {
    id: 'mathe',
    label: 'Mathe',
    icon: '🔢',
    color: '#f59e0b',
    blurb: 'Algebra · Analysis · Geometrie · Zahlen',
    topics: [
      {
        id: 'potenzfunktionen',
        subjectId: 'mathe',
        subjectLabel: 'Mathe',
        title: 'Potenzfunktionen & Wurzeln',
        subtitle: 'Algebra',
        resources: [
          { type: 'video', title: 'Potenzfunktionen und Wurzeln', url: 'https://www.youtube.com/results?search_query=Potenzfunktionen+Wurzeln+Mathe', duration: '' },
          { type: 'website', title: 'Wikipedia: Potenz (Mathematik)', url: 'https://de.wikipedia.org/wiki/Potenz_(Mathematik)', duration: '' },
        ],
        questions: {
          mc: [
            { type: 'mc', q: 'Die Quadratwurzel aus 144 ist …', options: ['12', '14', '144', '24'], answer: '12', explain: '√144 = 12, denn 12 · 12 = 144.' },
            { type: 'mc', q: '(a · b)ⁿ = aⁿ · bⁿ nennt man …', options: ['Potenzgesetz', 'Quadratwurzel', 'Termvorschrift', 'Nullsummenregel'], answer: 'Potenzgesetz', explain: 'Potenzgesetz: (a·b)ⁿ = aⁿ·bⁿ.' },
          ],
          match: [
            { type: 'match', pairs: [
              { left: 'Potenz', right: 'xⁿ' },
              { left: 'Wurzel', right: '√x' },
              { left: 'Potenzgesetz', right: '(ab)ⁿ = aⁿbⁿ' },
            ] },
          ],
          cloze: [
            { type: 'cloze', sentence: 'Für x² = 9 gilt: x = ___.', options: ['3', '9', '√9'], answer: '3', explain: 'Quadratwurzel: x² = 9 → x = ±3.' },
          ],
        },
      },
      {
        id: 'ableitung',
        subjectId: 'mathe',
        subjectLabel: 'Mathe',
        title: 'Ableitung (Analysis)',
        subtitle: 'Analysis',
        resources: [
          { type: 'video', title: 'Die Ableitung einfach erklärt', url: 'https://www.youtube.com/results?search_query=Ableitung+Mathe+erklaert', duration: '' },
          { type: 'website', title: 'Wikipedia: Ableitung', url: 'https://de.wikipedia.org/wiki/Ableitung', duration: '' },
        ],
        questions: {
          mc: [
            { type: 'mc', q: 'Die Ableitung von f(x) = x² ist …', options: ['2x', 'x² / 2', '2x²', 'x'], answer: '2x', explain: 'f′(x) = lim (x+h)² − x² / h = 2x.' },
            { type: 'mc', q: 'Die Ableitung beschreibt …', options: ['die Kurvenänderung (Steigung)', 'die Fläche unter der Kurve', 'die Nullstelle', 'den y-Achsenabschnitt'], answer: 'die Kurvenänderung (Steigung)', explain: 'Die Ableitung ist der Differentialquotient: lokale Steigung der Funktion.' },
          ],
          match: [
            { type: 'match', pairs: [
              { left: 'Ableitung', right: 'Differenzenquotient' },
              { left: 'Steigung', right: 'Ableitung an x' },
            ] },
          ],
          cloze: [
            { type: 'cloze', sentence: 'Die erste Ableitung von f(x) = ___ ergibt die Steigung der Funktion.', options: ['x²', '2x', 'x³'], answer: 'x²', explain: 'f′(x) = 2x ist die Steigung der Parabel.' },
          ],
        },
      },
    ],
  },
  {
    id: 'chemie',
    label: 'Chemie',
    icon: '🧪',
    color: '#10b981',
    blurb: 'Periodensystem · Reaktionen · Trends',
    topics: [
      {
        id: 'periodensystem',
        subjectId: 'chemie',
        subjectLabel: 'Chemie',
        title: 'Periodensystem & Elemente',
        subtitle: 'Elemente',
        resources: [
          { type: 'video', title: 'Das Periodensystem einfach erklärt', url: 'https://www.youtube.com/results?search_query=Periodensystem+Chemie+erklaert', duration: '' },
          { type: 'website', title: 'Wikipedia: Periodensystem', url: 'https://de.wikipedia.org/wiki/Periodensystem', duration: '' },
        ],
        questions: {
          mc: [
            { type: 'mc', q: 'Welche Ordnungszahl gehört zu Kohlenstoff (C)?', options: ['6', '12', '16', '8'], answer: '6', explain: 'Ordnungszahl = Anzahl der Protonen im Atomkern.' },
            { type: 'mc', q: 'Welches Element hat die Ordnungszahl 79?', options: ['Gold (Au)', 'Silber (Ag)', 'Platin (Pt)', 'Blei (Pb)'], answer: 'Gold (Au)', explain: 'Ordnungszahl 79 = Gold.' },
          ],
          match: [
            { type: 'match', pairs: [
              { left: 'Helium', right: 'Ordnungszahl 2' },
              { left: 'Wasserstoff', right: 'Ordnungszahl 1' },
              { left: 'Kohlenstoff', right: 'Ordnungszahl 6' },
            ] },
          ],
          cloze: [
            { type: 'cloze', sentence: 'Die Ordnungszahl eines Elements entspricht der Anzahl der Protonen im ___.', options: ['Atomkern', 'Elektronenhülle'], answer: 'Atomkern', explain: 'Ordnungszahl = Kernladungszahl = Protonenzahl.' },
          ],
        },
      },
      {
        id: 'reaktionen',
        subjectId: 'chemie',
        subjectLabel: 'Chemie',
        title: 'Chemische Reaktionen',
        subtitle: 'Reaktionschemie',
        resources: [
          { type: 'video', title: 'Chemische Reaktionen – Grundlagen', url: 'https://www.youtube.com/results?search_query=Chemische+Reaktionen+Grundlagen', duration: '' },
          { type: 'website', title: 'Wikipedia: Chemische Reaktion', url: 'https://de.wikipedia.org/wiki/Chemische_Reaktion', duration: '' },
        ],
        questions: {
          mc: [
            { type: 'mc', q: 'Welches Gesetz gilt in jeder chemischen Reaktion?', options: ['Erhaltung der Masse', 'Erhaltung der Entropie', 'Gleichung der Ströme', 'Gesetz der Äquivalenz'], answer: 'Erhaltung der Masse', explain: 'Die Masse wird weder erzeugt noch vernichtet – sie bleibt erhalten.' },
          ],
          match: [
            { type: 'match', pairs: [
              { left: 'Reaktionsgleichung', right: 'Reaktanten + Produkte' },
              { left: 'Katalysator', right: 'beschleunigt, bleibt selbst unverändert' },
            ] },
          ],
          cloze: [
            { type: 'cloze', sentence: 'Bei einer chemischen Reaktion verändern sich ___ und Produkte.', options: ['Stoffe', 'Nur Energie'], answer: 'Stoffe', explain: 'Stoffe werden in andere umgewandelt; Energie bleibt in Summe erhalten.' },
          ],
        },
      },
    ],
  },
  {
    id: 'informatik',
    label: 'Informatik',
    icon: '💻',
    color: '#8b5cf6',
    blurb: 'Algorithmen · Datenstrukturen · Netzwerke',
    topics: [
      {
        id: 'algorithmus',
        subjectId: 'informatik',
        subjectLabel: 'Informatik',
        title: 'Algorithmen & Komplexität',
        subtitle: 'Algorithmik',
        resources: [
          { type: 'video', title: 'Komplexität (Big O) einfach erklärt', url: 'https://www.youtube.com/results?search_query=Komplexitaet+Big+O+Algorithmus', duration: '' },
          { type: 'website', title: 'Wikipedia: Komplexität', url: 'https://de.wikipedia.org/wiki/Komplexitaet', duration: '' },
        ],
        questions: {
          mc: [
            { type: 'mc', q: 'Die Komplexität einer Binärsuche über n Elemente ist …', options: ['O(log n)', 'O(n)', 'O(n²)', 'O(1)'], answer: 'O(log n)', explain: 'Bei Verdopplung der Elemente halbiert sich die Anzahl der Schritte bei Binärsuche.' },
            { type: 'mc', q: 'Wie wird eine lineare Suche über n Elemente beschrieben?', options: ['O(n)', 'O(log n)', 'O(1)', 'O(n · log n)'], answer: 'O(n)', explain: 'Lineare Suche: maximal n Prüfungen – einmal durchlaufen.' },
          ],
          match: [
            { type: 'match', pairs: [
              { left: 'Binärsuche', right: 'O(log n)' },
              { left: 'Lineare Suche', right: 'O(n)' },
            ] },
          ],
          cloze: [
            { type: 'cloze', sentence: 'Die effiziente Sortierung großer Datenmengen nutzt oft einen Algorithmus mit Komplexität ___.', options: ['O(n · log n)', 'O(n²)', 'O(1)'], answer: 'O(n · log n)', explain: 'Merge-Sort: lineareithmetische Sortierung O(n log n).' },
          ],
        },
      },
      {
        id: 'datenstrukturen',
        subjectId: 'informatik',
        subjectLabel: 'Informatik',
        title: 'Datenstrukturen (Stacks & Queues)',
        subtitle: 'Datenstrukturen',
        resources: [
          { type: 'video', title: 'Datenstrukturen einfach erklärt', url: 'https://www.youtube.com/results?search_query=Datenstrukturen+Stacks+Queues', duration: '' },
          { type: 'website', title: 'Wikipedia: Datenstruktur', url: 'https://de.wikipedia.org/wiki/Datenstruktur', duration: '' },
        ],
        questions: {
          mc: [
            { type: 'mc', q: 'Welches Prinzip beschreibt einen Stack?', options: ['LIFO (Last In, First Out)', 'FIFO (First In, First Out)', 'LRU', 'AVL'], answer: 'LIFO (Last In, First Out)', explain: 'Stack: Das zuletzt hinzugefügte Element wird zuerst wieder entfernt.' },
          ],
          match: [
            { type: 'match', pairs: [
              { left: 'Stack', right: 'LIFO' },
              { left: 'Queue', right: 'FIFO' },
            ] },
          ],
          cloze: [
            { type: 'cloze', sentence: 'In einer ___ werden Elemente am rechten Ende angehängt (Push) und am linken wieder entfernt (Pop).', options: ['Stack', 'Queue', 'Graph'], answer: 'Stack', explain: 'Stack = LIFO.' },
          ],
        },
      },
    ],
  },
];

export function subjectList(): LearnSubject[] {
  return SUBJECTS;
}
export function topicsFor(subjectId: string): LearnTopic[] {
  const s = SUBJECTS.find((x) => x.id === subjectId);
  return s ? s.topics : [];
}
export function topicFor(topicId: string): LearnTopic | null {
  for (const s of SUBJECTS) {
    const t = (s.topics || []).find((x) => x.id === topicId);
    if (t) return t;
  }
  return null;
}
export function resourcesFor(topicId: string): LearnResource[] {
  const t = topicFor(topicId);
  return t ? (t.resources || []) : [];
}

function shuffle<T>(arr: T[], rnd: () => number): T[] {
  const a = arr.slice();
  for (let i = a.length - 1; i > 0; i--) {
    const j = Math.floor(rnd() * (i + 1));
    const tmp = a[i]; a[i] = a[j]; a[j] = tmp;
  }
  return a;
}

export function buildMission(topic: LearnTopic, rnd: () => number = Math.random): LearnMission {
  const pick = (list: LearnStep[], n: number): LearnStep[] => shuffle(list, rnd).slice(0, Math.max(0, Math.min(n, list.length)));
  const steps: LearnStep[] = [];
  pick(topic.questions.mc, 2).forEach((q) => steps.push(q));
  pick(topic.questions.cloze, 2).forEach((q) => steps.push(q));
  pick(topic.questions.match, 1).forEach((q) => steps.push(q));
  return { id: 'mission-' + Date.now(), subjectId: topic.subjectId, topicId: topic.id, title: (topic.subjectLabel || '') + ' · ' + topic.title, steps };
}

export function stepXp(step: LearnStep, correct: boolean): number {
  if (step.type === 'match') {
    if (correct && step.pairs) return step.pairs.length * XP_CORRECT.match;
    return 0;
  }
  return correct ? (XP_CORRECT[step.type] || 10) : 0;
}

export function levelFromXp(xp: number): number {
  let level = 1;
  let l = 2;
  while (l <= 60) {
    const entry = 100 * (l - 1) * (l - 1);
    if (xp >= entry) { level = l; l = l + 1; } else { break; }
  }
  return level;
}

export function levelTitleFor(level: number): string {
  const t = ['Starter', 'Anfaenger', 'Sicher', 'Fortgeschritten', 'Experte', 'Meister', 'Legende'];
  const i = Math.max(0, Math.min(t.length - 1, level - 1));
  return t[i];
}

export function levelProgress(xp: number): { level: number; title: string; xp: number; into: number; span: number; pct: number } {
  const level = levelFromXp(xp);
  const cur = 100 * (level - 1) * (level - 1);
  const next = 100 * level * level;
  const into = xp - cur;
  const span = Math.max(1, next - cur);
  return { level, title: levelTitleFor(level), xp, into, span, pct: Math.round((into / span) * 100) };
}

export function dayKey(d: Date | number | string): string {
  const dt = d instanceof Date ? d : new Date(d);
  const m = String(dt.getMonth() + 1);
  const day = String(dt.getDate());
  const mm = m.length < 2 ? '0' + m : m;
  const dd = day.length < 2 ? '0' + day : day;
  return dt.getFullYear() + '-' + mm + '-' + dd;
}

export function createStats(): LearnStats {
  return { xp: 0, level: 1, title: 'Anfaenger', streak: 0, lastDay: '', missionsDone: 0, correct: 0, answered: 0 };
}

export function streakAfter(stats: LearnStats, today: Date): LearnStats {
  const s: LearnStats = { ...stats };
  const key = dayKey(today);
  const yesterday = dayKey(new Date(Date.now() - 24 * 60 * 60 * 1000));
  let streak = s.streak || 0;
  if (s.lastDay !== key) {
    streak = s.lastDay === yesterday ? streak + 1 : 1;
    s.streak = streak;
    s.lastDay = key;
  }
  return s;
}

export function completeMission(stats: LearnStats, result: { xp: number; correct: number; answered: number }): LearnStats {
  const next0 = streakAfter(stats, new Date());
  const next: LearnStats = { ...next0, xp: next0.xp + (result?.xp || 0), missionsDone: next0.missionsDone + 1, correct: next0.correct + (result?.correct || 0), answered: next0.answered + (result?.answered || 0) };
  next.level = levelFromXp(next.xp);
  next.title = levelTitleFor(next.level);
  return next;
}
