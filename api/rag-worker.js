// Cloudflare Worker: RAG-Pipeline (api/rag-worker.js)
//
// Endpunkte:
//   POST /api/rag/index -> { content, source?, chunkSize?, chunkOverlap?, docs? }
//       Inhalt -> Chunking -> Embedding -> Vectorize-Upsert;
//       Metadaten (subject/topic/title/type/url/difficulty/...) pro Dokument bleiben erhalten
//   POST /api/rag/query -> { question, topK? }
//       Frage -> Embedding -> Vectorize-Retrieval -> LLM (openrouter/free) ->
//       { answer, sources: [{ source, excerpt, score }] }
//   POST /api/content/search -> { subject, topic, topK? }
//       Themen-Suche -> Embedding -> Vectorize-Retrieval ->
//       passende Videos/Webseiten mit Metadaten:
//       { results, videos, webpages, count, ... };
//       Treffer: { type: "video"|"webpage", title, url, source, excerpt, score, metadata }
//   POST /api/content/missions -> { subject, topic?, difficulty?, count? }
//       Themen-RAG -> LLM (openrouter/free) ->
//       Duolingo-Style Lern-Missionen als JSON-Array:
//       [{ id, type, typeName, title, instruction, difficulty, subject, topic,
//          ..., sources: [{ source, title?, url?, excerpt?, score? }] }];
//       type: "quiz" | "zuordnung" | "lueckentext" | "video-link"
//       quiz       -> { question, options, correctIndex, correctAnswer, explanation }
//       zuordnung  -> { pairs: [{ left, right }] }
//       lueckentext-> { text ("[[n]]"-Luecken), blanks: [{ id, answer, hint? }], answers, wordBank? }
//       video-link -> { url, videoUrl, title, question?, answer?, explanation? }
//       Quellenangaben (sources, >=1) sind in JEDER Mission enthalten.
//
// Services / Modelle:
//   Embedding : @cf/baai/bge-base-en-v1.5 via Cloudflare Workers AI (env.AI.run)
//   LLM       : openrouter/free via OpenRouter
//               (https://openrouter.ai/api/v1/chat/completions)
//   Vektordatenbank : Cloudflare Vectorize (Service-Binding, Standard-Name: VECTORIZE_INDEX)
//
// Env / Secrets:
//   AI                 (Binding) - Cloudflare Workers AI (Embeddings)
//   OPENROUTER_API_KEY (Secret) - Bearer-Token fuer OpenRouter
//   VECTORIZE_INDEX    (Binding) - Vectorize-Index-Objekt
//   EMBED_DIM          (Vars)   - Vektor-Dimension (muss zum Index passen; Standard 768)
//   RAG_CHUNK_SIZE     (Vars)   - Wortzahl pro Chunk (Standard 500)
//   RAG_CHUNK_OVERLAP  (Vars)   - Overlap zwischen benachbarten Chunks in Wörtern (Standard 50)
//
// Hinweis zum PDF-Pipeline: PDF -> Text (z. B. mit pdf-lib) geschieht vorgelagernt;
// dieser Worker nimmt Plain Text / Notizen entgegen.

const CF_EMBED_MODEL = '@cf/baai/bge-base-en-v1.5';
const OPENROUTER_BASE = 'https://openrouter.ai/api/v1/chat/completions';
const OPENROUTER_MODEL = 'openrouter/free';
const DEFAULT_DIM = 768; // EMBED_DIM ueberschreiben, wenn der Index eine andere Dimension hat

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '600',
};

function corsHeaders() {
  return Object.assign({}, CORS_HEADERS);
}

function json(data, status) {
  return new Response(JSON.stringify(data == null ? {} : data), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      corsHeaders(),
    ),
  });
}

function error(message, status) {
  return json({ error: message || 'Fehler' }, status || 400);
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  try {
    return JSON.parse(text);
  } catch {
    throw Object.assign(new Error('Ungueltiger JSON-Body'), { status: 400 });
  }
}

function intOr(value, fallback) {
  const n = parseInt(value, 10);
  return Number.isFinite(n) ? n : fallback;
}

// ------------------------------------------------------------------ Chunking

// Wortbasiertes Chunking mit Overlap. Paragraphen bleiben als Trennung,
// inhaltlich ist die Wort-Gruppierung einfach, aber robust.
function chunkText(text, chunkSize, overlap) {
  const size = Math.max(intOr(chunkSize, 500), 20);
  const ov = Math.max(0, Math.min(intOr(overlap, 50), size - 1));
  const words = String(text || '')
    .split(/\s+/)
    .map((w) => w.trim())
    .filter(Boolean);
  if (!words.length) return [];

  const out = [];
  let cur = [];
  for (const w of words) {
    cur.push(w);
    if (cur.length >= size) {
      out.push(cur.join(' '));
      cur = cur.slice(Math.max(0, cur.length - ov));
    }
  }
  if (cur.length) out.push(cur.join(' '));
  return out;
}

