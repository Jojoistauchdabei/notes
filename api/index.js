// Cloudflare Worker: Frontend-Routen (/api/*) als Proxy an PocketBase.
//
// PocketBase: https://federwerk.ponnet.org (env.POCKETBASE_URL ueberschreibbar)
//
// Die js/api.js im Frontend spricht Routen (/api/docs, /api/folders,
// /api/files, /api/shares, /api/shares/:code/events, /api/events,
// /api/auth/*). Dieser Worker uebersetzt sie in PocketBase-Calls:
//
//   /api/docs                 -> /api/collections/documents/records
//   /api/folders              -> /api/collections/folders/records
//   /api/files                -> /api/collections/files/records
//   /api/shares               -> /api/collections/shares/records
//   /api/shares/:code/events  -> /api/collections/share_events/records
//   /api/auth/login, register -> /api/collections/users/auth-with-password
//                                /api/collections/users/records
//   /api/auth/me              -> /api/collections/users/auth-refresh
//   /api/health               -> /api/health (Proxying, { ok: true, ... } )
//
// Antworten werden in die Frontend-Formate zurueckumgewandelt:
// { items: [...] }, { doc: {...} }, { share: {...} }, ...
// PocketBase-Fehler kommen als { error: "..." } mit passendem Status.
//
// Bearer-Token (Authorization-Header) werden 1:1 an PocketBase weitergereicht.
// /api/events ist ein SSE-Stream (Polling-basiert: alle 5s PocketBase
// abfragen, bei Aenderung ein SSE-'change'-Event senden).

const PB_BASE = 'https://federwerk.ponnet.org';

const CORS_HEADERS = {
  'Access-Control-Allow-Origin': '*',
  'Access-Control-Allow-Methods': 'GET, POST, PUT, PATCH, DELETE, OPTIONS',
  'Access-Control-Allow-Headers': 'Content-Type, Authorization',
  'Access-Control-Max-Age': '600',
};

function pbBase(env) {
  const v = env && (env.POCKETBASE_URL || env.POCKETBASE_BACKEND_URL);
  return v ? String(v).replace(/\/+$/, '') : PB_BASE;
}

function corsHeaders() {
  return Object.assign({}, CORS_HEADERS);
}

function json(data, status, headers) {
  return new Response(JSON.stringify(data == null ? {} : data), {
    status: status || 200,
    headers: Object.assign(
      { 'Content-Type': 'application/json; charset=utf-8', 'Cache-Control': 'no-store' },
      corsHeaders(),
      headers || {},
    ),
  });
}

function error(message, status) {
  return json({ error: message || 'Fehler' }, status || 400);
}

function notFound(message) {
  return error(message || 'Nicht gefunden.', 404);
}

function bearerOf(request) {
  const h = request.headers.get('authorization') || '';
  const m = /^Bearer\s+(.+)$/i.exec(h.trim());
  return m ? m[1].trim() : '';
}

// Upstream-Fetch an PocketBase. Der Bearer-Token des Frontends wird
// bei Bedarf 1:1 weitergereicht.
async function pbFetch(env, request, path, init) {
  const headers = new Headers((init && init.headers) || {});
  const auth = bearerOf(request);
  if (auth) headers.set('Authorization', 'Bearer ' + auth);
  const init2 = Object.assign({ method: 'GET', headers }, init);
  if (init2.body instanceof ReadableStream) init2.duplex = 'half'; // Stream-Upload
  const res = await fetch(pbBase(env) + path, init2);
  return res;
}

async function pbJson(env, request, path, init) {
  const res = await pbFetch(env, request, path, init);
  if (!res.ok) throw Object.assign(new Error('PocketBase: ' + res.status), { status: res.status });
  return res.json();
}

// PocketBase-Fehler als { error } mit passendem Status.
async function pbError(res) {
  let message = 'PocketBase-Fehler: ' + res.status;
  try {
    const data = await res.json();
    message = String((data && (data.message || data.error)) || message);
  } catch { /* ignore */ }
  return error(message, res.status);
}

async function readJson(request) {
  const text = await request.text();
  if (!text) return {};
  return JSON.parse(text);
}

