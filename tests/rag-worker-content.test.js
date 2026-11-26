// Tests fuer die Content-Endpunkte des RAG-Workers (api/rag-worker.js):
//   POST /api/content/search   -> passende Videos/Webseiten mit Metadaten
//   POST /api/content/missions -> Duolingo-Style Lern-Missionen als JSON-Array
// Bindings (AI/VECTORIZE_INDEX) und OpenRouter werden gestubbt.
import { test } from 'node:test';
import assert from 'node:assert/strict';

import worker from '../api/rag-worker.js';

const MATCHES = [
  {
    id: 'a1', score: 0.91,
    metadata: {
      source: 'https://de.wikipedia.org/wiki/Photosynthese',
      title: 'Photosynthese – Wikipedia',
      text: 'Photosynthese ist die Umwandlung von Lichtenergie in chemische Energie.',
    },
  },
  {
    id: 'a2', score: 0.88,
    metadata: {
      source: 'https://www.youtube.com/watch?v=abc123',
      title: 'Photosynthese erklärt',
      type: 'video',
      text: 'In diesem Video erklären wir die Lichtreaktion und den Calvin-Zyklus.',
    },
  },
  {
    id: 'a3', score: 0.77,
    metadata: {
      source: 'Skript Biologie Kapitel 3',
      text: 'Chloroplasten enthalten Chlorophyll. Der Calvin-Zyklus läuft im Stroma ab.',
    },
  },
];

function makeEnv(matches) {
  return {
    EMBED_DIM: '768',
    OPENROUTER_API_KEY: 'test-key',
    AI: { async run(model, opts) { return { data: (opts.text || []).map(() => new Array(768).fill(0.01)) }; } },
    VECTORIZE_INDEX: {
      async upsert(u) { return { count: u.length }; },
      async query(vector, opts) { return { matches: (matches || []).slice(0, (opts && opts.topK) || 4) }; },
    },
  };
}

const MISSIONS = [
  {
    id: 'm1', type: 'quiz', title: 'Quiz', instruction: 'Wähle.',
    question: 'Was wird produziert?', options: ['O2', 'CO2', 'N2', 'H2'], correctIndex: 0, correctAnswer: 'O2',
    explanation: 'Sauerstoff.', sources: [{ source: 'https://de.wikipedia.org/wiki/Photosynthese', excerpt: '…' }],
  },
  {
    id: 'm2', type: 'Zuordnung', title: 'Zuordnung', instruction: 'Ordne zu.',
    pairs: [{ left: 'Chlorophyll', right: 'Farbstoff' }, { left: 'Chloroplast', right: 'Organell' }, { left: 'Calvin-Zyklus', right: 'CO2-Fixierung' }],
    sources: ['Skript Biologie Kapitel 3'],
  },
  {
    id: 'm3', type: 'Lückentext', title: 'Lückentext', instruction: 'Fülle.',
    text: 'Die ___ wandelt Licht in Energie um. Der ___ läuft im Stroma ab.',
    answers: ['Photosynthese', 'Calvin-Zyklus'], sources: ['[Quelle 1]'],
  },
  {
    id: 'm4', type: 'video-link', title: 'Video', instruction: 'Schau.',
    url: 'https://www.youtube.com/watch?v=abc123', question: 'Was wird erklärt?', answer: 'Lichtreaktion',
    sources: [{ source: 'https://www.youtube.com/watch?v=abc123' }],
  },
];

// global fetch stubben: OpenRouter -> MISSIONS
function stubOpenRouter(t, payload) {
  const original = globalThis.fetch;
  let calls = 0;
  globalThis.fetch = async (url) => {
    if (String(url).includes('openrouter.ai')) {
      calls++;
      const content = typeof payload === 'function' ? payload(calls) : payload;
      return new Response(JSON.stringify({ choices: [{ message: { content } }] }), { status: 200 });
    }
    throw new Error('unexpected fetch ' + url);
  };
  t.after(() => { globalThis.fetch = original; });
  return () => calls;
}