// Deterministische, kurze ID: gleicher Chunk+Quelle -> gleiche ID (Re-Index replace).
function vectorId(text, source) {
  let h = 5381;
  const s = String(source || '') + '\n' + String(text || '');
  for (let i = 0; i < s.length; i++) {
    h = ((h << 5) + h + s.charCodeAt(i)) >>> 0;
  }
  return 'rag-' + h.toString(16).padStart(8, '0');
}

// ------------------------------------------------------------------ Embedding

// Tolerante Extraktion der Vektoren aus den HF-Inference-Antwortformaten:
//   [[v1], [v2]] | [{ embedding: [...] }] | { embeddings: [[...]] }
//   { data: [{ embedding: [...] }] } | flaches [0.1, ...] (Eingabe als String)
function extractVectors(data, expected) {
  let list = null;
  if (Array.isArray(data)) {
    if (data.length && Array.isArray(data[0])) list = data;
    else if (data.length && data[0] && Array.isArray(data[0].embedding)) {
      list = data.map((d) => d.embedding);
    } else if (data.every((v) => typeof v === 'number')) list = [data];
  } else if (data && typeof data === 'object') {
    if (Array.isArray(data.embeddings)) list = data.embeddings;
    else if (Array.isArray(data.data)) list = data.data.map((d) => d.embedding).filter(Array.isArray);
  }
  const vectors = (list || []).map((v) => v.map((x) => Number(x)));
  if (expected != null && vectors.length !== expected) return [];
  return vectors;
}

async function embedTexts(env, texts) {
  const inputs = Array.isArray(texts) ? texts : [texts];
  if (!inputs.length || inputs.some((t) => !String(t || '').trim())) {
    throw new Error('Leerer Text fuer Embedding');
  }
  const ai = env && env.AI;
  if (!ai) throw new Error('AI-Binding nicht konfiguriert');
  const res = await ai.run(CF_EMBED_MODEL, { text: inputs });
  const vectors = (res && res.data) ? res.data : [];
  if (vectors.length !== inputs.length) {
    throw new Error('Embedding lieferte ' + vectors.length + ' statt ' + inputs.length + ' Vektoren');
  }
  return vectors.map(v => Array.from(v));
}

// ------------------------------------------------------------------ Vectorize

function vectorize(env) {
  if (!env || !env.VECTORIZE_INDEX) {
    throw new Error('Vectorize-Binding VECTORIZE_INDEX ist nicht konfiguriert');
  }
  return env.VECTORIZE_INDEX;
}

// ------------------------------------------------------------------ Endpoints

// Skalare Metadaten (z. B. aus dem Bildungs-Content-Scraper) in Vectorize
// mitnehmen: subject/topic/title/type/url/difficulty/... werden von den
// Content-Endpunkten fuer Treffer und Quellenangaben benoetigt.
const PASSTHROUGH_METADATA_KEYS = [
  'subject', 'topic', 'title', 'type', 'url', 'difficulty',
  'source_site', 'sourceSite', 'channel', 'video_id', 'language',
  'kind', 'mediaType', 'format', 'contentType',
];

function passthroughMetadata(doc) {
  const out = {};
  for (const key of PASSTHROUGH_METADATA_KEYS) {
    const v = doc && doc[key];
    if (v == null) continue;
    if (typeof v === 'string' || typeof v === 'number' || typeof v === 'boolean') out[key] = v;
  }
  return out;
}

async function handleIndex(env, request) {
  const body = await readJson(request);
  const source = String(body.source || body.docId || body.filename || '').trim();
  const chunkSize = intOr(body.chunkSize, intOr(env && env.RAG_CHUNK_SIZE, 500));
  const overlap = intOr(body.chunkOverlap, intOr(env && env.RAG_CHUNK_OVERLAP, 50));
  const docs = Array.isArray(body.docs) ? body.docs : [body];

  let indexed = 0;
  for (const doc of docs) {
    const text = String((doc && doc.content) || (doc && doc.text) || (doc && doc.body) || (doc && doc.transcript) || '');
    if (!text.trim()) return error('content fehlt (im Body oder in docs[])');
    const chunks = chunkText(text, chunkSize, overlap);
    if (!chunks.length) return error('Keine Chunks aus dem Inhalt erzeugt');

    // Pro Dokument eigene Quelle: scraped Records liefern url/title, kein source.
    const docSource = String(
      (doc && (doc.source || doc.url || doc.source_url || doc.link)) || source || '',
    ).trim();
    const vectors = await embedTexts(env, chunks);
    const upserts = chunks.map((chunk, i) => ({
      id: vectorId(chunk, docSource),
      values: vectors[i],
      metadata: Object.assign(
        { source: docSource || null, index: i, text: chunk },
        passthroughMetadata(doc),
      ),
    }));
    const res = await vectorize(env).upsert(upserts);
    indexed += res && res.count ? res.count : upserts.length;
  }
  return json({ indexed, source: source || null });
}

