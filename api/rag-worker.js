// Cloudflare Worker: RAG-Pipeline (api/rag-worker.js)
//
// Endpunkte:
//   POST /api/rag/index -> { content, source?, chunkSize?, chunkOverlap?, docs? }
//       Inhalt -> Chunking -> Embedding (google/embeddinggemma-2) -> Vectorize-Upsert
//   POST /api/rag/query -> { question, topK? }
//       Frage -> Embedding -> Vectorize-Retrieval -> LLM (openrouter/free) ->
//       { answer, sources: [{ source, excerpt, score }] }
//
// Services / Modelle:
//   Embedding : google/embeddinggemma-2 via Hugging Face Inference API
//               (https://router.huggingface.co/hf-inference/models/google/embeddinggemma-2)
//   LLM       : openrouter/free via OpenRouter
//               (https://openrouter.ai/api/v1/chat/completions)
//   Vektordatenbank : Cloudflare Vectorize (Service-Binding, Standard-Name: VECTORIZE_INDEX)
//
// Env / Secrets:
//   HF_TOKEN           (Secret) - Bearer-Token fuer die HF-Inference-API
//   OPENROUTER_API_KEY (Secret) - Bearer-Token fuer OpenRouter
//   VECTORIZE_INDEX    (Binding) - Vectorize-Index-Objekt
//   EMBED_DIM          (Vars)   - Vektor-Dimension (muss zum Index passen; Standard 768)
//   RAG_CHUNK_SIZE     (Vars)   - Wortzahl pro Chunk (Standard 500)
//   RAG_CHUNK_OVERLAP  (Vars)   - Overlap zwischen benachbarten Chunks in Wörtern (Standard 50)
//
// Hinweis zum PDF-Pipeline: PDF -> Text (z. B. mit pdf-lib) geschieht vorgelagernt;
// dieser Worker nimmt Plain Text / Notizen entgegen.

const HF_EMBED_MODEL = 'google/embeddinggemma-2';
const HF_BASE = 'https://router.huggingface.co/hf-inference/models/' + HF_EMBED_MODEL;
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
  const token = env && env.HF_TOKEN;
  const inputs = Array.isArray(texts) ? texts : [texts];
  if (!inputs.length || inputs.some((t) => !String(t || '').trim())) {
    throw new Error('Leerer Text fuer Embedding');
  }
  const res = await fetch(HF_BASE, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      token ? { Authorization: 'Bearer ' + String(token) } : {},
    ),
    body: JSON.stringify({ inputs: inputs.length === 1 ? inputs[0] : inputs }),
  });
  if (!res.ok) {
    throw Object.assign(new Error('HF-Embedding fehlgeschlagen (HTTP ' + res.status + ')'), { status: 502 });
  }
  const data = await res.json().catch(() => ({}));
  const vectors = extractVectors(data, inputs.length);
  if (vectors.length !== inputs.length) {
    throw Object.assign(new Error('HF-Embedding lieferte unerwartete Vektoren'), { status: 502 });
  }
  return vectors;
}

// ------------------------------------------------------------------ Vectorize

function vectorize(env) {
  if (!env || !env.VECTORIZE_INDEX) {
    throw new Error('Vectorize-Binding VECTORIZE_INDEX ist nicht konfiguriert');
  }
  return env.VECTORIZE_INDEX;
}

// ------------------------------------------------------------------ Endpoints

async function handleIndex(env, request) {
  const body = await readJson(request);
  const source = String(body.source || body.docId || body.filename || '').trim();
  const chunkSize = intOr(body.chunkSize, intOr(env && env.RAG_CHUNK_SIZE, 500));
  const overlap = intOr(body.chunkOverlap, intOr(env && env.RAG_CHUNK_OVERLAP, 50));
  const docs = Array.isArray(body.docs) ? body.docs : [body];

  let indexed = 0;
  for (const doc of docs) {
    const text = String((doc && doc.content) || (doc && doc.text) || (doc && doc.body) || '');
    if (!text.trim()) return error('content fehlt (im Body oder in docs[])');
    const chunks = chunkText(text, chunkSize, overlap);
    if (!chunks.length) return error('Keine Chunks aus dem Inhalt erzeugt');

    const vectors = await embedTexts(env, chunks);
    const upserts = chunks.map((chunk, i) => ({
      id: vectorId(chunk, source),
      values: vectors[i],
      metadata: { source: source || null, index: i, text: chunk },
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

  const key = env && env.OPENROUTER_API_KEY;
  const res = await fetch(OPENROUTER_BASE, {
    method: 'POST',
    headers: Object.assign(
      { 'Content-Type': 'application/json' },
      key ? { Authorization: 'Bearer ' + String(key) } : {},
    ),
    body: JSON.stringify({
      model: OPENROUTER_MODEL,
      messages: [
        { role: 'system', content: systemPrompt },
        { role: 'user', content: userPrompt },
      ],
      temperature: 0.2,
      max_tokens: 800,
    }),
  });
  if (!res.ok) {
    throw Object.assign(new Error('OpenRouter-LLM fehlgeschlagen (HTTP ' + res.status + ')'), { status: 502 });
  }
  const data = await res.json().catch(() => ({}));
  const answer =
    ((data && data.choices && data.choices[0] && data.choices[0].message && data.choices[0].message.content) || '')
      .trim() || 'Es konnte keine Antwort generiert werden.';

  return json({ answer, sources });
}

// ------------------------------------------------------------------ Router

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();

      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

      if (url.pathname === '/api/rag/index' && method === 'POST') return handleIndex(env, request);
      if (url.pathname === '/api/rag/query' && method === 'POST') return handleQuery(env, request);

      return error('Unbekannte Route: ' + url.pathname, 404);
    } catch (e) {
      return error(e && e.message ? e.message : 'Worker-Fehler', (e && e.status) || 500);
    }
  },
};