function req(path, body) {
  return new Request('https://worker.example' + path, {
    method: 'POST', headers: { 'Content-Type': 'application/json' }, body: JSON.stringify(body),
  });
}

// ---------------------------------------------------------------- /api/content/search

test('POST /api/content/search liefert passende Videos/Webseiten mit Metadaten', async () => {
  const res = await worker.fetch(req('/api/content/search', { subject: 'Biologie', topic: 'Photosynthese', topK: 3 }), makeEnv(MATCHES), {});
  assert.equal(res.status, 200);
  const data = await res.json();

  assert.equal(data.query, 'Biologie Photosynthese');
  assert.equal(data.topK, 3);
  assert.ok(Array.isArray(data.results) && data.results.length === 3);
  // nach Score sortiert
  assert.ok(data.results[0].score >= data.results[1].score);
  // Metadaten + Klassifikation
  assert.ok(data.results.every((r) => r.metadata && typeof r.type === 'string'));
  assert.equal(data.results[0].title, 'Photosynthese – Wikipedia');
  // Video-Klassifikation (YouTube + type=video)
  assert.equal(data.videos.length, 1);
  assert.match(data.videos[0].url, /youtube\.com/);
  assert.equal(data.webpages.length, 2);
  // Splitlisten + Combined-Liste konsistent
  assert.equal(data.count, data.results.length);
});

test('POST /api/content/search: topK wird geklemmt, subject/topic validiert', async () => {
  let res = await worker.fetch(req('/api/content/search', { subject: 'x', topic: 'y', topK: 999 }), makeEnv(MATCHES), {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).topK, 20);

  res = await worker.fetch(req('/api/content/search', {}), makeEnv(MATCHES), {});
  assert.equal(res.status, 400);
});

// ---------------------------------------------------------------- /api/content/missions

test('POST /api/content/missions: Duolingo-Style JSON-Array, 4 Typen, Quellenangaben in jeder Mission', async (t) => {
  stubOpenRouter(t, JSON.stringify(MISSIONS));
  const res = await worker.fetch(
    req('/api/content/missions', { subject: 'Biologie', topic: 'Photosynthese', difficulty: 'easy', count: 4 }),
    makeEnv(MATCHES), {});
  assert.equal(res.status, 200);

  const body = await res.json();
  assert.ok(Array.isArray(body), 'Antwort ist ein JSON-Array');
  assert.equal(body.length, 4);

  // Quellenangaben in JEDER Mission
  assert.ok(body.every((m) => Array.isArray(m.sources) && m.sources.length >= 1));
  assert.ok(body.every((m) => m.sources.every((s) => typeof s.source === 'string' && s.source.length > 0)));

  // alle vier Missionstypen
  const types = body.map((m) => m.type);
  for (const tpe of ['quiz', 'zuordnung', 'lueckentext', 'video-link']) assert.ok(types.includes(tpe), 'Typ ' + tpe);
  // Anzeigename
  assert.equal(body.find((m) => m.type === 'lueckentext').typeName, 'Lückentext');
  assert.equal(body.find((m) => m.type === 'video-link').typeName, 'Video-Link');

  // difficulty/subject/topic durchgereicht
  assert.ok(body.every((m) => m.difficulty === 'easy' && m.subject === 'Biologie' && m.topic === 'Photosynthese'));

  // Quiz
  const quiz = body.find((m) => m.type === 'quiz');
  assert.equal(quiz.options.length, 4);
  assert.equal(quiz.correctAnswer, quiz.options[quiz.correctIndex]);

  // Zuordnung
  const z = body.find((m) => m.type === 'zuordnung');
  assert.ok(z.pairs.length >= 2 && z.pairs.every((p) => p.left && p.right));

  // Lückentext: Platzhalter + blanks + answers
  const l = body.find((m) => m.type === 'lueckentext');
  assert.match(l.text, /\[\[1\]\]/);
  assert.match(l.text, /\[\[2\]\]/);
  assert.equal(l.blanks.length, 2);
  assert.deepEqual(l.answers, ['Photosynthese', 'Calvin-Zyklus']);

  // Video-Link
  const v = body.find((m) => m.type === 'video-link');
  assert.match(v.url, /youtube\.com/);
  assert.equal(v.videoUrl, v.url);

  // "[Quelle n]" wird gegen die Retrieval-Quellen aufgelöst
  assert.ok(l.sources.some((s) => s.source.length > 0));
});