async function handleQuery(env, request) {
  const body = await readJson(request);
  const question = String(body.question || body.query || '').trim();
  if (!question) return error('Frage fehlt (question)');

  const topK = Math.min(Math.max(intOr(body.topK, 4), 1), 20);
  const [vector] = await embedTexts(env, [question]);
  const dim = intOr(env && env.EMBED_DIM, DEFAULT_DIM);
  if (vector.length !== dim) {
    throw new Error('Embedding-Dimension (' + vector.length + ') weicht von EMBED_DIM (' + dim + ') ab');
  }

  const index = vectorize(env);
  const results = await index.query(vector, { topK, returnMetadata: true, returnValues: false });
  const matches = (results && results.matches) || [];
  const sources = matches.map((m) => ({
    source: (m.metadata && m.metadata.source) || null,
    excerpt: (m.metadata && (m.metadata.text || m.metadata.chunk || '')) || '',
    score: m.score,
  }));

  if (!matches.length) {
    return json({ answer: 'Es gibt zu dieser Frage noch keine Quellen im Index.', sources: [] });
  }

  const context = matches
    .map((m, i) => '[Quelle ' + (i + 1) + '] ' + ((m.metadata && (m.metadata.text || m.metadata.chunk)) || ''))
    .join('\n\n');

  const systemPrompt =
    'Du bist ein hilfreicher Assistent, der nur auf die bereitgestellten Quellen antwortet. ' +
    'Beantworte die Frage in 1-3 Sätzen. Wenn eine Aussage nicht aus den Quellen folgt, ' +
    'sage das ausdrücklich. Zitiere die Quellennummern als [Quelle n] in der Antwort.';
  const userPrompt = 'Frage: ' + question + '\n\nQuellen:\n' + context + '\n\nAntwort:';

  const answer = (await callLLM(env, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.2,
    maxTokens: 800,
  })).trim() || 'Es konnte keine Antwort generiert werden.';

  return json({ answer, sources });
}

// ------------------------------------------------------------------ LLM (OpenRouter)

async function callLLM(env, opts) {
  const key = env && env.OPENROUTER_API_KEY;
  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      key ? { Authorization: 'Bearer ' + String(key) } : {},
    ),
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: opts.messages,
      temperature: opts.temperature != null ? opts.temperature : 0.2,
      max_tokens: opts.maxTokens || 800,
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error('OpenRouter-LLM fehlgeschlagen (HTTP ' + res.status + ')'), { status: 502 });
  }
  const data = await res.json().catch(() => ({}));
  return ((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '');
}

// Tolerantes JSON-Parsing fuer LLM-Antworten:
// Markdown-Fences strippen, erstes [ ... letztes ] / { ... } schneiden,
// Trailing Commas entfernen.
function extractJson(text) {
  if (!text) return null;
  let s = String(text).trim();
  s = s.replace(/^```(?:json)?\s*/i, '').replace(/```\s*$/i, '').trim();
  try { return JSON.parse(s); } catch { /* weiter probieren */ }
  const attempts = [];
  const a = s.indexOf('['); const b = s.lastIndexOf(']');
  if (a !== -1 && b > a) attempts.push(s.slice(a, b + 1));
  const c = s.indexOf('{'); const d = s.lastIndexOf('}');
  if (c !== -1 && d > c) attempts.push(s.slice(c, d + 1));
  for (const cand of attempts) {
    try { return JSON.parse(cand); } catch { /* weiter probieren */ }
    try { return JSON.parse(cand.replace(/,\s*([}\]])/g, '$1')); } catch { /* weiter probieren */ }
  }
  return null;
}

// ------------------------------------------------------------------ Content-Suche / Lern-Missionen

// Video-Hosts (Subdomains inklusive) und Video-Dateiendungen fuer die Klassifikation.
const VIDEO_HOSTS = [
  'youtube.com', 'youtu.be', 'youtube-nocookie.com', 'vimeo.com', 'dailymotion.com',
  'twitch.tv', 'loom.com', 'wistia.com', 'wistia.net', 'vidyard.com', 'brightcove.com',
  'kaltura.com', 'tiktok.com', 'rumble.com', 'odysee.com', 'peertube', 'streamable.com',
  'mux.com', 'jwplayer.com', 'cloudflarestream.com', 'videopress.com',
];
const VIDEO_EXTENSIONS = ['.mp4', '.webm', '.mov', '.mkv', '.avi', '.m4v', '.ogv', '.3gp', '.mpg', '.mpeg', '.flv', '.wmv', '.m3u8'];

