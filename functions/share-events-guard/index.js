// functions/share-events-guard – Appwrite Function (Node 20+, keine Deps).
//
// Proxy für Liveshare-Events (js/liveshare.js): Der Client schickt Events an
// diese Function statt direkt in die Tabelle `share_events`. Die Function
//   1. verifiziert die Session serverseitig (GET /account mit
//      X-Appwrite-Session -> verifizierte userId, Client-Angaben zählen nicht),
//   2. lädt die Share-Row mit API-Key und prüft: existiert, nicht revoked,
//      nicht abgelaufen, Absender darf diese Kind senden (Owner immer,
//      Gast nur bei mode=edit; sync-state/sync-chunk nur Owner),
//   3. schreibt erst dann die Event-Row mit API-Key (userId = verifiziert).
//
// Ohne diese Function kann jeder eingeloggte User, der den 12-stelligen Code
// kennt, Events in fremde Sessions injizieren (Appwrite-Row-Perms kennen
// keine Share-Mitgliedschaft) – der Client filtert dann nur noch.
//
// Deploy: Function anlegen (Runtime Node, Entrypoint index.js), Env setzen
// (siehe README.md), Execute-Access: "Any" (Auth prüft die Function selbst
// anhand der Session). Danach in Federwerk unter ⚙ die Executions-URL als
// „Liveshare-Guard-URL" eintragen – ab dann laufen Events exklusiv hierüber.
'use strict';

const KINDS = [
  'hello', 'heartbeat', 'bye',
  'stroke-add', 'stroke-del',
  'text-upsert', 'text-del',
  'cursor', 'sync-request', 'sync-state', 'sync-chunk',
];
const CODE_RE = /^s[a-z0-9]{11}$/;
const MUTATING_KINDS = [
  'stroke-add', 'stroke-del',
  'text-upsert', 'text-del',
  'sync-state', 'sync-chunk',
];
const OWNER_ONLY_KINDS = ['sync-state', 'sync-chunk'];
const MAX_PAYLOAD_BYTES = 32 * 1024;

/* ---------- reine Regeln (teilweise Duplikat aus js/liveshare.js) ---------- */

function isValidShareCode(code) {
  return typeof code === 'string' && CODE_RE.test(code.trim());
}
function isoToMs(iso) {
  const t = Date.parse(iso || '');
  return Number.isFinite(t) ? t : 0;
}
// Spiegel von js/liveshare.js#shareUsable (dort Source of Truth für Client).
function shareUsable(shareRow, atMs) {
  const r = shareRow || {};
  if (!r.shareId && !r.$id) return { ok: false, reason: 'unbekannt' };
  if (r.revoked) return { ok: false, reason: 'zurückgezogen' };
  if (r.expiresAt) {
    const t = isoToMs(r.expiresAt);
    if (t && (atMs == null ? Date.now() : +atMs) >= t) return { ok: false, reason: 'abgelaufen' };
  }
  return { ok: true, reason: '' };
}
// Spiegel von js/liveshare.js#canSendKind (dort Source of Truth für Client).
function canSendKind(kind, senderIsOwner, mode) {
  if (KINDS.indexOf(kind) < 0) return false;
  if (MUTATING_KINDS.indexOf(kind) < 0) return true;
  if (OWNER_ONLY_KINDS.indexOf(kind) >= 0) return !!senderIsOwner;
  if (senderIsOwner) return true;
  return mode === 'edit';
}
function checkSender(shareRow, verifiedUserId, kind, atMs) {
  if (!verifiedUserId) return { ok: false, reason: 'unauthentifiziert' };
  const usable = shareUsable(shareRow, atMs);
  if (!usable.ok) return usable;
  const owner = shareRow.ownerId === verifiedUserId;
  if (!canSendKind(kind, owner, shareRow.mode)) {
    return { ok: false, reason: shareRow.mode === 'edit' ? 'nur Owner' : 'Lesemodus: nur Owner darf schreiben' };
  }
  return { ok: true, reason: '', isOwner: owner };
}
function sanitizeEvent(ev, verifiedUserId) {
  if (!ev || typeof ev !== 'object') throw new Error('Event fehlt');
  const shareId = typeof ev.shareId === 'string' ? ev.shareId.trim() : '';
  if (!isValidShareCode(shareId)) throw new Error('shareId ungültig');
  if (KINDS.indexOf(ev.kind) < 0) throw new Error('kind ungültig: ' + ev.kind);
  const payload = typeof ev.payload === 'string' ? ev.payload : JSON.stringify(ev.payload == null ? {} : ev.payload);
  if (new TextEncoder().encode(payload).length > MAX_PAYLOAD_BYTES) {
    throw new Error('Payload zu groß (max. 32 KB)');
  }
  return {
    shareId,
    userId: verifiedUserId, // verifiziert – Client-Angabe wird ignoriert
    userName: String(ev.userName || '').slice(0, 64),
    userColor: String(ev.userColor || '').slice(0, 16),
    kind: ev.kind,
    payload,
    createdAt: new Date().toISOString(),
  };
}

/* ---------- Appwrite-REST (mit API-Key bzw. User-Session) ---------- */

