'use strict';

let createMcpHandler;
let PROTOCOL_VERSION = '2024-11-05';
try {
  ({ createMcpHandler, PROTOCOL_VERSION } = require('../mcpserver'));
} catch {
  try {
    ({ createMcpHandler, PROTOCOL_VERSION } = require('./mcpserver'));
  } catch {
    ({ createMcpHandler, PROTOCOL_VERSION } = require('@federwerk/mcpserver'));
  }
}

let C = null;
try {
  C = require('../mcpserver/content');
} catch {
  try {
    C = require('./content');
  } catch {
    try {
      C = require('@federwerk/mcpserver/content');
    } catch {
      throw new Error('MCP content helpers fehlen (mcpserver/content.js, siehe scripts/build-mcp.js)');
    }
  }
}

function getConfig() {
  return {
    endpoint: process.env.APPWRITE_ENDPOINT || 'https://fra.cloud.appwrite.io/v1',
    projectId: process.env.APPWRITE_PROJECT_ID || '6ab0067c00244c28560a',
    databaseId: process.env.APPWRITE_DATABASE_ID || 'federwerk',
    notesTableId: process.env.APPWRITE_NOTES_TABLE_ID || 'notes',
    foldersTableId: process.env.APPWRITE_FOLDERS_TABLE_ID || 'folders',
    bucketId: process.env.APPWRITE_BUCKET_ID || 'attachments',
    apiKey: process.env.APPWRITE_API_KEY,
    // Key-los: Benutzer-Session (Secret aus `node mcpserver/login.js`).
    // Der Server handelt dann als dieser Nutzer – fremde Notizen sind
    // prinzipbedingt unerreichbar (besser als Admin-Key + UserID-Filter).
    session: process.env.APPWRITE_SESSION,
    userId: process.env.APPWRITE_USER_ID,
    token: process.env.MCP_TOKEN,
  };
}

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const target = name.toLowerCase();
  for (const [key, val] of Object.entries(headers)) {
    if (key.toLowerCase() === target && typeof val === 'string') return val;
  }
  return '';
}

function authValue(headers) {
  const auth = getHeader(headers, 'authorization');
  if (auth && auth.startsWith('Bearer ')) {
    return auth.slice(7).trim();
  }
  return getHeader(headers, 'x-mcp-token').trim();
}

function requireConfig(config, headers) {
  if (!config.apiKey && !config.session && !canLoginFromStore(config)) {
    throw new Error('Anmeldedaten erforderlich: APPWRITE_SESSION, APPWRITE_API_KEY oder E-Mail/Passwort (Env APPWRITE_EMAIL/APPWRITE_PASSWORD bzw. `node mcpserver/login.js --save`, siehe docs/mcp.md)');
  }
  if (config.token && authValue(headers) !== config.token) {
    throw new Error('Unauthorized');
  }
}

// Credential-Store (mcpserver/login.js) – der MCP darf die Notizen nur
// steuern, wenn die Datei existiert und lesbar ist.
function loginStore() {
  try {
    const L = require('../mcpserver/login');
    return L;
  } catch {
    try {
      return require('./login');
    } catch {
      return require('@federwerk/mcpserver/login');
    }
  }
}
function canLoginFromStore(config) {
  if (config.apiKey || config.session) return true;
  try {
    const c = loginStore().loadCredentials();
    return !!(c && c.email && c.password);
  } catch { return false; }
}

// --- Session-Verwaltung -----------------------------------------------------
// Der MCP bekommt die Login-Daten und erzeugt die Appwrite-Session (Cookie)
// selbst. Reihenfolge: API-Key > gesetztes APPWRITE_SESSION (fremder Token,
// z. B. aus dem Browser) > Credentials aus Env/Datei (selbst angemeldet).
// `owned` merkt sich, ob die Session uns gehört – nur dann darf logout sie
// löschen, damit die Browser-Sessions der App unangetastet bleiben.
const sessionState = { token: '', owned: false, sessionId: '', userId: '', email: '', expire: null };

function resetSession() {
  sessionState.token = '';
  sessionState.owned = false;
  sessionState.sessionId = '';
  sessionState.userId = '';
  sessionState.email = '';
  sessionState.expire = null;
  cachedSessionUser = null;
}