// Aktuellen Nutzer holen: auth-refresh mit dem Bearer des Frontends.
// Er liefert { record } – zum Filtern nach ownerId brauchen wir record.id.
async function currentUser(env, request) {
  const res = await pbFetch(env, request, '/api/collections/users/auth-refresh');
  if (res.status === 401) throw Object.assign(new Error('Nicht angemeldet.'), { status: 401 });
  if (!res.ok) throw Object.assign(new Error('Authentifizierung fehlgeschlagen.'), { status: res.status });
  const data = await res.json().catch(() => ({}));
  return data.record || data.user || data || {};
}

function recId(record) {
  return String((record && (record.id || record.$id)) || '');
}

// PocketBase-Feld fuer den Share-Code: die Liveshare-App liefert shareId.
const SHARE_FILTER = (code) => 'shareId="' + String(code).replace(/"/g, '') + '"';

function stripIds(body) {
  if (!body || typeof body !== 'object') return body;
  const out = Object.assign({}, body);
  delete out.id; delete out.$id; delete out.collectionId; delete out.collectionName;
  delete out.created; delete out.updated; delete out.status;
  return out;
}

// ---------------------------------------------------------------- /api/auth

async function handleAuth(env, request, path, method) {
  if (path === '/api/auth/login' && method === 'POST') {
    const body = await readJson(request).catch(() => ({}));
    const res = await pbFetch(env, request, '/api/collections/users/auth-with-password', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify({ identity: body.email, password: body.password }),
    });
    if (!res.ok) return pbError(res);
    const data = await res.json().catch(() => ({}));
    // Frontend-Format wie der alte Server: { user }, Token kommt dazu.
    return json(Object.assign({}, data, data.record ? { user: data.record } : {}), res.status);
  }

  if (path === '/api/auth/register' && method === 'POST') {
    const body = await readJson(request).catch(() => ({}));
    // PocketBase verlangt passwordConfirm; beide muessen gleich sein.
    const out = Object.assign({}, body, { passwordConfirm: body.passwordConfirm || body.password });
    const res = await pbFetch(env, request, '/api/collections/users/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stripIds(out)),
    });
    if (!res.ok) return pbError(res);
    const data = await res.json().catch(() => ({}));
    return json(Object.assign({}, data, data.record ? { user: data.record } : {}), res.status);
  }

  if (path === '/api/auth/logout' && method === 'POST') {
    // Client-seitig: Token wird entfernt.
    return new Response(null, { status: 204, headers: corsHeaders() });
  }

  if (path === '/api/auth/me' && method === 'GET') {
    const res = await pbFetch(env, request, '/api/collections/users/auth-refresh');
    if (res.status === 401) return error('Nicht angemeldet.', 401);
    if (!res.ok) return pbError(res);
    const data = await res.json().catch(() => ({}));
    const user = data.record || data.user || {};
    return json({ user, token: data.token || undefined });
  }

  return null;
}

// ---------------------------------------------------------------- /api/docs

async function handleDocs(env, request, url, method) {
  if (method === 'GET' && url.pathname === '/api/docs') {
    const user = await currentUser(env, request);
    const filters = ['ownerId="' + recId(user) + '"'];
    const since = url.searchParams.get('since');
    if (since && Number(since) > 0) {
      filters.push('updated>"' + new Date(Number(since)).toISOString() + '"');
    }
    const q = new URLSearchParams();
    q.set('filter', filters.join(' && '));
    q.set('sort', 'updated');
    const limit = url.searchParams.get('limit');
    if (limit) q.set('per_page', limit);
    const data = await pbJson(env, request, '/api/collections/documents/records?' + q.toString());
    return json(data);
  }

  if (method === 'PUT' && url.pathname === '/api/docs') {
    await currentUser(env, request);
    const body = await readJson(request).catch(() => ({}));
    const id = body.id || body.$id;
    // Vorhanden -> PATCH (Update), neu -> POST (Create).
    const target = id ? '/api/collections/documents/records/' + encodeURIComponent(String(id)) : '/api/collections/documents/records';
    const res = await pbFetch(env, request, target, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stripIds(body)),
    });
    if (!res.ok) return pbError(res);
    return json({ doc: await res.json().catch(() => ({})) });
  }

  const m = /^\/api\/docs\/([^/]+)$/.exec(url.pathname);
  if (m) {
    await currentUser(env, request);
    const id = encodeURIComponent(m[1]);
    if (method === 'GET') {
      const res = await pbFetch(env, request, '/api/collections/documents/records/' + id);
      if (res.status === 404) return notFound('Dokument nicht gefunden.');
      if (!res.ok) return pbError(res);
      return json({ doc: await res.json().catch(() => ({})) });
    }
    if (method === 'DELETE') {
      const res = await pbFetch(env, request, '/api/collections/documents/records/' + id, { method: 'DELETE' });
      if (!res.ok) return pbError(res);
      return json({ id: m[1], deletedAt: Date.now() });
    }
  }
  return null;
}