// Missionstypen (maschinenlesbar) + Anzeigename.
const MISSION_TYPES = ['quiz', 'zuordnung', 'lueckentext', 'video-link'];
const MISSION_TYPE_NAMES = {
  'quiz': 'Quiz',
  'zuordnung': 'Zuordnung',
  'lueckentext': 'Lückentext',
  'video-link': 'Video-Link',
};

function clampInt(value, fallback, min, max) {
  const n = intOr(value, fallback);
  return Math.min(Math.max(n, min), max);
}

function isVideoContent(meta, sourceUrl) {
  const m = meta || {};
  const t = String(m.type || m.mediaType || m.kind || m.format || m.contentType || '').toLowerCase();
  if (t.includes('video')) return true;
  const s = String(m.url || sourceUrl || '').toLowerCase().split('?')[0].split('#')[0];
  if (VIDEO_EXTENSIONS.some((ext) => s.endsWith(ext))) return true;
  try {
    const host = new URL(String(m.url || sourceUrl || '')).hostname.toLowerCase();
    return VIDEO_HOSTS.some((h) => host === h || host.endsWith('.' + h) || host.includes(h));
  } catch { return false; }
}

function sourceTitle(meta, source) {
  const m = meta || {};
  const t = m.title || m.name || m.headline || m.filename || '';
  if (String(t).trim()) return String(t).trim();
  return String(source || '').trim() || null;
}

// Retrieval: Embedding -> Vectorize-Query. Liefert rohe Matches.
async function retrieveMatches(env, queryText, topK) {
  const [vector] = await embedTexts(env, [queryText]);
  const dim = intOr(env && env.EMBED_DIM, DEFAULT_DIM);
  if (vector.length !== dim) {
    throw new Error('Embedding-Dimension (' + vector.length + ') weicht von EMBED_DIM (' + dim + ') ab');
  }
  const results = await vectorize(env).query(vector, { topK, returnMetadata: true, returnValues: false });
  return (results && results.matches) || [];
}