// Erzeugt bei Bedarf eine Session (Credentials) und liefert das Token.
async function ensureSession(config, opts = {}) {
  if (config.apiKey) return null; // Key-Modus: keine Session nötig
  if (config.session) {
    if (sessionState.token !== config.session) {
      sessionState.token = config.session;
      sessionState.owned = false;
      sessionState.sessionId = '';
      cachedSessionUser = null;
    }
    return sessionState.token;
  }
  if (sessionState.token && !opts.force) return sessionState.token;
  const L = loginStore();
  const c = L.loadCredentials();
  if (!c.email || !c.password) {
    throw new Error('Keine Anmeldedaten: APPWRITE_EMAIL/APPWRITE_PASSWORD setzen oder `node mcpserver/login.js --save` ausführen');
  }
  // Vor dem Neuanmelden die eigene alte Session schließen: Appwrite hat ein
  // Session-Limit pro Benutzer und verdrängt dabei die ältesten Sessions –
  // auch die der App im Browser. So erzeugt der MCP nie Sitzungsleichen.
  if (opts.force && sessionState.owned && sessionState.token) {
    await L.deleteSession({
      endpoint: config.endpoint,
      projectId: config.projectId,
      token: sessionState.token,
      sessionId: sessionState.sessionId,
    }).catch(() => { /* alte Session ist schon weg */ });
  }
  const s = await L.createSession({
    endpoint: c.endpoint || config.endpoint,
    projectId: c.projectId || config.projectId,
    email: c.email,
    password: c.password,
  });
  sessionState.token = s.token;
  sessionState.owned = true;
  sessionState.sessionId = s.sessionId;
  sessionState.userId = s.userId;
  sessionState.email = s.email;
  sessionState.expire = s.expire;
  cachedSessionUser = null;
  return sessionState.token;
}

function sessionInfo() {
  return {
    authenticated: !!sessionState.token,
    ownedByMcp: sessionState.owned,
    userId: sessionState.userId || '',
    email: sessionState.email || '',
    expiresAt: sessionState.expire || null,
  };
}

// Auth-Header Richtung Appwrite: Admin-Key bevorzugt, sonst Benutzer-Session
// (X-Appwrite-Session – wie die App selbst in js/appwrite-files.js).
async function authHeaders(config) {
  const h = { 'X-Appwrite-Project': config.projectId };
  if (config.apiKey) {
    h['X-Appwrite-Key'] = config.apiKey;
    return h;
  }
  const token = sessionState.token || config.session || await ensureSession(config);
  if (token) h['X-Appwrite-Session'] = token;
  return h;
}

// UserID aus der Session auflösen (einmal pro Prozess cachen; Key-Modus
// braucht weiterhin explizit APPWRITE_USER_ID als Scope).
let cachedSessionUser = null;
async function resolveUserId(config) {
  if (config.userId) return config.userId;
  if (config.apiKey) {
    throw new Error('APPWRITE_USER_ID erforderlich (nur im Session-Modus automatisch)');
  }
  if (!sessionState.token && !config.session) await ensureSession(config);
  const token = sessionState.token || config.session;
  if (!token) {
    throw new Error('APPWRITE_USER_ID erforderlich (nur im Session-Modus automatisch)');
  }
  if (cachedSessionUser && cachedSessionUser.session === token) {
    return cachedSessionUser.userId;
  }
  const res = await fetch(`${config.endpoint.replace(/\/$/, '')}/account`, {
    headers: { ...(await authHeaders(config)), 'X-Appwrite-Response-Format': '2.0.0' },
  });
  if (!res.ok) {
    const err = new Error('Session ungültig oder abgelaufen – bitte neu einloggen (`node mcpserver/login.js`)');
    err.status = res.status;
    throw err;
  }
  const me = await res.json().catch(() => ({}));
  if (!me || !me.$id) throw new Error('Session ungültig – bitte neu einloggen (`node mcpserver/login.js`)');
  cachedSessionUser = { session: token, userId: me.$id };
  return me.$id;
}

function withUser(config, userId) {
  return Object.assign({}, config, { userId });
}

function query(method, values, attribute) {
  return JSON.stringify({
    method,
    ...(values && values.length ? { values } : {}),
    ...(attribute ? { attribute } : {}),
  });
}

async function appwriteRequest(config, path, queries = [], method = 'GET', bodyData = null, opts = {}) {
  const url = new URL(config.endpoint.replace(/\/$/, '') + path);
  queries.forEach((value, index) => url.searchParams.set(`queries[${index}]`, value));
  const options = { method, body: bodyData === null || bodyData === undefined ? undefined : (typeof bodyData === 'string' ? bodyData : JSON.stringify(bodyData)) };
  const send = async () => {
    const response = await fetch(url, {
      method: options.method,
      headers: {
        ...(await authHeaders(config)),
        'X-Appwrite-Response-Format': '2.0.0',
        'Content-Type': 'application/json',
      },
      body: options.body,
    });
    const bodyText = await response.text();
    let data;
    try {
      data = bodyText ? JSON.parse(bodyText) : null;
    } catch {
      data = { message: bodyText };
    }
    return { response, data };
  };
  let { response, data } = await send();
  // Abgelaufene eigene Session: einmal neu anmelden und denselben Aufruf
  // wiederholen (Credentials müssen hinterlegt sein).
  if (response.status === 401 && !opts._retried && !config.apiKey && !config.session) {
    try {
      await ensureSession(config, { force: true });
      ({ response, data } = await send());
    } catch { /* Originalfehler unten werfen */ }
  }
  if (!response.ok) {
    const err = new Error(`Appwrite ${response.status}: ${(data && data.message) || 'request failed'}`);
    err.status = response.status;
    err.data = data;
    throw err;
  }
  return data;
}