// ---------------------------------------------------------------- /api/folders

async function handleFolders(env, request, url, method) {
  if (method === 'GET' && url.pathname === '/api/folders') {
    const user = await currentUser(env, request);
    const data = await pbJson(env, request, '/api/collections/folders/records?filter=ownerId="' + recId(user) + '"');
    return json(data);
  }
  if (method === 'PUT' && url.pathname === '/api/folders') {
    await currentUser(env, request);
    const body = await readJson(request).catch(() => ({}));
    const id = body.id || body.$id;
    const target = id ? '/api/collections/folders/records/' + encodeURIComponent(String(id)) : '/api/collections/folders/records';
    const res = await pbFetch(env, request, target, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stripIds(body)),
    });
    if (!res.ok) return pbError(res);
    return json({ folder: await res.json().catch(() => ({})) });
  }
  const m = /^\/api\/folders\/([^/]+)$/.exec(url.pathname);
  if (m && method === 'DELETE') {
    await currentUser(env, request);
    const res = await pbFetch(env, request, '/api/collections/folders/records/' + encodeURIComponent(m[1]), { method: 'DELETE' });
    if (!res.ok) return pbError(res);
    return json({ id: m[1], deletedAt: Date.now() });
  }
  return null;
}

// ---------------------------------------------------------------- /api/files

// PocketBase-Records verweisen auf den Download (url/filePath/...).
function fileRecordUrl(record) {
  if (!record) return null;
  if (typeof record.url === 'string' && record.url) return record.url;
  if (record.file && typeof record.file.url === 'string' && record.file.url) return record.file.url;
  if (typeof record.filePath === 'string' && record.filePath) return record.filePath;
  return null;
}

async function handleFiles(env, request, url, method) {
  if (method === 'GET' && url.pathname === '/api/files') {
    await currentUser(env, request);
    const data = await pbJson(env, request, '/api/collections/files/records');
    return json(data);
  }

  if (method === 'POST' && url.pathname === '/api/files') {
    await currentUser(env, request);
    // Multipart 1:1 weiterleiten (Browser setzt Boundary im Content-Type).
    const headers = new Headers({ 'Content-Type': request.headers.get('content-type') || '' });
    const auth = bearerOf(request);
    if (auth) headers.set('Authorization', 'Bearer ' + auth);
    const res = await fetch(pbBase(env) + '/api/collections/files/records', {
      method: 'POST', headers, body: request.body, duplex: 'half',
    });
    if (!res.ok) return pbError(res);
    return json(await res.json().catch(() => ({})));
  }

  const m = /^\/api\/files\/([^/]+)$/.exec(url.pathname);
  if (m && method === 'GET') {
    await currentUser(env, request);
    const res = await pbFetch(env, request, '/api/collections/files/records/' + encodeURIComponent(m[1]));
    if (res.status === 404) return notFound('Datei unbekannt.');
    if (!res.ok) return pbError(res);
    const record = await res.json().catch(() => ({}));
    const furl = fileRecordUrl(record);
    if (furl) {
      const f = await pbFetch(env, request, furl);
      if (!f.ok) return pbError(f);
      const headers = new Headers(f.headers);
      headers.set('Cache-Control', 'private, max-age=31536000, immutable');
      return new Response(f.body, { status: 200, headers });
    }
    return json(record);
  }
  return null;
}

// ---------------------------------------------------------------- /api/learn