// Vectorize-Match -> normalisierte Quelle / Suchtreffer.
function sourceFromMatch(m) {
  const meta = (m && m.metadata) || {};
  const source = (meta.source != null && String(meta.source)) || null;
  const rawUrl = meta.url || meta.link || (source && /^https?:\/\//i.test(source) ? source : null) || null;
  const url = rawUrl ? String(rawUrl) : null;
  const video = isVideoContent(meta, url || source);
  return {
    source: source,
    title: sourceTitle(meta, source),
    url: url,
    type: video ? 'video' : 'webpage',
    subject: meta.subject ? String(meta.subject) : null,
    topic: meta.topic ? String(meta.topic) : null,
    difficulty: meta.difficulty ? String(meta.difficulty) : null,
    excerpt: String(meta.text || meta.chunk || meta.excerpt || meta.transcript || ''),
    score: typeof (m && m.score) === 'number' ? m.score : null,
    metadata: meta,
  };
}

// Dedupe: ein Treffer pro Quelle (bester Score gewinnt).
function dedupeSources(list) {
  const byKey = new Map();
  for (const r of list) {
    const key = (r.url || r.source || '').toLowerCase() || JSON.stringify(r.metadata || {});
    const prev = byKey.get(key);
    if (!prev || (r.score != null && (prev.score == null || r.score > prev.score))) {
      const merged = prev ? Object.assign({}, prev, r) : r;
      byKey.set(key, merged);
    } else if (prev && r.excerpt && !prev.excerpt) {
      prev.excerpt = r.excerpt;
    }
  }
  return Array.from(byKey.values()).sort((a, b) => (b.score || 0) - (a.score || 0));
}

// Fach/Thema aus den Scraper-Metadaten als Ranking-Vorzug (weich, nicht
// hartes Filtern: semantisch verwandte Quellen bleiben erhalten).
function rankSources(list, subject, topic) {
  function rank(r) {
    let v = 0;
    for (const [key, value] of [['subject', subject], ['topic', topic]]) {
      if (!value || !r[key]) continue;
      const a = String(r[key]).toLowerCase();
      const b = String(value).toLowerCase();
      if (a === b) v += 4;
      else if (a.includes(b) || b.includes(a)) v += 2;
    }
    return v;
  }
  return list.slice().sort((a, b) => (rank(b) - rank(a)) || ((b.score || 0) - (a.score || 0)));
}

// ---------------------------------------------------------------- /api/content/search

async function handleContentSearch(env, request) {
  const body = await readJson(request);
  const subject = String(body.subject || '').trim();
  const topic = String(body.topic || body.theme || body.thema || '').trim();
  if (!subject && !topic) return error('subject oder topic fehlt');

  const topK = clampInt(body.topK, 4, 1, 20);
  const queryText = [subject, topic].filter(Boolean).join(' ');

  const matches = await retrieveMatches(env, queryText, topK);
  const results = rankSources(dedupeSources(matches.map(sourceFromMatch)), subject, topic);
  const videos = results.filter((r) => r.type === 'video');
  const webpages = results.filter((r) => r.type === 'webpage');

  return json({
    subject: subject || null,
    topic: topic || null,
    query: queryText,
    topK,
    count: results.length,
    results,
    videos,
    webpages,
  });
}

// ---------------------------------------------------------------- /api/content/missions

function normalizeMissionType(t) {
  const s = String(t || '').toLowerCase().trim().replace(/[_\s]+/g, '-');
  if (s === 'quiz' || s === 'multiple-choice' || s === 'multiplechoice' || s === 'single-choice') return 'quiz';
  if (s === 'zuordnung' || s === 'matching' || s === 'pairs' || s === 'pair' || s === 'match') return 'zuordnung';
  if (s === 'lueckentext' || s === 'lückentext' || s === 'cloze' || s === 'fill-in-the-blank' || s === 'fill-in-blank' || s === 'gap-fill' || s === 'luecke' || s === 'gap' || s === 'fill') return 'lueckentext';
  if (s === 'video-link' || s === 'videolink' || s === 'video' || s === 'video-url' || s === 'link-video') return 'video-link';
  return 'quiz'; // unbekannt -> Quiz
}

// Quellenangaben einer Mission normalisieren; garantiert nicht-leeres sources[].
// Versteht Strings ("[Quelle n]", Quellenname, URL) und Objekte.
function normalizeMissionSources(input, retrieved, fallback) {
  const list = Array.isArray(input) ? input : (input != null && input !== '' ? [input] : []);
  const out = [];
  const seen = new Set();

  function push(entry) {
    if (!entry) return;
    const e = typeof entry === 'string' ? { source: entry } : entry;
    const source = String(e.source || e.name || e.title || e.url || e.sourceName || '').trim();
    if (!source) return;
    const key = source.toLowerCase();
    if (seen.has(key)) return;
    seen.add(key);
    out.push({
      source,
      title: e.title ? String(e.title) : null,
      url: e.url ? String(e.url) : (/^https?:\/\//i.test(source) ? source : null),
      excerpt: e.excerpt ? String(e.excerpt) : (e.quote ? String(e.quote) : null),
      score: typeof e.score === 'number' ? e.score : null,
    });
  }

  for (const item of list) {
    if (typeof item === 'string') {
      const s = item.trim();
      // "[Quelle n]" / "Quelle n" / "Source n" -> n-te Retrieval-Quelle
      const m = /\[?\s*(?:quelle|source)\s*(\d+)\s*\]?/i.exec(s);
      if (m && retrieved[Number(m[1]) - 1]) { push(minimalSource(retrieved[Number(m[1]) - 1])); continue; }
      // exakter Name/URL-Match gegen Retrieval
      const found = retrieved.find((r) =>
        (r.source && r.source.toLowerCase() === s.toLowerCase()) ||
        (r.url && r.url.toLowerCase() === s.toLowerCase()) ||
        (r.title && r.title.toLowerCase() === s.toLowerCase()));
      if (found) { push(minimalSource(found)); continue; }
      push({ source: s });
    } else if (item && typeof item === 'object') {
      // numerischer Verweis { quelle: n } / { source: n } / { id: n }
      const ref = item.quelle != null ? item.quelle : (item.sourceRef != null ? item.sourceRef : null);
      if (typeof item.source === 'number' || typeof ref === 'number' || (typeof item.id === 'number')) {
        const idx = Number(typeof item.source === 'number' ? item.source : (ref != null ? ref : item.id)) - 1;
        if (retrieved[idx]) { push(minimalSource(retrieved[idx])); continue; }
      }
      push(item);
    }
  }

  if (!out.length && fallback) push(minimalSource(fallback));
  return out;
}

function minimalSource(r) {
  return {
    source: r.source || r.url || r.title || 'unbekannt',
    title: r.title || null,
    url: r.url || null,
    type: r.type || null,
    subject: r.subject || null,
    topic: r.topic || null,
    difficulty: r.difficulty || null,
    excerpt: r.excerpt || null,
    score: typeof r.score === 'number' ? r.score : null,
  };
}

function strArray(v) {
  return (Array.isArray(v) ? v : []).map((x) => String(x).trim()).filter(Boolean);
}

// LLM-Rohmission -> stabile Struktur; garantiert sources.length >= 1.
function normalizeMission(raw, idx, ctx) {
  const m = (raw && typeof raw === 'object') ? raw : {};
  const type = normalizeMissionType(m.type || m.kind || m.missionType);
  const retrieved = ctx.retrieved;
  const mission = {
    id: String(m.id || '').trim() || ('m' + (idx + 1)),
    type,
    typeName: MISSION_TYPE_NAMES[type],
    title: String(m.title || m.name || m.headline || '').trim() || (MISSION_TYPE_NAMES[type] + ' ' + (idx + 1)),
    instruction: String(m.instruction || m.prompt || m.task || m.anweisung || '').trim() || defaultInstruction(type),
    difficulty: ctx.difficulty, // Schwierigkeit kommt aus dem Request, nicht vom LLM
    subject: ctx.subject || null,
    topic: ctx.topic || null,
  };

  if (type === 'quiz') {
    const options = strArray(m.options || m.choices || m.answers || m.antworten).slice(0, 6);
    let correctIndex = -1;
    if (Number.isInteger(m.correctIndex)) correctIndex = m.correctIndex;
    else if (Number.isInteger(m.correct_index)) correctIndex = m.correct_index;
    else if (Number.isInteger(m.correctOption)) correctIndex = m.correctOption;
    else if (typeof m.correctAnswer === 'number') correctIndex = m.correctAnswer;
    const answerStr = String(m.correctAnswer || m.answer || m.solution || '').trim();
    if (correctIndex < 0 && answerStr && options.length) {
      correctIndex = options.findIndex((o) => o.toLowerCase() === answerStr.toLowerCase());
    }
    if (correctIndex < 0) correctIndex = 0;
    if (options.length && correctIndex >= options.length) correctIndex = options.length - 1;
    mission.question = String(m.question || m.prompt || m.title || '').trim();
    mission.options = options;
    mission.correctIndex = options.length ? correctIndex : null;
    mission.correctAnswer = options.length ? options[correctIndex] : answerStr;
    mission.explanation = String(m.explanation || m.feedback || m.hint || '').trim();
  } else if (type === 'zuordnung') {
    let pairs = Array.isArray(m.pairs) ? m.pairs : (Array.isArray(m.matches) ? m.matches : []);
    pairs = pairs
      .map((p) => (p && typeof p === 'object')
        ? { left: String(p.left || p.a || p.term || p.begriff || p.key || '').trim(), right: String(p.right || p.b || p.definition || p.match || p.value || p.partner || '').trim() }
        : null)
      .filter((p) => p && p.left && p.right);
    mission.pairs = pairs;
    // zusaetzlich gemischte Spalten, falls noetig
    mission.leftItems = pairs.map((p) => p.left);
    mission.rightItems = pairs.map((p) => p.right);
  } else if (type === 'lueckentext') {
    let text = String(m.text || m.cloze || m.sentence || m.satz || '').trim();
    let blanks = Array.isArray(m.blanks) ? m.blanks : (Array.isArray(m.gaps) ? m.gaps : (Array.isArray(m.luecken) ? m.luecken : []));
    blanks = blanks.map((b, i) => {
      if (b && typeof b === 'object') {
        return {
          id: Number.isInteger(b.id) ? b.id : i + 1,
          answer: String(b.answer || b.solution || b.value || b.text || '').trim(),
          hint: b.hint ? String(b.hint) : null,
        };
      }
      return { id: i + 1, answer: String(b || '').trim(), hint: null };
    }).filter((b) => b.answer);
    // aus ordered answers[] rekonstruieren, wenn blanks fehlen
    if (!blanks.length) {
      const answers = strArray(m.answers || m.solutions || m.antworten);
      blanks = answers.map((a, i) => ({ id: i + 1, answer: a, hint: null }));
    }
    // Platzhalter normalisieren: ___, ....., {} -> [[n]] (falls nicht schon [[n]])
    if (text && blanks.length && !/\[\[\d+\]\]/.test(text)) {
      let n = 0;
      text = text.replace(/(_{2,}|\.{3,}|\{\}|\[\s*\]|\(\s*\)|…+)/g, () => '[[' + (++n) + ']]');
    }
    mission.text = text;
    mission.blanks = blanks;
    mission.answers = blanks.map((b) => b.answer);
    const bank = strArray(m.wordBank || m.word_bank || m.bank || m.options);
    if (bank.length) mission.wordBank = bank;
  } else if (type === 'video-link') {
    const url = String(m.url || m.videoUrl || m.video_url || m.link || '').trim();
    const videoSource = retrieved.find((r) => r.type === 'video' && (r.url || r.source));
    const fallbackUrl = videoSource ? (videoSource.url || videoSource.source) : (retrieved[0] ? (retrieved[0].url || retrieved[0].source) : null);
    mission.url = url || fallbackUrl || null;
    mission.videoUrl = mission.url;
    mission.videoTitle = String(m.videoTitle || m.title || '').trim() || (videoSource ? videoSource.title : null);
    if (m.question) mission.question = String(m.question).trim();
    if (m.answer || m.correctAnswer) mission.answer = String(m.answer || m.correctAnswer).trim();
    if (m.explanation) mission.explanation = String(m.explanation).trim();
  }

  // Quellenangaben in JEDER Mission (>= 1); LLM-Angaben gegen Retrieval pruefen.
  const rawSources = m.sources != null ? m.sources : (m.quellen != null ? m.quellen : m.source);
  mission.sources = normalizeMissionSources(rawSources, retrieved, retrieved[0] || null);

  return mission;
}

function defaultInstruction(type) {
  if (type === 'quiz') return 'Wähle die richtige Antwort.';
  if (type === 'zuordnung') return 'Ordne die passenden Paare einander zu.';
  if (type === 'lueckentext') return 'Fülle die Lücken mit den richtigen Begriffen.';
  return 'Schau dir das verlinkte Video an.';
}

async function handleContentMissions(env, request) {
  const body = await readJson(request);
  const subject = String(body.subject || '').trim();
  const topic = String(body.topic || body.theme || body.thema || '').trim();
  if (!subject) return error('subject fehlt (subject)');
  const difficulty = String(body.difficulty || 'medium').trim() || 'medium';
  const count = clampInt(body.count, 4, 1, 20);
  const queryText = [subject, topic].filter(Boolean).join(' ');

  const topK = clampInt(body.topK, Math.max(8, count * 2), 4, 20);
  const matches = await retrieveMatches(env, queryText, topK);

  if (!matches.length) {
    return error('Keine Quellen im Index für dieses Thema gefunden – Missionen können nicht mit Quellenangaben erstellt werden.', 422);
  }

  const retrieved = rankSources(dedupeSources(matches.map(sourceFromMatch)), subject, topic);
  const videoSources = retrieved.filter((r) => r.type === 'video');

  // Kontext mit nummerierten Quellen [Quelle n] aufbauen.
  const context = retrieved
    .map((r, i) =>
      '[Quelle ' + (i + 1) + ']' +
      (r.type === 'video' ? ' (VIDEO)' : ' (WEBSEITE)') +
      ' ' + (r.title || r.source || '') +
      (r.subject ? ' | Fach: ' + r.subject : '') +
      (r.topic ? ' | Thema: ' + r.topic : '') +
      (r.difficulty ? ' | Schwierigkeit: ' + r.difficulty : '') +
      (r.url ? ' | ' + r.url : (r.source && !/^https?:\/\//i.test(r.source) ? ' | ' + r.source : '')) +
      '\n' + (r.excerpt || '').slice(0, 800))
    .join('\n\n');

  const systemPrompt =
    'Du bist ein Lern-Designer im Stil von Duolingo. Erstelle aus den bereitgestellten Quellen ' +
    'genau ' + count + ' Lern-Missionen zum Thema. Sprache der Missionen: Deutsch. ' +
    'Antworte AUSSCHLIESSLICH mit einem JSON-Array (kein Markdown, kein Fließtext, keine Erklärung außerhalb des JSON). ' +
    'Jede Mission ist ein JSON-Objekt mit folgenden Feldern:\n' +
    '- "id": "m1", "m2", ...\n' +
    '- "type": genau einer von "quiz" | "zuordnung" | "lueckentext" | "video-link"\n' +
    '- "title": kurzer Titel\n' +
    '- "instruction": kurze Anweisung für den Lernenden\n' +
    '- "difficulty": "' + difficulty + '"\n' +
    '- "sources": Array mit MINDESTENS EINER Quellenangabe; jede Quellenangabe ist ein Objekt ' +
    '{ "source": EXAKTER Quellenname aus der Quellenliste, "title": ..., "url": ..., "excerpt": kurzes wörtliches Zitat aus der Quelle }. ' +
    'Nur Quellen aus der bereitgestellten Liste verwenden. KEINE Mission ohne Quellenangabe.\n' +
    'Typ-spezifische Felder:\n' +
    '- quiz: "question", "options" (genau 4 Antwortoptionen), "correctIndex" (0-3), "correctAnswer", "explanation"\n' +
    '- zuordnung: "pairs": [{"left": ..., "right": ...}] mit 3-6 Paaren; zufällig, nicht sortiert\n' +
    '- lueckentext: "text" mit nummerierten Lücken [[1]], [[2]], ..., "blanks": [{"id": n, "answer": ..., "hint": ...}], ' +
    '"answers": [...] in Lücken-Reihenfolge, optional "wordBank": [...]\n' +
    '- video-link: "url" (Video-URL aus den Quellen; bevorzugt VIDEO-markierte Quellen), "videoUrl", "title", ' +
    'optional "question" + "answer" + "explanation"\n' +
    (count >= MISSION_TYPES.length
      ? 'Stelle sicher, dass ALLE 4 Typen (quiz, zuordnung, lueckentext, video-link) mindestens einmal vorkommen.\n'
      : '') +
    'Schwierigkeit "' + difficulty + '": ' + difficultyHint(difficulty) + '\n' +
    'Alle Inhalte (Fragen, Antworten, Paare, Lücken, Begriffe) MÜSSEN in den Quellen belegt sein.';

  const videoNote = videoSources.length
    ? '\n\nVIDEO-QUELLEN (für video-link-Missionen bevorzugt):\n' +
      videoSources.map((v) => '- ' + (v.title || v.source) + (v.url ? ' | ' + v.url : '')).join('\n')
    : '\n\nEs sind keine Video-Quellen im Index; für video-link-Missionen die relevanteste Webseiten-URL verlinken.';

  const userPrompt =
    'Fach: ' + subject + '\n' +
    'Thema: ' + (topic || subject) + '\n' +
    'Schwierigkeit: ' + difficulty + '\n' +
    'Anzahl Missionen: ' + count + '\n\n' +
    'QUELLEN:\n' + context + videoNote + '\n\n' +
    'Erstelle jetzt das JSON-Array mit genau ' + count + ' Missionen.';

  let missions = await generateMissions(env, systemPrompt, userPrompt, count);

  const ctx = { retrieved, difficulty, subject, topic: topic || null };
  let out = missions.slice(0, count).map((m, i) => normalizeMission(m, i, ctx));

  // Sicherheitsnetz: jede Mission MUSS sources haben (normalizeMission garantiert das bereits).
  out = out.filter((m) => Array.isArray(m.sources) && m.sources.length > 0);

  return json(out);
}

function difficultyHint(difficulty) {
  const d = String(difficulty || '').toLowerCase();
  if (['easy', 'leicht', 'einfach', 'anfänger', 'anfaenger', 'beginner', '1'].includes(d)) {
    return 'einfache Sprache, klare kurze Antworten, wenige Optionen, kein Fachjargon ohne Erklärung.';
  }
  if (['hard', 'schwer', 'fortgeschritten', 'advanced', 'schwierig', '3', 'expert'].includes(d)) {
    return 'anspruchsvoll, Transfer-Fragen, feinere Unterschiede, längere Lücken, plausible Distraktoren.';
  }
  return 'mittleres Niveau, fachlich korrekt, eindeutige Antworten, solide Distraktoren.';
}

// LLM-Call + robustes JSON-Parsing; ein Retry mit verschärftem Prompt bei Parse-Fehler.
async function generateMissions(env, systemPrompt, userPrompt, count) {
  let parsed = extractJson(await callLLM(env, {
    messages: [
      { role: 'system', content: systemPrompt },
      { role: 'user', content: userPrompt },
    ],
    temperature: 0.4,
    maxTokens: Math.min(8000, 600 * count + 1000),
  }));

  if (!missionsFromParsed(parsed).length) {
    parsed = extractJson(await callLLM(env, {
      messages: [
        { role: 'system', content: systemPrompt + '\nWICHTIG: Antworte NUR mit dem JSON-Array, absolut kein Text davor oder danach.' },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      maxTokens: Math.min(8000, 600 * count + 1000),
    }));
  }

  const missions = missionsFromParsed(parsed);
  if (!missions.length) {
    throw Object.assign(new Error('LLM lieferte kein parsebares JSON-Array mit Missionen.'), { status: 502 });
  }
  return missions;
}

function missionsFromParsed(parsed) {
  if (Array.isArray(parsed)) return parsed.filter((m) => m && typeof m === 'object');
  if (parsed && typeof parsed === 'object') {
    const arr = parsed.missions || parsed.missionen || parsed.items || parsed.data || parsed.results;
    if (Array.isArray(arr)) return arr.filter((m) => m && typeof m === 'object');
    // einzelne Mission als Objekt -> wrappen
    if (parsed.type || parsed.question || parsed.pairs || parsed.text) return [parsed];
  }
  return [];
}

// ------------------------------------------------------------------ Router

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();

      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

      // await: async Fehler aus den Handlern muessen im try/catch landen
      if (url.pathname === '/api/rag/index' && method === 'POST') return await handleIndex(env, request);
      if (url.pathname === '/api/rag/query' && method === 'POST') return await handleQuery(env, request);
      if (url.pathname === '/api/content/search' && method === 'POST') return await handleContentSearch(env, request);
      if (url.pathname === '/api/content/missions' && method === 'POST') return await handleContentMissions(env, request);

      return error('Unbekannte Route: ' + url.pathname, 404);
    } catch (e) {
      return error(e && e.message ? e.message : 'Worker-Fehler', (e && e.status) || 500);
    }
  },
};