async function fetchTableRows(config, tableId, queries = []) {
  const primaryPath = `/tablesdb/${encodeURIComponent(config.databaseId)}/tables/${encodeURIComponent(tableId)}/rows`;
  try {
    return await appwriteRequest(config, primaryPath, queries);
  } catch (err) {
    if (err.status === 404) {
      const fallbackPath = `/databases/${encodeURIComponent(config.databaseId)}/tables/${encodeURIComponent(tableId)}/rows`;
      try {
        return await appwriteRequest(config, fallbackPath, queries);
      } catch (err2) {
        if (err2.status === 404) {
          const docPath = `/databases/${encodeURIComponent(config.databaseId)}/collections/${encodeURIComponent(tableId)}/documents`;
          return await appwriteRequest(config, docPath, queries);
        }
        throw err2;
      }
    }
    throw err;
  }
}

async function fetchTableRow(config, tableId, rowId) {
  const primaryPath = `/tablesdb/${encodeURIComponent(config.databaseId)}/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}`;
  try {
    return await appwriteRequest(config, primaryPath);
  } catch (err) {
    if (err.status === 404) {
      const fallbackPath = `/databases/${encodeURIComponent(config.databaseId)}/tables/${encodeURIComponent(tableId)}/rows/${encodeURIComponent(rowId)}`;
      try {
        return await appwriteRequest(config, fallbackPath);
      } catch (err2) {
        if (err2.status === 404) {
          const docPath = `/databases/${encodeURIComponent(config.databaseId)}/collections/${encodeURIComponent(tableId)}/documents/${encodeURIComponent(rowId)}`;
          return await appwriteRequest(config, docPath);
        }
        throw err2;
      }
    }
    throw err;
  }
}

async function resolveNoteContent(config, row) {
  if (!row) return row;
  if (!row.content && row.contentFileId) {
    try {
      const bucketId = config.bucketId || 'attachments';
      const fileUrl = `${config.endpoint.replace(/\/$/, '')}/storage/buckets/${encodeURIComponent(bucketId)}/files/${encodeURIComponent(row.contentFileId)}/download`;
      const res = await fetch(fileUrl, {
        headers: await authHeaders(config),
      });
      if (res.ok) {
        row.content = await res.text();
      }
    } catch {
      // Content download failure leaves metadata intact
    }
  }
  return row;
}

function isLiveRow(row) {
  if (!row) return false;
  if (row.deletedAt) return false;
  if (row.deleted === true || row.deleted === 1) return false;
  if (row.title === '(gelöscht)') return false;
  return true;
}

function userPerms(userId) {
  return [`read("user:${userId}")`, `update("user:${userId}")`, `delete("user:${userId}")`];
}

function rowsPath(config, tableId) {
  return `/tablesdb/${encodeURIComponent(config.databaseId)}/tables/${encodeURIComponent(tableId)}/rows`;
}

// POST mit rowId+Permissions, bei 409 (existiert) PUT – wie js/appwrite-sync.js upsertRow.
async function upsertRow(config, tableId, rowId, data) {
  const perms = userPerms(config.userId);
  try {
    return await appwriteRequest(config, rowsPath(config, tableId), [], 'POST',
      { rowId, data, permissions: perms });
  } catch (err) {
    if (err && err.status === 409) {
      return await appwriteRequest(config, `${rowsPath(config, tableId)}/${encodeURIComponent(rowId)}`, [], 'PUT', { data });
    }
    throw err;
  }
}