// Lern-Fortschritt (XP / Level / Streak / Missionen) -> PocketBase-Collection
// "learning_progress" (Owner-Filter ueber ownerId, wie bei /api/docs).
async function handleLearn(env, request, url, method) {
  const p = url.pathname;
  if (p !== '/api/learn/progress') return null;
  const user = await currentUser(env, request);
  const ownerId = recId(user);

  if (method === 'GET') {
    const q = new URLSearchParams();
    q.set('filter', 'ownerId="' + ownerId + '"');
    q.set('sort', '-updated');
    const data = await pbJson(env, request, '/api/collections/learning_progress/records?' + q.toString());
    const items = (data && data.items) || [];
    return json({ progress: items[0] || null });
  }

  if (method === 'PUT') {
    const body = await readJson(request).catch(() => ({}));
    const clean = Object.assign({}, body);
    delete clean.id; delete clean.$id;
    const id = body.id || body.$id;
    const target = id
      ? '/api/collections/learning_progress/records/' + encodeURIComponent(String(id))
      : '/api/collections/learning_progress/records';
    const res = await pbFetch(env, request, target, {
      method: id ? 'PATCH' : 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(clean),
    });
    if (!res.ok) return pbError(res);
    const record = await res.json().catch(() => ({}));
    return json({ progress: record });
  }

  return null;
}

// ---------------------------------------------------------------- /api/shares

async function findShareRecord(env, request, code) {
  const data = await pbJson(env, request, '/api/collections/shares/records?' + new URLSearchParams({ filter: SHARE_FILTER(code) }).toString());
  return (data.items || [])[0] || null;
}

async function handleShares(env, request, url, method) {
  const p = url.pathname;

  if (method === 'POST' && p === '/api/shares') {
    await currentUser(env, request);
    const body = await readJson(request).catch(() => ({}));
    const res = await pbFetch(env, request, '/api/collections/shares/records', {
      method: 'POST',
      headers: { 'Content-Type': 'application/json' },
      body: JSON.stringify(stripIds(body)),
    });
    if (!res.ok) return pbError(res);
    return json({ share: await res.json().catch(() => ({})) }, 201);
  }

  if (method === 'GET' && p === '/api/shares') {
    const user = await currentUser(env, request);
    const data = await pbJson(env, request, '/api/collections/shares/records?filter=ownerId="' + recId(user) + '"');
    return json(data);
  }

  const m = /^\/api\/shares\/([^/]+)$/.exec(p);
  if (m) {
    const code = m[1];
    if (method === 'GET') {
      await currentUser(env, request);
      const record = await findShareRecord(env, request, code);
      if (!record) return notFound('Freigabe nicht gefunden.');
      return json({ share: record });
    }
    if (method === 'PATCH') {
      await currentUser(env, request);
      const record = await findShareRecord(env, request, code);
      if (!record) return notFound('Freigabe nicht gefunden.');
      const body = await readJson(request).catch(() => ({}));
      const res = await pbFetch(env, request, '/api/collections/shares/records/' + encodeURIComponent(String(recId(record))), {
        method: 'PATCH',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stripIds(body)),
      });
      if (!res.ok) return pbError(res);
      return json({ share: await res.json().catch(() => ({})) });
    }
    if (method === 'DELETE') {
      await currentUser(env, request);
      const record = await findShareRecord(env, request, code);
      if (!record) return notFound('Freigabe nicht gefunden.');
      const res = await pbFetch(env, request, '/api/collections/shares/records/' + encodeURIComponent(String(recId(record))), { method: 'DELETE' });
      if (!res.ok && res.status !== 204) return pbError(res);
      return json({ shareId: code, revoked: true });
    }
  }

  const me = /^\/api\/shares\/([^/]+)\/events$/.exec(p);
  if (me) {
    const code = me[1];
    if (method === 'GET') {
      await currentUser(env, request);
      // Filter: Freigabe (nach Code); 'after' als seq-Cursor bei Bedarf.
      const filters = [SHARE_FILTER(code)];
      const after = url.searchParams.get('after');
      if (after && Number(after) > 0) filters.push('seq>"' + Number(after) + '"');
      const q = new URLSearchParams();
      q.set('filter', filters.join(' && '));
      const limit = url.searchParams.get('limit');
      if (limit) q.set('per_page', limit);
      const data = await pbJson(env, request, '/api/collections/share_events/records?' + q.toString());
      return json(data);
    }
    if (method === 'POST') {
      await currentUser(env, request);
      const body = await readJson(request).catch(() => ({}));
      const res = await pbFetch(env, request, '/api/collections/share_events/records', {
        method: 'POST',
        headers: { 'Content-Type': 'application/json' },
        body: JSON.stringify(stripIds(body)),
      });
      if (!res.ok) return pbError(res);
      return json(await res.json().catch(() => ({})), 201);
    }
  }
  return null;
}