function env() {
  return {
    endpoint: (process.env.APPWRITE_ENDPOINT || 'https://fra.cloud.appwrite.io/v1').replace(/\/$/, ''),
    projectId: process.env.APPWRITE_PROJECT_ID || '',
    databaseId: process.env.APPWRITE_DATABASE_ID || 'federwerk',
    apiKey: process.env.APPWRITE_API_KEY || '',
  };
}
function keyHeaders(c) {
  return {
    'X-Appwrite-Project': c.projectId,
    'X-Appwrite-Key': c.apiKey,
    'X-Appwrite-Response-Format': '2.0.0',
    'Content-Type': 'application/json',
  };
}
async function readJsonSafe(r) {
  try { return await r.json(); } catch { return {}; }
}
// Session-Secret -> verifizierte userId (oder null).
async function verifySession(c, sessionSecret) {
  if (!sessionSecret) return null;
  const r = await fetch(c.endpoint + '/account', {
    headers: {
      'X-Appwrite-Project': c.projectId,
      'X-Appwrite-Session': sessionSecret,
    },
  });
  if (!r.ok) return null;
  const j = await readJsonSafe(r);
  return (j && j.$id) ? String(j.$id) : null;
}
async function loadShare(c, shareId) {
  const r = await fetch(
    c.endpoint + '/tablesdb/' + c.databaseId + '/tables/shares/rows/' + encodeURIComponent(shareId),
    { headers: keyHeaders(c) }
  );
  if (r.status === 404) return null;
  const j = await readJsonSafe(r);
  if (!r.ok) throw new Error((j && j.message) || ('Share-Load HTTP ' + r.status));
  return Object.assign({}, j, { shareId });
}
async function writeEvent(c, row) {
  const r = await fetch(
    c.endpoint + '/tablesdb/' + c.databaseId + '/tables/share_events/rows',
    {
      method: 'POST',
      headers: keyHeaders(c),
      body: JSON.stringify({ rowId: 'unique()', data: row, permissions: ['read("users")'] }),
    }
  );
  const j = await readJsonSafe(r);
  if (!r.ok) throw new Error((j && j.message) || ('Event-Write HTTP ' + r.status));
  return j;
}

/* ---------- Handler (open-runtimes: module.exports = async (context)) ---------- */

function getHeader(headers, name) {
  if (!headers || typeof headers !== 'object') return '';
  const want = String(name).toLowerCase();
  for (const k of Object.keys(headers)) {
    if (k.toLowerCase() === want) {
      const v = headers[k];
      return typeof v === 'string' ? v : String(v == null ? '' : v);
    }
  }
  return '';
}
function parseBody(req) {
  if (!req) return {};
  if (req.body && typeof req.body === 'object') return req.body;
  const raw = req.bodyText || (typeof req.body === 'string' ? req.body : '');
  if (!raw) return {};
  try { return JSON.parse(raw); } catch { return {}; }
}

async function handler(context) {
  const req = (context && context.req) || {};
  const res = (context && context.res) || null;
  const fail = (status, message) => {
    if (res && typeof res.json === 'function') return res.json({ ok: false, error: message }, status);
    return { status, body: { ok: false, error: message } };
  };
  const done = (body) => {
    if (res && typeof res.json === 'function') return res.json(Object.assign({ ok: true }, body), 200);
    return { status: 200, body: Object.assign({ ok: true }, body) };
  };
  try {
    const c = env();
    if (!c.projectId || !c.apiKey) return fail(500, 'Guard nicht konfiguriert (APPWRITE_PROJECT_ID/APPWRITE_API_KEY fehlen)');
    const method = String(req.method || 'POST').toUpperCase();
    if (method === 'GET') return done({ service: 'federwerk-share-guard' });
    if (method !== 'POST') return fail(405, 'Nur POST');
    const body = parseBody(req);
    const sessionSecret = getHeader(req.headers, 'x-appwrite-session') || String(body.session || '');
    const userId = await verifySession(c, sessionSecret).catch(() => null);
    if (!userId) return fail(401, 'Ungültige Appwrite-Session');
    let row;
    try {
      row = sanitizeEvent(body.event, userId);
    } catch (e) {
      return fail(400, e.message);
    }
    const share = await loadShare(c, row.shareId).catch(() => null);
    if (!share) return fail(404, 'Share unbekannt');
    const chk = checkSender(share, userId, row.kind, Date.now());
    if (!chk.ok) return fail(403, 'Abgelehnt: ' + chk.reason);
    // isOwner als ehrliche Server-Aussage beilegen (Client nutzt sie für LWW-Anzeige).
    try {
      const p = JSON.parse(row.payload);
      if (p && typeof p === 'object' && !Array.isArray(p)) {
        p.isOwner = chk.isOwner;
        row.payload = JSON.stringify(p);
      }
    } catch { /* Payload bleibt wie-is */ }
    const saved = await writeEvent(c, row);
    return done({ id: (saved && (saved.$id || saved.id)) || null });
  } catch (e) {
    if (typeof console !== 'undefined' && console.error) console.error('share-guard:', e && e.message);
    return fail(500, 'Guard-Fehler');
  }
}

module.exports = handler;
module.exports.shareUsable = shareUsable;
module.exports.canSendKind = canSendKind;
module.exports.checkSender = checkSender;
module.exports.sanitizeEvent = sanitizeEvent;
module.exports.isValidShareCode = isValidShareCode;