// Teildaten-Update: Appwrites PUT (updateRow) ersetzt die Row komplett und
// verlangt alle Pflicht-Attribute (sonst 400 "Missing required attribute").
// Darum bestehende Werte laden und mergen – wie js/appwrite-sync.js, das
// ebenfalls immer den vollen Datensatz schickt.
async function patchRow(config, tableId, rowId, data) {
  const current = await fetchTableRow(config, tableId, rowId);
  if (!current) throw new Error('Document not found');
  const merged = {};
  for (const key of Object.keys(current)) {
    if (key.charAt(0) === '$') continue; // Systemfelder ($id, $createdAt, ...)
    merged[key] = current[key];
  }
  for (const key of Object.keys(data || {})) {
    if (data[key] === undefined) continue;
    merged[key] = data[key];
  }
  return await appwriteRequest(config, `${rowsPath(config, tableId)}/${encodeURIComponent(rowId)}`, [], 'PUT', { data: merged });
}

async function deleteRow(config, tableId, rowId) {
  return await appwriteRequest(config, `${rowsPath(config, tableId)}/${encodeURIComponent(rowId)}`, [], 'DELETE');
}

// Content > OFFLOAD_BYTES wandert als JSON-Datei in den Bucket (Dedupe via
// fester Datei-ID aus SHA-256, 409 = existiert schon) – wie js/appwrite-sync.js.
async function sha256HexWeb(bytes) {
  const c = (typeof crypto !== 'undefined' && crypto.subtle)
    || (typeof require === 'function' && require('crypto').webcrypto.subtle);
  if (!c) throw new Error('kein subtle crypto');
  const d = await c.digest('SHA-256', bytes);
  return Array.from(new Uint8Array(d)).map((b) => b.toString(16).padStart(2, '0')).join('');
}

// Der Bucket erlaubt je nach Konfiguration nicht jede Endung (live getestet:
// "json" war gesperrt). Datei-ID bleibt immer fw<hash>; nur der Dateiname
// variiert – der Download läuft über die ID, nicht den Namen.
const OFFLOAD_NAMES = [
  { ext: 'json', mime: 'application/json' },
  { ext: 'txt', mime: 'text/plain' },
  { ext: 'bin', mime: 'application/octet-stream' },
];

async function uploadOffloaded(config, jsonBytes) {
  const hash = await sha256HexWeb(jsonBytes);
  const fileId = 'fw' + hash.slice(0, 32);
  const url = `${config.endpoint.replace(/\/$/, '')}/storage/buckets/${encodeURIComponent(config.bucketId || 'attachments')}/files`;
  let lastErr = null;
  for (const cand of OFFLOAD_NAMES) {
    const form = new FormData();
    form.append('fileId', fileId);
    form.append('file', new Blob([jsonBytes], { type: cand.mime }), `${fileId}.${cand.ext}`);
    const res = await fetch(url, {
      method: 'POST',
      headers: await authHeaders(config),
      body: form,
    });
    if (res.ok || res.status === 409) return fileId; // 409 = existiert schon (Dedupe)
    const t = await res.text().catch(() => '');
    lastErr = `Bucket-Upload ${res.status}: ${t.slice(0, 200)}`;
    if (res.status !== 400) break; // 400 = Endung nicht erlaubt -> nächste probieren
  }
  throw new Error(lastErr || 'Bucket-Upload fehlgeschlagen');
}

async function splitContent(config, contentStr) {
  const bytes = new TextEncoder().encode(contentStr);
  if (bytes.length > C.OFFLOAD_BYTES) {
    try {
      const fileId = await uploadOffloaded(config, bytes);
      return { content: '', contentFileId: fileId };
    } catch (err) {
      // Bucket verweigert den Dateityp (live: erlaubt oft nur jpg/png/webp/pdf).
      // Was noch inline passt, nehmen wir inline – sonst klarer, actionable
      // Fehler statt "Invalid document structure".
      if (bytes.length <= C.INLINE_ROW_MAX) {
        if (typeof console !== 'undefined' && console.warn) {
          console.warn(`MCP: Offload nicht möglich (${err.message}) – ${bytes.length} Bytes inline gespeichert.`);
        }
        return { content: contentStr, contentFileId: null };
      }
      const e = new Error(
        `Inhalt zu groß: ${bytes.length} Bytes passen nicht in eine Zeile (max ~${C.INLINE_ROW_MAX}) `
        + 'und der Bucket "attachments" lehnt den Dateityp ab. In der Appwrite-Console bei '
        + 'Storage → attachments die Endung "json" erlauben, oder die Notiz teilen.',
      );
      e.status = 413;
      throw e;
    }
  }
  return { content: contentStr, contentFileId: null };
}