test('POST /api/content/missions: LLM-JSON in Markdown-Fences + fehlende sources werden repariert', async (t) => {
  stubOpenRouter(t, (call) => {
    if (call === 1) return '```json\n' + JSON.stringify(MISSIONS) + '\n```';
    return JSON.stringify(MISSIONS);
  });
  const res = await worker.fetch(req('/api/content/missions', { subject: 'Biologie', count: 4 }), makeEnv(MATCHES), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.ok(Array.isArray(body) && body.length === 4);
  assert.ok(body.every((m) => m.sources.length >= 1));
});

test('POST /api/content/missions: Mission ohne sources bekommt Retrieval-Fallback-Quelle', async (t) => {
  stubOpenRouter(t, JSON.stringify([{ type: 'quiz', question: 'Frage?', options: ['a', 'b', 'c', 'd'], correctIndex: 1, correctAnswer: 'b' }]));
  const res = await worker.fetch(req('/api/content/missions', { subject: 'Biologie', count: 1 }), makeEnv(MATCHES), {});
  assert.equal(res.status, 200);
  const body = await res.json();
  assert.equal(body.length, 1);
  assert.ok(Array.isArray(body[0].sources) && body[0].sources.length >= 1, 'Fallback-Quelle injiziert');
});

test('POST /api/content/missions: LLM-Output wird repariert (Retry) oder 502', async (t) => {
  // erst Garbage, dann gueltiges JSON
  stubOpenRouter(t, (call) => (call === 1 ? 'kein JSON' : JSON.stringify(MISSIONS)));
  let res = await worker.fetch(req('/api/content/missions', { subject: 'Biologie', count: 4 }), makeEnv(MATCHES), {});
  assert.equal(res.status, 200);

  // immer Garbage -> 502
  globalThis.fetch = async () => new Response(JSON.stringify({ choices: [{ message: { content: 'nö' } }] }), { status: 200 });
  res = await worker.fetch(req('/api/content/missions', { subject: 'Biologie', count: 4 }), makeEnv(MATCHES), {});
  assert.equal(res.status, 502);
});

test('POST /api/content/missions: subject pflicht, keine Quellen -> 422', async () => {
  let res = await worker.fetch(req('/api/content/missions', { topic: 'x' }), makeEnv(MATCHES), {});
  assert.equal(res.status, 400);

  res = await worker.fetch(req('/api/content/missions', { subject: 'x' }), makeEnv([]), {});
  assert.equal(res.status, 422);
});

test('POST /api/content/missions: LLM-Modell ist openrouter/free', async (t) => {
  const original = globalThis.fetch;
  let seenModel = null;
  globalThis.fetch = async (url, init) => {
    seenModel = JSON.parse(init.body).model;
    return new Response(JSON.stringify({ choices: [{ message: { content: JSON.stringify(MISSIONS) } }] }), { status: 200 });
  };
  t.after(() => { globalThis.fetch = original; });
  const res = await worker.fetch(req('/api/content/missions', { subject: 'Biologie', count: 4 }), makeEnv(MATCHES), {});
  assert.equal(res.status, 200);
  assert.equal(seenModel, 'openrouter/free');
});

// ---------------------------------------------------------------- Scraper-Format

const SCRAPED = {
  subject: 'Physik', topic: 'Mechanik', title: 'Gleichförmige Bewegung',
  type: 'web', url: 'https://www.leifiphysik.de/mechanik/gleichfoermige-bewegung',
  difficulty: 'einfach', source_site: 'leifiphysik.de', text: 'Die gleichförmige Bewegung ... '.repeat(20),
};
const SCRAPED_VIDEO = {
  subject: 'Physik', topic: 'Mechanik', title: 'Kraft und Bewegung',
  type: 'video', url: 'https://www.youtube.com/watch?v=xyz987',
  difficulty: 'schwer', channel: 'Physik Easy', transcript: 'Heute sprechen wir über Kraft ... '.repeat(20), text: 'Heute sprechen wir über Kraft ... '.repeat(20),
};

test('POST /api/rag/index: Scraper-Metadaten bleiben im Vectorize-Upsert erhalten', async () => {
  let upserted = [];
  const env = makeEnv([]);
  env.VECTORIZE_INDEX = { async upsert(u) { upserted.push(...u); return { count: u.length }; } };
  // chunkSize klein -> mehrere Chunks
  const res = await worker.fetch(
    req('/api/rag/index', { docs: [SCRAPED, SCRAPED_VIDEO], chunkSize: 20, chunkOverlap: 0 }),
    env, {});
  assert.equal(res.status, 200);
  assert.equal((await res.json()).indexed, upserted.length);
  assert.ok(upserted.length > 2);

  const web = upserted.find((u) => u.metadata.title === SCRAPED.title);
  assert.ok(web, 'Web-Dokument indexiert');
  assert.equal(web.metadata.subject, 'Physik');
  assert.equal(web.metadata.topic, 'Mechanik');
  assert.equal(web.metadata.type, 'web');
  assert.equal(web.metadata.url, SCRAPED.url);
  assert.equal(web.metadata.difficulty, 'einfach');
  assert.equal(web.metadata.source_site, 'leifiphysik.de');
  assert.equal(web.metadata.source, SCRAPED.url);
  assert.ok(web.metadata.text.length > 0);

  const video = upserted.find((u) => u.metadata.title === SCRAPED_VIDEO.title);
  assert.ok(video, 'Video-Dokument indexiert (text fehlt -> transcript)');
  assert.equal(video.metadata.type, 'video');
  assert.equal(video.metadata.channel, 'Physik Easy');
  assert.equal(video.metadata.difficulty, 'schwer');
  assert.equal(video.metadata.source, SCRAPED_VIDEO.url);
});

test('POST /api/content/search: Scraper-Metadaten + Fach/Thema-Ranking', async () => {
  const env = makeEnv([
    { id: 'b1', score: 0.95, metadata: { ...SCRAPED, title: 'Fremdfach', subject: 'Chemie', topic: 'Bindungen', url: 'https://chemglobe.org/x', source: 'https://chemglobe.org/x' } },
    { id: 'b2', score: 0.80, metadata: { ...SCRAPED, text: 'Passender Inhalt', source: SCRAPED.url } },
    { id: 'b3', score: 0.85, metadata: { ...SCRAPED_VIDEO, source: SCRAPED_VIDEO.url } },
  ]);
  const res = await worker.fetch(req('/api/content/search', { subject: 'Physik', topic: 'Mechanik', topK: 3 }), env, {});
  assert.equal(res.status, 200);
  const data = await res.json();

  // Treffer mit passendem Fach/Thema werden vorgezogen, auch bei niedrigerem Score
  assert.equal(data.results[0].subject, 'Physik');
  assert.equal(data.results[0].topic, 'Mechanik');
  const fremd = data.results.find((r) => r.title === 'Fremdfach');
  assert.ok(fremd && data.results[0].score < fremd.score, 'Fach/Thema-Ranking vor Score');

  // Metadaten aus dem Scraper (Web-Treffer anhand URL suchen: Video hat hoeheren Score)
  const web = data.results.find((r) => r.url === SCRAPED.url);
  assert.ok(web, 'Web-Treffer vorhanden');
  assert.equal(web.difficulty, 'einfach');
  assert.equal(web.title, SCRAPED.title);

  // type: "web" -> webpage, type: "video" -> video
  assert.equal(data.webpages.some((r) => r.url === SCRAPED.url), true);
  assert.equal(data.videos.some((r) => r.url === SCRAPED_VIDEO.url), true);
});