// ---------------------------------------------------------------- /api/events

// SSE-Stream (Polling: alle 5s PocketBase abfragen, bei Aenderung
// 'change'-Event senden). Frontend: js/api.js subscribe() – EventSource
// lauscht auf 'change'.
const SSE_COLLECTIONS = {
  docs: 'documents',
  documents: 'documents',
  folders: 'folders',
  files: 'files',
  shares: 'shares',
  share_events: 'share_events',
};

function hashOf(items) {
  return JSON.stringify(items || []);
}

async function pollPocketbase(env, request, channels, share) {
  const out = [];
  for (const ch of channels) {
    const collection = SSE_COLLECTIONS[ch];
    if (!collection) continue;
    const q = new URLSearchParams({ per_page: '1000' });
    if (share && collection === 'share_events') q.set('filter', SHARE_FILTER(share));
    try {
      const data = await pbJson(env, request, '/api/collections/' + collection + '/records?' + q.toString());
      out.push.apply(out, data.items || []);
    } catch { /* PocketBase nicht erreichbar: still */ }
  }
  return out;
}

async function handleEvents(env, request, url) {
  const channels = (url.searchParams.get('channels') || 'docs,folders,shares,share_events')
    .split(',').map((s) => s.trim()).filter(Boolean);
  const share = url.searchParams.get('share');

  let iv = null;
  const stream = new ReadableStream({
    async start(controller) {
      const enc = new TextEncoder();
      const send = (obj) => {
        try { controller.enqueue(enc.encode('event: change\ndata: ' + JSON.stringify(obj) + '\n\n')); }
        catch { /* Stream geschlossen */ }
      };
      let lastHash = null;
      const poll = async () => {
        const items = await pollPocketbase(env, request, channels, share);
        const hash = hashOf(items);
        if (hash !== lastHash) { lastHash = hash; send({ changed: true, at: Date.now(), channels }); }
      };
      poll().catch(() => { /* PocketBase nicht erreichbar: still */ });
      iv = setInterval(poll, 5000);
    },
    cancel() { if (iv) clearInterval(iv); },
  });

  return new Response(stream, {
    status: 200,
    headers: Object.assign(corsHeaders(), {
      'Content-Type': 'text/event-stream; charset=utf-8',
      'Cache-Control': 'no-cache',
      'Connection': 'keep-alive',
      'X-Accel-Buffering': 'no',
    }),
  });
}

// ---------------------------------------------------------------- /api/health

async function handleHealth(env, request) {
  const res = await pbFetch(env, request, '/api/health');
  const data = res.ok ? await res.json().catch(() => ({})) : {};
  return json(Object.assign({ ok: true, service: 'notes' }, data), res.status || 200);
}

// ---------------------------------------------------------------- Router

export default {
  async fetch(request, env, ctx) {
    try {
      const url = new URL(request.url);
      const method = request.method.toUpperCase();
      const p = url.pathname;

      if (method === 'OPTIONS') return new Response(null, { status: 204, headers: corsHeaders() });

      // Public Routes (ohne Auth).
      if (p === '/api/auth/login' && method === 'POST') return handleAuth(env, request, p, method);
      if (p === '/api/auth/register' && method === 'POST') return handleAuth(env, request, p, method);
      if (p === '/api/auth/logout' && method === 'POST') return handleAuth(env, request, p, method);
      if (p === '/api/auth/me' && method === 'GET') return handleAuth(env, request, p, method);
      if (p === '/api/health' && method === 'GET') return handleHealth(env, request);

      // Authentifizierte Routes.
      const authd =
        (await handleAuth(env, request, p, method)) ||
        (await handleDocs(env, request, url, method)) ||
        (await handleFolders(env, request, url, method)) ||
        (await handleFiles(env, request, url, method)) ||
        (await handleLearn(env, request, url, method)) ||
        (await handleShares(env, request, url, method));
      if (authd) return authd;

      if (p === '/api/events' && method === 'GET') return handleEvents(env, request, url);

      return notFound('Unbekannte Route: ' + p);
    } catch (e) {
      const status = e && e.status ? e.status : 500;
      return error(e && e.message ? e.message : 'Worker-Fehler', status);
    }
  },
};