// Row laden + Offload auflösen + Envelope dekodieren -> Arbeitskopie für Writes.
async function loadDocParts(config, id) {
  const row = await fetchTableRow(config, config.notesTableId, id);
  if (!row || row.userId !== config.userId) throw new Error('Document not found');
  if (!isLiveRow(row)) throw new Error('Document has been deleted');
  await resolveNoteContent(config, row);
  const dec = C.decodeContent(row.content || '');
  return {
    row,
    parts: {
      title: row.title || '',
      folderId: row.folderId || null,
      pages: dec.pages,
      kind: dec.kind,
      cards: dec.cards.map((c) => C.normalizeCard(c)),
      deckOptions: C.normalizeDeckOptions(dec.deckOptions),
      reviewLog: C.normalizeReviewLog(dec.reviewLog),
      createdAt: row.createdAt || row.$createdAt || null,
      contentFileId: row.contentFileId || null,
    },
  };
}

async function saveDocParts(config, rowId, parts) {
  const built = C.rowDataFromDocParts(parts, config.userId, {
    title: parts.title, folderId: parts.folderId,
    pages: parts.pages, kind: parts.kind, cards: parts.cards,
    deckOptions: parts.deckOptions, reviewLog: parts.reviewLog,
    createdAt: parts.createdAt, contentFileId: parts.contentFileId,
  });
  C.checkContentBytes(built.content);
  const split = await splitContent(config, built.content);
  const data = { ...built.data, content: split.content, contentFileId: split.contentFileId };
  const saved = await upsertRow(config, config.notesTableId, rowId, data);
  return saved && (saved.$id || saved.id) ? saved : { $id: rowId, ...data };
}

async function ensureFolder(config, folderId) {
  if (!folderId) return null;
  const fid = String(folderId);
  if (!fid.trim()) return null;
  const all = await rows(config, config.foldersTableId);
  const hit = all.find((f) => (f.$id || f.id) === fid && isLiveRow(f));
  if (!hit) throw new Error('Folder not found');
  return hit;
}

function folderRowFor(config, f) {
  return { userId: config.userId, name: f.name, parentId: f.parentId || null };
}

async function rows(config, tableId, additionalQueries = []) {
  const result = [];
  let cursor = null;
  for (let page = 0; page < 20; page += 1) {
    const queries = [
      query('limit', [100]),
      query('equal', [config.userId], 'userId'),
      ...additionalQueries,
    ];
    if (cursor) queries.push(query('cursorAfter', [cursor]));
    const data = await fetchTableRows(config, tableId, queries);
    const pageRows = Array.isArray(data && (data.rows || data.documents))
      ? (data.rows || data.documents)
      : [];
    result.push(...pageRows);
    if (pageRows.length < 100) break;
    cursor = pageRows[pageRows.length - 1].$id || pageRows[pageRows.length - 1].id;
  }
  return result;
}

function createAppwriteHandler(config) {
  // Alle Docs (mit Inhalt) für Suche/Graph – paginiert, max 2000.
  async function allDocs() {
    const all = await rows(config, config.notesTableId);
    const docs = [];
    for (const row of all.filter(isLiveRow)) {
      try {
        await resolveNoteContent(config, row);
        const d = C.docFromRow(row);
        d.markdown = (d.markdown || '').slice(0, 20000);
        docs.push(d);
      } catch { /* unlesbare Row überspringen */ }
    }
    return docs;
  }

  return createMcpHandler({
    sessionInfo: async () => sessionInfo(),
    login: async () => {
      if (!config.apiKey && !canLoginFromStore(config)) {
        throw new Error('Keine Anmeldedaten hinterlegt (APPWRITE_EMAIL/APPWRITE_PASSWORD oder `node mcpserver/login.js --save`)');
      }
      await ensureSession(config, { force: true });
      return sessionInfo();
    },
    logout: async () => {
      if (!sessionState.token) return { ...sessionInfo(), loggedOut: false, note: 'Keine Session aktiv' };
      if (!sessionState.owned) {
        return {
          ...sessionInfo(),
          loggedOut: false,
          note: 'Session gehört nicht dem MCP (z. B. per APPWRITE_SESSION gesetzt) – nicht gelöscht, damit die App angemeldet bleibt.',
        };
      }
      const L = loginStore();
      await L.deleteSession({
        endpoint: config.endpoint,
        projectId: config.projectId,
        token: sessionState.token,
        sessionId: sessionState.sessionId,
      });
      resetSession();
      return { authenticated: false, ownedByMcp: false, userId: '', email: '', expiresAt: null, loggedOut: true };
    },
    listDocuments: async (limit = 100, folderId = null, opts = {}) => {
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      const targetFolder = folderId || (opts && opts.folderId);
      const kind = opts && opts.kind;
      const extra = [query('orderAsc', [], 'updatedAt')];
      if (targetFolder) {
        extra.push(query('equal', [targetFolder], 'folderId'));
      }
      const all = await rows(config, config.notesTableId, extra);
      let live = all.filter(isLiveRow);
      if (kind === 'notebook' || kind === 'flashcards') {
        live = live.filter((r) => {
          const dec = C.decodeContent(r.content || '');
          const k = dec.kind || 'notebook';
          return k === kind;
        });
      }
      return live.slice(0, max);
    },
    getDocument: async (id) => {
      const { row } = await loadDocParts(config, id);
      // Volle Karten nur hier (list/search bleiben schlank).
      return C.docFromRow({ ...row }, { cardsLimit: 200 });
    },
    listFolders: async () => {
      const all = await rows(config, config.foldersTableId, [query('orderAsc', [], '$updatedAt')]);
      return all.filter(isLiveRow);
    },
    searchDocuments: async (text, limit = 100) => {
      const needle = String(text || '').trim().toLowerCase();
      if (!needle) return [];
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      const all = await rows(config, config.notesTableId);
      const out = [];
      for (const row of all) {
        if (!isLiveRow(row)) continue;
        const dec = C.decodeContent(row.content || '');
        const md = C.pagesToMarkdown(dec.pages);
        const hay = [
          String(row.title || ''),
          md,
          ...dec.cards.map((c) => `${C.stripTagsLite(c.front)} ${C.stripTagsLite(c.back)}`),
        ].join('\n').toLowerCase();
        if (hay.includes(needle)) {
          out.push({
            id: row.$id || row.id,
            title: row.title || 'Unbenannt',
            snippet: C.snippetFor(md.replace(/\s+/g, ' ') || String(row.title || ''), [needle]),
            updatedAt: row.updatedAt || row.$updatedAt || null,
          });
        }
        if (out.length >= max) break;
      }
      return out;
    },
    advancedSearch: async (text, limit = 100) => {
      const q = String(text || '').trim();
      if (!q) return [];
      return C.advancedSearchDocs(await allDocs(), q, limit);
    },
    getGraph: async (id, depth) => {
      const graph = C.buildGraph(await allDocs());
      if (id) {
        if (!graph.nodes.some((n) => n.id === id)) throw new Error('Document not found');
        return C.localGraph(graph, id, depth == null ? 1 : depth);
      }
      return graph;
    },
    createDocument: async (input = {}) => {
      C.checkTitle(input.title);
      await ensureFolder(config, input.folderId);
      const kind = input.kind === 'flashcards' ? 'flashcards' : 'notebook';
      const pages = C.contentToPages(input.content || '', input.contentFormat || 'markdown');
      const rowId = C.rowIdFor(C.newId('n'), 'b');
      await saveDocParts(config, rowId, {
        title: C.normTitle(input.title),
        folderId: input.folderId ? String(input.folderId) : null,
        pages, kind,
        cards: kind === 'flashcards' ? [] : [],
        deckOptions: C.normalizeDeckOptions(null),
        reviewLog: [],
      });
      const { row } = await loadDocParts(config, rowId);
      return C.docFromRow(row);
    },
    updateDocument: async (id, input = {}) => {
      const { parts } = await loadDocParts(config, id);
      if (input.title !== undefined) {
        C.checkTitle(input.title);
        parts.title = C.normTitle(input.title);
      }
      if (input.folderId !== undefined) {
        const fid = String(input.folderId || '').trim();
        await ensureFolder(config, fid || null);
        parts.folderId = fid || null;
      }
      if (input.content !== undefined) {
        const pages = C.contentToPages(input.content || '', input.contentFormat || 'markdown');
        if (input.append) {
          const html = pages.length && pages[0].texts.length ? pages[0].texts[0].html : '';
          if (!parts.pages.length) parts.pages = [C.blankPage()];
          const last = parts.pages[parts.pages.length - 1];
          last.texts = Array.isArray(last.texts) ? last.texts : [];
          last.texts.push({ id: C.newId('t'), x: 0.08, y: 0.05, html: html || '<p></p>' });
        } else {
          parts.pages = pages;
        }
      }
      await saveDocParts(config, id, parts);
      const { row } = await loadDocParts(config, id);
      return C.docFromRow(row);
    },
    deleteDocument: async (id, input = {}) => {
      await loadDocParts(config, id); // Existenz-Check (404 bei fremd/gelöscht)
      if (input && input.permanent) {
        await deleteRow(config, config.notesTableId, id);
        return { id, deleted: true, permanent: true };
      }
      const t = C.nowIso();
      await patchRow(config, config.notesTableId, id, {
        title: '(gelöscht)', content: '', contentFileId: null, folderId: null,
        updatedAt: t, deletedAt: t,
      });
      return { id, deleted: true, permanent: false };
    },
    duplicateDocument: async (id, input = {}) => {
      const { parts } = await loadDocParts(config, id);
      if (input && input.title !== undefined) C.checkTitle(input.title);
      const rowId = C.rowIdFor(C.newId('n'), 'b');
      const title = input && input.title ? C.normTitle(input.title) : `${parts.title} (Kopie)`;
      const fresh = {
        ...parts,
        title,
        createdAt: null,
        // Karten-IDs neu vergeben (sonst kollidieren Review-Zuordnungen).
        cards: parts.cards.map((c) => ({ ...C.normalizeCard(c), id: C.newId('c') })),
      };
      await saveDocParts(config, rowId, fresh);
      const { row } = await loadDocParts(config, rowId);
      return C.docFromRow(row);
    },
    moveDocument: async (id, folderId) => {
      const { parts } = await loadDocParts(config, id);
      const fid = String(folderId || '').trim();
      await ensureFolder(config, fid || null);
      parts.folderId = fid || null;
      await saveDocParts(config, id, parts);
      const { row } = await loadDocParts(config, id);
      return C.docFromRow(row);
    },
    createFolder: async (input = {}) => {
      const name = String(input.name || '').trim().slice(0, 60);
      if (!name) throw new Error('name ist erforderlich');
      if (input.parentId) await ensureFolder(config, String(input.parentId));
      const id = C.rowIdFor(C.newId('f'), 'f');
      await upsertRow(config, config.foldersTableId, id,
        folderRowFor(config, { name, parentId: input.parentId ? String(input.parentId) : null }));
      return { id, name, parentId: input.parentId ? String(input.parentId) : null };
    },
    renameFolder: async (id, name) => {
      const clean = String(name || '').trim().slice(0, 60);
      if (!clean) throw new Error('name ist erforderlich');
      const all = await rows(config, config.foldersTableId);
      const hit = all.find((f) => (f.$id || f.id) === id);
      if (!hit || !isLiveRow(hit)) throw new Error('Folder not found');
      await patchRow(config, config.foldersTableId, id, { name: clean });
      return { id, name: clean, parentId: hit.parentId || null };
    },
    deleteFolder: async (id, input = {}) => {
      const all = await rows(config, config.foldersTableId);
      const hit = all.find((f) => (f.$id || f.id) === id);
      if (!hit || !isLiveRow(hit)) throw new Error('Folder not found');
      const target = input && input.moveDocumentsTo ? String(input.moveDocumentsTo) : '';
      if (target) await ensureFolder(config, target);
      const docs = await rows(config, config.notesTableId, [query('equal', [id], 'folderId')]);
      let moved = 0;
      for (const r of docs.filter(isLiveRow).slice(0, 100)) {
        await patchRow(config, config.notesTableId, r.$id || r.id,
          { folderId: target || null, updatedAt: C.nowIso() });
        moved++;
      }
      await deleteRow(config, config.foldersTableId, id);
      return { id, deleted: true, documentsMoved: moved, moveDocumentsTo: target || null };
    },
    createDeck: async (input = {}) => {
      C.checkTitle(input.title);
      await ensureFolder(config, input.folderId);
      const cards = C.checkCards(input.cards || [], false);
      const rowId = C.rowIdFor(C.newId('n'), 'b');
      await saveDocParts(config, rowId, {
        title: C.normTitle(input.title),
        folderId: input.folderId ? String(input.folderId) : null,
        pages: [C.blankPage()],
        kind: 'flashcards',
        cards,
        deckOptions: C.normalizeDeckOptions(null),
        reviewLog: [],
      });
      const { row } = await loadDocParts(config, rowId);
      return C.docFromRow(row, { cardsLimit: 200 });
    },
    listCards: async (deckId, filter, limit) => {
      const { parts } = await loadDocParts(config, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const t = C.nowMs();
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      let list = parts.cards;
      if (filter === 'due') list = list.filter((c) => C.isDue(c, t));
      else if (filter === 'new') list = list.filter((c) => !c.lastReview && !c.suspended);
      return list.slice(0, max);
    },
    addCards: async (deckId, cards) => {
      const fresh = C.checkCards(cards, true);
      const { parts } = await loadDocParts(config, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      parts.cards.push(...fresh);
      await saveDocParts(config, deckId, parts);
      return fresh;
    },
    updateCard: async (deckId, cardId, input = {}) => {
      const { parts } = await loadDocParts(config, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const card = parts.cards.find((c) => c.id === cardId);
      if (!card) throw new Error('Card not found');
      if (input.front !== undefined) card.front = String(input.front);
      if (input.back !== undefined) card.back = String(input.back);
      if (input.suspended !== undefined) card.suspended = !!input.suspended;
      card.updatedAt = C.nowMs();
      C.normalizeCard(card);
      await saveDocParts(config, deckId, parts);
      return card;
    },
    deleteCard: async (deckId, cardId) => {
      const { parts } = await loadDocParts(config, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const ix = parts.cards.findIndex((c) => c.id === cardId);
      if (ix < 0) throw new Error('Card not found');
      parts.cards.splice(ix, 1);
      await saveDocParts(config, deckId, parts);
      return { deckId, cardId, deleted: true };
    },
    reviewCard: async (deckId, cardId, grade) => {
      const { parts } = await loadDocParts(config, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const card = parts.cards.find((c) => c.id === cardId);
      if (!card) throw new Error('Card not found');
      const { normalizeGrade } = C;
      if (!normalizeGrade(grade)) throw new Error('grade muss again|hard|good|easy sein');
      C.gradeCardInPlace(card, grade);
      parts.reviewLog = C.normalizeReviewLog([...parts.reviewLog, { t: C.nowMs(), g: normalizeGrade(grade), id: cardId }]);
      await saveDocParts(config, deckId, parts);
      return { card, preview: C.previewIntervals(card) };
    },
    deckStats: async (deckId) => {
      const { parts } = await loadDocParts(config, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      return { deckId, ...C.deckStats(parts.cards, parts.reviewLog) };
    },
  });
}

function parseBody(req) {
  if (!req) return null;
  if (req.bodyJson && typeof req.bodyJson === 'object') return req.bodyJson;
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = typeof req.bodyText === 'string' ? req.bodyText : (typeof req.body === 'string' ? req.body : null);
  if (raw) {
    try {
      return JSON.parse(raw);
    } catch {
      return raw;
    }
  }
  return req;
}

async function main(context = {}, resArg) {
  let req, res, log, error;
  if (resArg !== undefined || (context && context.headers && !context.req)) {
    req = context;
    res = resArg;
    log = console.log;
    error = console.error;
  } else {
    req = context.req;
    res = context.res;
    log = context.log || console.log;
    error = context.error || console.error;
  }

  const safeRes = {
    json: (data, status = 200, headers = {}) => {
      if (res && typeof res.json === 'function') {
        return res.json(data, status, { 'Access-Control-Allow-Origin': '*', ...headers });
      }
      return { status, body: data, headers };
    },
    empty: () => {
      if (res && typeof res.empty === 'function') return res.empty();
      if (res && typeof res.text === 'function') return res.text('', 204);
      return { status: 204 };
    },
    text: (str, status = 200, headers = {}) => {
      if (res && typeof res.text === 'function') {
        return res.text(str, status, { 'Access-Control-Allow-Origin': '*', ...headers });
      }
      return { status, body: str, headers };
    },
  };

  const method = (req && req.method ? String(req.method) : 'POST').toUpperCase();
  if (method === 'OPTIONS') {
    return safeRes.text('', 204, {
      'Access-Control-Allow-Origin': '*',
      'Access-Control-Allow-Methods': 'POST, GET, OPTIONS',
      'Access-Control-Allow-Headers': 'Content-Type, Authorization, X-MCP-Token, X-Appwrite-Project',
    });
  }

  if (method === 'GET') {
    return safeRes.json({
      status: 'ok',
      service: 'federwerk-mcp',
      description: 'Federwerk Model Context Protocol (MCP) server running on Appwrite Functions',
      protocolVersion: PROTOCOL_VERSION,
    });
  }

  const config = getConfig();

  try {
    requireConfig(config, req && req.headers);
    const userId = await resolveUserId(config);
    const handler = createAppwriteHandler(withUser(config, userId));
    const result = await handler(parseBody(req));
    if (result === null || result === undefined) return safeRes.empty();
    return safeRes.json(result);
  } catch (err) {
    if (typeof error === 'function') error(err.message || String(err));
    const isAuth = err.message === 'Unauthorized';
    const status = isAuth ? 401 : 500;
    return safeRes.json({
      jsonrpc: '2.0',
      id: null,
      error: { code: isAuth ? -32001 : -32000, message: err.message },
    }, status);
  }
}

main.main = main;
main.getConfig = getConfig;
main.createAppwriteHandler = createAppwriteHandler;
main.requireConfig = requireConfig;
main.authHeaders = authHeaders;
main.ensureSession = ensureSession;
main.sessionInfo = sessionInfo;
main.resolveUserId = resolveUserId;
main.withUser = withUser;
main.canLoginFromStore = canLoginFromStore;
main._resetSession = resetSession;
main._resetSessionCache = () => { cachedSessionUser = null; };
main.parseBody = parseBody;
main.authValue = authValue;

module.exports = main;
