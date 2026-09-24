/* Federwerk Liveshare – gemeinsam auf einer Seite schreiben (Appwrite-only).
 *
 * V1: kein eigener Server, kein Tracking-Drittanbieter. Zwei neue
 * Appwrite-Tabellen (TablesDB) neben `notes`/`folders`:
 *   - `shares`: eine Row pro Freigabe (code = Row-ID, lesbar für alle
 *     Eingeloggten, schreibbar nur für Owner).
 *   - `share_events`: Append-only Events (Strokes, Texte, Cursor,
 *     Presence, Sync). Lesbar für alle Eingeloggten, anlegbar von allen
 *     Eingeloggten – der Code (12 Zeichen) + Ablaufdatum begrenzen Zugriff.
 *
 * Live-Transport: Appwrite Realtime-WebSocket auf beide Tabellen
 * (Client filtert nach shareId), mit Polling-Fallback alle 4s.
 * Merge: Last-Writer-Wins pro Stroke/Text-ID (SPEC-35, kein Full-Overwrite).
 * Remote-Cursor: als DIV-Overlay (kein Canvas-Konflikt mit Laser/Hover).
 *
 * Kein Build, plain <script>. Reine Kernfunktionen sind DOM-frei und in
 * Node testbar (siehe tests/liveshare.test.js).
 */
(function () {
  'use strict';

  const SHARE_TABLE = 'shares';
  const EVENT_TABLE = 'share_events';
  const CODE_RE = /^s[a-z0-9]{11}$/;
  const MODES = ['read', 'edit'];
  const KINDS = [
    'hello', 'heartbeat', 'bye',
    'stroke-add', 'stroke-del',
    'text-upsert', 'text-del',
    'cursor', 'sync-request', 'sync-state', 'sync-chunk',
  ];
  const PRESENCE_TIMEOUT_MS = 25000;
  const HEARTBEAT_MS = 10000;
  const CURSOR_MIN_MS = 120;
  const SNAPSHOT_MAX_BYTES = 48000;
  const CHUNK_SIZE = 30000;
  const CHUNK_MAX = 8;
  const POLL_MS = 4000;

  const PALETTE = [
    '#c0392b', '#8e44ad', '#2471a3', '#16a085',
    '#af601a', '#2e86c1', '#ca6f1e', '#7d3c98',
  ];

  function nowMs() { return Date.now(); }
  function uid(n) {
    const abc = 'abcdefghijklmnopqrstuvwxyz0123456789';
    let out = '';
    try {
      const buf = new Uint8Array(n || 11);
      const c = (typeof crypto !== 'undefined' && crypto.getRandomValues)
        ? crypto : null;
      if (c) {
        c.getRandomValues(buf);
        for (let i = 0; i < buf.length; i++) out += abc[buf[i] % 36];
        return out;
      }
    } catch { /* Fallback unten */ }
    for (let i = 0; i < (n || 11); i++) {
      out += abc[Math.floor(Math.random() * 36)];
    }
    return out;
  }

  /* ---------- Share-Code & Link (rein) ---------- */

  function makeShareCode() { return 's' + uid(11); }
  function isValidShareCode(code) {
    return typeof code === 'string' && CODE_RE.test(code.trim());
  }
  function normalizeCode(code) {
    const s = String(code == null ? '' : code).trim();
    return isValidShareCode(s) ? s : null;
  }
  function encodeShareLink(origin, pathname, code) {
    const c = normalizeCode(code);
    if (!c) throw new Error('ungültiger Share-Code');
    const o = String(origin || '').replace(/\/$/, '');
    const p = String(pathname || '/');
    return o + p + '#share=' + c;
  }
  // Findet den Code in Location-Hash, Query (?share=) oder rohem Text.
  function parseShareCode(input) {
    if (input == null) return null;
    const s = String(input);
    const m = s.match(/s[a-z0-9]{11}/);
    return m && isValidShareCode(m[0]) ? m[0] : null;
  }
  function parseShareCodeFromHash(hash) {
    if (!hash) return null;
    const s = String(hash).replace(/^#/, '');
    const q = s.match(/(?:^|[&#?])share=([^&#]*)/);
    if (q) {
      const c = normalizeCode(decodeURIComponent(q[1] || ''));
      if (c) return c;
    }
    return parseShareCode(s);
  }

  /* ---------- Ablauf & Rechte (rein) ---------- */

  function msToIso(ms) {
    try { return new Date(ms).toISOString(); } catch { return new Date(0).toISOString(); }
  }
  function isoToMs(iso) {
    const t = Date.parse(iso || '');
    return Number.isFinite(t) ? t : 0;
  }
  function expiryIso(ttlHours, baseMs) {
    if (ttlHours == null || !(ttlHours > 0)) return null; // nie
    return msToIso((baseMs == null ? nowMs() : +baseMs) + ttlHours * 3600 * 1000);
  }
  function isExpired(expiresAtIso, atMs) {
    if (!expiresAtIso) return false;
    const t = isoToMs(expiresAtIso);
    if (!t) return false;
    return (atMs == null ? nowMs() : +atMs) >= t;
  }
  function isRevoked(shareRow) {
    return !!((shareRow || {}).revoked);
  }
  function shareUsable(shareRow, atMs) {
    const r = shareRow || {};
    if (!r.shareId && !r.$id) return { ok: false, reason: 'unbekannt' };
    if (isRevoked(r)) return { ok: false, reason: 'zurückgezogen' };
    if (isExpired(r.expiresAt, atMs)) return { ok: false, reason: 'abgelaufen' };
    return { ok: true, reason: '' };
  }
  function canWrite(mode, isOwner) {
    if (isOwner) return true;
    return mode === 'edit';
  }
  function normalizeMode(m) { return m === 'edit' ? 'edit' : 'read'; }

  function pickColor(userId) {
    const s = String(userId || '?');
    let h = 0;
    for (let i = 0; i < s.length; i++) h = (h * 31 + s.charCodeAt(i)) >>> 0;
    return PALETTE[h % PALETTE.length];
  }
  function shortName(name, userId) {
    const n = String(name || '').trim();
    if (n) return n.slice(0, 24);
    return 'Gast-' + String(userId || '?').slice(-4);
  }

  /* ---------- Events (rein) ---------- */

  function buildEvent(input) {
    const i = input || {};
    const shareId = normalizeCode(i.shareId);
    if (!shareId) throw new Error('shareId ungültig');
    if (KINDS.indexOf(i.kind) < 0) throw new Error('kind ungültig: ' + i.kind);
    const ev = {
      shareId,
      userId: String(i.userId || ''),
      userName: String(i.userName || '').slice(0, 64),
      userColor: String(i.userColor || '').slice(0, 16),
      kind: i.kind,
      payload: typeof i.payload === 'string' ? i.payload : JSON.stringify(i.payload == null ? {} : i.payload),
      createdAt: i.createdAt || msToIso(nowMs()),
    };
    if (!ev.userId) throw new Error('userId fehlt');
    if (ev.payload.length > CHUNK_SIZE + 2000 && i.kind !== 'sync-state') {
      throw new Error('Payload zu groß (' + ev.payload.length + ' Bytes)');
    }
    return ev;
  }
  function validateEvent(ev) {
    if (!ev || typeof ev !== 'object') return false;
    if (!normalizeCode(ev.shareId)) return false;
    if (KINDS.indexOf(ev.kind) < 0) return false;
    if (!ev.userId || typeof ev.payload !== 'string') return false;
    return true;
  }
  function parsePayload(ev) {
    try { return JSON.parse(ev.payload || '{}'); }
    catch { return null; }
  }

  /* ---------- Strokes: IDs + LWW-Merge (rein) ---------- */

  function genStrokeId() {
    return 'st' + nowMs().toString(36) + uid(6);
  }
  // Vergibt fehlende IDs/in-place-Timestamps (ändert übergebene Strokes).
  function ensureStrokeIds(strokes, gen) {
    const g = typeof gen === 'function' ? gen : genStrokeId;
    let fixed = 0;
    for (const s of strokes || []) {
      if (!s || typeof s !== 'object') continue;
      if (typeof s.id !== 'string' || !s.id) { s.id = g(); fixed++; }
      if (!(s.updatedAt > 0)) s.updatedAt = nowMs();
    }
    return fixed;
  }
  function strokeById(strokes, id) {
    for (const s of strokes || []) if (s && s.id === id) return s;
    return null;
  }
  // Ein Remote-Stroke: addieren oder per updatedAt ersetzen. Nie löschen.
  function mergeStroke(strokes, remote) {
    const list = Array.isArray(strokes) ? strokes : [];
    if (!remote || !remote.id) return { strokes: list, changed: false, applied: 'ignored' };
    const ix = list.findIndex(s => s && s.id === remote.id);
    if (ix < 0) {
      list.push(remote);
      return { strokes: list, changed: true, applied: 'added' };
    }
    const cur = list[ix];
    const rc = Number(remote.updatedAt) || 0, lc = Number(cur.updatedAt) || 0;
    if (rc > lc) {
      list[ix] = remote;
      return { strokes: list, changed: true, applied: 'replaced' };
    }
    return { strokes: list, changed: false, applied: 'stale' };
  }
  function applyStrokeDeletes(strokes, ids) {
    const list = Array.isArray(strokes) ? strokes : [];
    const gone = new Set(Array.isArray(ids) ? ids : []);
    if (!gone.size) return { strokes: list, removed: 0 };
    const before = list.length;
    const kept = list.filter(s => !(s && gone.has(s.id)));
    return { strokes: kept, removed: before - kept.length };
  }

  /* ---------- Texte: LWW (rein) ---------- */

  function mergeText(texts, remote) {
    const list = Array.isArray(texts) ? texts : [];
    if (!remote || !remote.id) return { texts: list, changed: false, applied: 'ignored' };
    const ix = list.findIndex(t => t && t.id === remote.id);
    if (ix < 0) {
      list.push(remote);
      return { texts: list, changed: true, applied: 'added' };
    }
    const rc = Number(remote.updatedAt) || 0, lc = Number(list[ix].updatedAt) || 0;
    if (rc >= lc) {
      list[ix] = remote;
      return { texts: list, changed: true, applied: 'replaced' };
    }
    return { texts: list, changed: false, applied: 'stale' };
  }
  function applyTextDeletes(texts, ids) {
    const list = Array.isArray(texts) ? texts : [];
    const gone = new Set(Array.isArray(ids) ? ids : []);
    if (!gone.size) return { texts: list, removed: 0 };
    const kept = list.filter(t => !(t && gone.has(t.id)));
    return { texts: kept, removed: list.length - kept.length };
  }

  /* ---------- Snapshot (rein) ---------- */

  // Snapshot behält alle Stil-Felder (fill/dash/alpha, fontSize/color/align),
  // damit Remote-Seiten identisch rendern – nur HTML wird längenbegrenzt.
  function stripStroke(s) {
    const c = Object.assign({}, s);
    if (!c.id) c.id = genStrokeId();
    if (!(c.updatedAt > 0)) c.updatedAt = nowMs();
    return c;
  }
  function stripText(t) {
    const c = Object.assign({}, t);
    if (typeof c.html === 'string') {
      c.html = (typeof GrimoireSanitize !== 'undefined' ? GrimoireSanitize.sanitizeHtml(c.html) : c.html).slice(0, 20000);
    }
    if (!(c.updatedAt > 0)) c.updatedAt = nowMs();
    return c;
  }
  function buildPageSnapshot(page) {
    const p = page || {};
    const strokes = (Array.isArray(p.strokes) ? p.strokes : []).map(stripStroke);
    const texts = (Array.isArray(p.texts) ? p.texts : []).map(stripText);
    return { pageId: p.id || null, strokes, texts, at: msToIso(nowMs()) };
  }
  function snapshotBytes(snap) {
    try { return new TextEncoder().encode(JSON.stringify(snap)).length; }
    catch { return JSON.stringify(snap).length; }
  }
  function snapshotFits(snap, maxBytes) {
    return snapshotBytes(snap) <= (maxBytes == null ? SNAPSHOT_MAX_BYTES : maxBytes);
  }
  // Vereinigt Snapshot in die Seite (LWW pro ID, löscht nichts).
  function applyPageSnapshot(page, snap) {
    const p = page || {};
    if (!Array.isArray(p.strokes)) p.strokes = [];
    if (!Array.isArray(p.texts)) p.texts = [];
    const s = snap || {};
    let added = 0, replaced = 0;
    for (const rs of s.strokes || []) {
      const r = mergeStroke(p.strokes, rs);
      if (r.changed) { if (r.applied === 'added') added++; else replaced++; }
    }
    let tAdded = 0, tReplaced = 0;
    for (const rt of s.texts || []) {
      const r = mergeText(p.texts, rt);
      if (r.changed) { if (r.applied === 'added') tAdded++; else tReplaced++; }
    }
    return { added, replaced, tAdded, tReplaced };
  }

  /* ---------- Chunking für große Sync-States (rein) ---------- */

  function chunkString(str, size) {
    const s = String(str == null ? '' : str);
    const n = Math.max(1, size || CHUNK_SIZE);
    const out = [];
    for (let i = 0; i < s.length; i += n) out.push(s.slice(i, i + n));
    return out;
  }
  function makeSyncChunks(shareId, user, snapshotJson, transferId) {
    const parts = chunkString(snapshotJson, CHUNK_SIZE);
    if (parts.length > CHUNK_MAX) throw new Error('Snapshot zu groß für Live-Sync (Bilder bitte entfernen)');
    const tid = transferId || ('tr' + nowMs().toString(36) + uid(4));
    return parts.map((chunk, i) => buildEvent({
      shareId, userId: user.userId, userName: user.userName,
      userColor: user.userColor, kind: 'sync-chunk',
      payload: { transferId: tid, index: i, total: parts.length, chunk },
    }));
  }
  // Sammelt sync-chunk-Events; gibt {complete, json} zurück.
  function collectSyncChunks(store, ev) {
    const p = parsePayload(ev);
    if (!p || !p.transferId || !(p.chunk != null)) return { complete: false, json: null };
    const key = String(p.transferId);
    const cur = store[key] || { total: p.total, parts: [] };
    cur.total = p.total;
    cur.parts[Number(p.index)] = String(p.chunk);
    store[key] = cur;
    const filled = cur.parts.filter(x => typeof x === 'string').length;
    if (filled >= cur.total && cur.total > 0) {
      const json = cur.parts.slice(0, cur.total).join('');
      delete store[key];
      return { complete: true, json };
    }
    return { complete: false, json: null };
  }

  /* ---------- Presence (rein) ---------- */

  function presenceNew() { return {}; }
  // peers: {userId: {userId, userName, userColor, pageId, cursor, lastSeenMs, isOwner}}
  function presenceSee(peers, info, atMs) {
    const now = atMs == null ? nowMs() : +atMs;
    const p = peers || {};
    if (!info || !info.userId) return p;
    const prev = p[info.userId] || {};
    p[info.userId] = {
      userId: info.userId,
      userName: info.userName || prev.userName || 'Gast',
      userColor: info.userColor || prev.userColor || pickColor(info.userId),
      pageId: info.pageId !== undefined ? info.pageId : prev.pageId,
      cursor: info.cursor !== undefined ? info.cursor : prev.cursor,
      isOwner: !!info.isOwner || !!prev.isOwner,
      lastSeenMs: now,
    };
    return p;
  }
  function presencePrune(peers, atMs, timeoutMs) {
    const now = atMs == null ? nowMs() : +atMs;
    const t = timeoutMs == null ? PRESENCE_TIMEOUT_MS : timeoutMs;
    const out = {};
    for (const k of Object.keys(peers || {})) {
      const p = peers[k];
      if (p && (now - (p.lastSeenMs || 0)) <= t) out[k] = p;
    }
    return out;
  }
  function presenceList(peers) {
    return Object.keys(peers || {}).map(k => peers[k])
      .sort((a, b) => String(a.userName).localeCompare(String(b.userName, 'de')));
  }
  function shouldSendCursor(lastSentMs, atMs, minMs) {
    const m = minMs == null ? CURSOR_MIN_MS : minMs;
    return ((atMs == null ? nowMs() : +atMs) - (lastSentMs || 0)) >= m;
  }

  /* ---------- Appwrite-Zeilen (rein: Body/Perms/Queries) ---------- */

  function sharePerms(ownerId) {
    const o = String(ownerId || '');
    return [
      'read("users")',
      'update("user:' + o + '")',
      'delete("user:' + o + '")',
    ];
  }
  function eventPerms(userId) {
    const u = String(userId || '');
    return [
      'read("users")',
      'update("user:' + u + '")',
      'delete("user:' + u + '")',
    ];
  }
  function shareRowBody(input) {
    const i = input || {};
    return {
      shareId: normalizeCode(i.shareId),
      bookId: String(i.bookId || ''),
      ownerId: String(i.ownerId || ''),
      ownerName: String(i.ownerName || '').slice(0, 64),
      title: String(i.title || 'Geteilte Seite').slice(0, 160),
      mode: normalizeMode(i.mode),
      pageId: i.pageId == null ? null : String(i.pageId),
      expiresAt: i.expiresAt || null,
      revoked: !!i.revoked,
      snapshot: typeof i.snapshot === 'string' ? i.snapshot : JSON.stringify(i.snapshot == null ? {} : i.snapshot),
      createdAt: i.createdAt || msToIso(nowMs()),
      updatedAt: i.updatedAt || msToIso(nowMs()),
    };
  }
  function eventRowBody(ev, permsFor) {
    if (!validateEvent(ev)) throw new Error('Event ungültig');
    return {
      row: {
        shareId: ev.shareId,
        userId: ev.userId,
        userName: ev.userName,
        userColor: ev.userColor,
        kind: ev.kind,
        payload: ev.payload,
        createdAt: ev.createdAt,
      },
      permissions: permsFor || eventPerms(ev.userId),
    };
  }
  const EQ = {
    limit: n => JSON.stringify({ method: 'limit', values: [n] }),
    orderAsc: a => JSON.stringify({ method: 'orderAsc', attribute: a }),
    orderDesc: a => JSON.stringify({ method: 'orderDesc', attribute: a }),
    equal: (a, v) => JSON.stringify({ method: 'equal', attribute: a, values: [v] }),
    greaterThan: (a, v) => JSON.stringify({ method: 'greaterThan', attribute: a, values: [v] }),
    cursorAfter: id => JSON.stringify({ method: 'cursorAfter', values: [id] }),
  };
  function eventQueries(shareId, sinceIso) {
    const qs = [EQ.equal('shareId', shareId), EQ.orderAsc('$createdAt'), EQ.limit(100)];
    if (sinceIso) qs.push(EQ.greaterThan('$createdAt', sinceIso));
    return qs;
  }

  const Live = {
    // Konstanten + Reines
    SHARE_TABLE, EVENT_TABLE, MODES, KINDS,
    PRESENCE_TIMEOUT_MS, HEARTBEAT_MS, CURSOR_MIN_MS,
    SNAPSHOT_MAX_BYTES, CHUNK_SIZE, CHUNK_MAX, POLL_MS,
    makeShareCode, isValidShareCode, normalizeCode,
    encodeShareLink, parseShareCode, parseShareCodeFromHash,
    msToIso, isoToMs, expiryIso, isExpired, isRevoked, shareUsable,
    canWrite, normalizeMode, pickColor, shortName,
    buildEvent, validateEvent, parsePayload,
    genStrokeId, ensureStrokeIds, strokeById, mergeStroke, applyStrokeDeletes,
    mergeText, applyTextDeletes,
    buildPageSnapshot, snapshotBytes, snapshotFits, applyPageSnapshot,
    chunkString, makeSyncChunks, collectSyncChunks,
    presenceNew, presenceSee, presencePrune, presenceList, shouldSendCursor,
    sharePerms, eventPerms, shareRowBody, eventRowBody, eventQueries, EQ,
  };

  /* ---------- Browser-Transport + Session (nur Browser) ---------- */

  const isBrowser = (typeof window !== 'undefined' && typeof document !== 'undefined');

  if (isBrowser) {
    const S = {
      share: null,       // Share-Row (remote)
      isOwner: false,
      joined: false,
      peers: presenceNew(),
      me: null,          // {userId, userName, userColor}
      ws: null, wsOk: false,
      pollTimer: 0, hbTimer: 0,
      lastCursorSent: 0,
      lastEventAt: null, // ISO des neuesten Events (Poll-Cursor)
      chunkStore: {},
      statusEl: null,
    };

    function filesApi() {
      if (window.FederwerkFiles) return window.FederwerkFiles;
      throw new Error('FederwerkFiles fehlt – Appwrite in ⚙ einrichten');
    }
    function cfg() { return filesApi().loadConfig(); }
    function headers(extra) {
      const h = filesApi().authHeaders(cfg());
      h['Content-Type'] = 'application/json';
      return Object.assign(h, extra || {});
    }
    function q(params) {
      return '?' + params.map((p, i) => 'queries[' + i + ']=' + encodeURIComponent(p)).join('&');
    }
    async function rest(method, path, body) {
      const c = cfg();
      const r = await fetch(c.endpoint + path, {
        method, headers: headers(),
        credentials: 'include',
        body: body ? JSON.stringify(body) : undefined,
      });
      if (r.status === 204 || r.status === 205) return null;
      const j = await r.json().catch(() => ({}));
      if (!r.ok) {
        const e = new Error((j && j.message) || ('HTTP ' + r.status));
        e.status = r.status; e.body = j;
        throw e;
      }
      return j;
    }
    function tablesPath(table, suffix) {
      const c = cfg();
      return '/tablesdb/' + c.databaseId + '/tables/' + table + '/rows' + (suffix || '');
    }
    async function currentUser() {
      const me = await filesApi().session();
      if (!me) throw new Error('Bitte zuerst in ⚙ Appwrite einloggen (Liveshare braucht einen Account).');
      const name = me.name || me.email || me.$id;
      return { userId: me.$id, userName: shortName(name, me.$id), userColor: pickColor(me.$id) };
    }

    /* ----- Share-Rows ----- */

    async function createShareRow(body, ownerId) {
      const code = body.shareId;
      try {
        return await rest('POST', tablesPath(SHARE_TABLE), {
          rowId: code, data: body, permissions: sharePerms(ownerId),
        });
      } catch (e) {
        if (e && e.status === 409) {
          return rest('PUT', tablesPath(SHARE_TABLE, '/' + code), { data: body });
        }
        throw e;
      }
    }
    async function getShareRow(code) {
      return rest('GET', tablesPath(SHARE_TABLE, '/' + code));
    }
    async function patchShareRow(code, data) {
      return rest('PUT', tablesPath(SHARE_TABLE, '/' + code), { data });
    }
    async function deleteShareRow(code) {
      try { await rest('DELETE', tablesPath(SHARE_TABLE, '/' + code)); }
      catch (e) { if (!(e && e.status === 404)) throw e; }
    }

    /* ----- Events ----- */

    async function postEvent(ev) {
      const b = eventRowBody(ev);
      return rest('POST', tablesPath(EVENT_TABLE), {
        rowId: 'unique()', data: b.row, permissions: b.permissions,
      });
    }
    async function listEvents(code, sinceIso) {
      const params = eventQueries(code, sinceIso);
      // Erste Seite reicht für Live (100 Events); älteres holt Poll nach.
      const j = await rest('GET', tablesPath(EVENT_TABLE, q(params)));
      return (j && (j.rows || j.documents)) || [];
    }

    /* ----- Lokales Buch/Seite finden ----- */

    function appGlobals() {
      const g = (typeof window !== 'undefined') ? window : {};
      return {
        state: g.state || null,
        openBook: (typeof g.openBook === 'function') ? g.openBook : null,
        currentPage: (typeof g.currentPage === 'function') ? g.currentPage : null,
        renderAll: (typeof g.renderAll === 'function') ? g.renderAll : null,
        renderCanvas: (typeof g.renderCanvas === 'function') ? g.renderCanvas : null,
        persistSoon: (typeof g.persistSoon === 'function') ? g.persistSoon : null,
        persistNow: (typeof g.persistNow === 'function') ? g.persistNow : null,
        openBookInPane: (typeof g.openBookInPane === 'function') ? g.openBookInPane : null,
      };
    }
    function liveBook() {
      const { state } = appGlobals();
      if (!state || !S.share) return null;
      const id = 'live-' + S.share.shareId;
      return (state.books || []).find(b => b && b.id === id) || null;
    }
    function livePage() {
      const b = liveBook();
      if (!b) return null;
      const pid = S.share.pageId;
      if (pid) {
        const p = (b.pages || []).find(p => p && p.id === pid);
        if (p) return p;
      }
      return (b.pages || [])[0] || null;
    }
    // Zielseite für Remote-Events: Owner schreibt ins Original, Gast ins Live-Buch.
    // Owner ohne Original (Zweitgerät ohne Cloud-Sync) nutzt die Live-Kopie.
    function targetPage() {
      const A = appGlobals();
      if (S.isOwner) {
        try {
          const b = (A.state.books || []).find(x => x && x.id === S.share.bookId);
          if (b) {
            const p = (b.pages || []).find(p => p && p.id === S.share.pageId) || b.pages[0];
            if (p) return p;
          }
        } catch { /* Fallback Live-Kopie */ }
        return livePage();
      }
      return livePage();
    }
    function touchAndRender() {
      try {
        const A = appGlobals();
        const b = (S.isOwner
          ? (A.state.books || []).find(x => x && x.id === S.share.bookId)
          : null) || liveBook();
        if (b) b.updatedAt = Date.now();
        if (A.persistSoon) A.persistSoon();
        if (A.renderCanvas) A.renderCanvas();
        else if (A.renderAll) A.renderAll();
      } catch { /* ignore */ }
    }

    /* ----- Event-Verarbeitung ----- */

    function myId() { return S.me && S.me.userId; }
    function handleRemoteRow(row) {
      try {
        const ev = {
          shareId: row.shareId, userId: row.userId, userName: row.userName,
          userColor: row.userColor, kind: row.kind, payload: row.payload,
          createdAt: row.createdAt || row.$createdAt || null,
        };
        if (!validateEvent(ev)) return;
        if (ev.shareId !== (S.share && (S.share.shareId || S.share.$id))) return;
        if (ev.userId === myId()) {
          // Eigene Presence trotzdem sehen (Heartbeat-Echo ignorieren)
          return;
        }
        if (row.$createdAt && (!S.lastEventAt || row.$createdAt > S.lastEventAt)) {
          S.lastEventAt = row.$createdAt;
        }
        routeEvent(ev);
      } catch { /* ignoriere defekte Rows */ }
    }
    function routeEvent(ev) {
      const payload = parsePayload(ev) || {};
      // Presence immer aktualisieren
      S.peers = presenceSee(S.peers, {
        userId: ev.userId, userName: ev.userName, userColor: ev.userColor,
        pageId: payload.pageId, cursor: ev.kind === 'cursor' ? payload : undefined,
        isOwner: !!payload.isOwner,
      });
      renderLiveBar();
      renderCursors();
      if (!S.joined) return;
      const page = targetPage();
      const writable = canWrite((S.share && S.share.mode) || 'read', S.isOwner);
      switch (ev.kind) {
        case 'hello':
        case 'heartbeat':
          if (S.isOwner && (payload.wantSync || ev.kind === 'hello')) sendSnapshotTo(ev.userId);
          break;
        case 'bye':
          delete S.peers[ev.userId];
          renderLiveBar(); renderCursors();
          break;
        case 'cursor':
          break; // nur Presence (oben)
        case 'stroke-add':
          if (!writable && !S.isOwner) break;
          if (payload.stroke && page) {
            const r = mergeStroke(page.strokes, payload.stroke);
            if (r.changed) touchAndRender();
          }
          break;
        case 'stroke-del':
          if (!writable && !S.isOwner) break;
          if (page && payload.ids) {
            const r = applyStrokeDeletes(page.strokes, payload.ids);
            if (r.removed) touchAndRender();
          }
          break;
        case 'text-upsert':
          if (!writable && !S.isOwner) break;
          if (payload.text && page) {
            const r = mergeText(page.texts, payload.text);
            if (r.changed) touchAndRender();
          }
          break;
        case 'text-del':
          if (!writable && !S.isOwner) break;
          if (page && payload.ids) {
            const r = applyTextDeletes(page.texts, payload.ids);
            if (r.removed) touchAndRender();
          }
          break;
        case 'sync-request':
          if (S.isOwner) sendSnapshotTo(ev.userId);
          break;
        case 'sync-state': {
          if (S.isOwner) break;
          const snap = payload.snapshot;
          if (snap && page) {
            applyPageSnapshot(page, snap);
            touchAndRender();
          }
          break;
        }
        case 'sync-chunk': {
          if (S.isOwner) break;
          const r = collectSyncChunks(S.chunkStore, ev);
          if (r.complete && r.json && page) {
            try {
              const snap = JSON.parse(r.json);
              applyPageSnapshot(page, snap);
              touchAndRender();
            } catch { /* defekter Transfer */ }
          }
          break;
        }
        default:
          break;
      }
    }

    /* ----- Senden ----- */

    async function send(kind, payload) {
      if (!S.share || !S.me) return;
      const ev = buildEvent({
        shareId: S.share.shareId || S.share.$id,
        userId: S.me.userId, userName: S.me.userName, userColor: S.me.userColor,
        kind, payload: Object.assign({ pageId: currentPageId(), isOwner: S.isOwner }, payload || {}),
      });
      await postEvent(ev).catch(() => null);
    }
    function currentPageId() {
      try {
        const A = appGlobals();
        if (A.currentPage) { const p = A.currentPage(); return (p && p.id) || null; }
      } catch { /* ignore */ }
      return (S.share && S.share.pageId) || null;
    }
    async function sendSnapshotTo() {
      // V1: Full-Snapshot an alle (Events sind Broadcast, kein DM).
      try {
        const A = appGlobals();
        let page = null;
        if (S.isOwner) {
          const b = (A.state.books || []).find(x => x && x.id === S.share.bookId);
          page = b ? ((b.pages || []).find(p => p && p.id === S.share.pageId) || b.pages[0]) : null;
        } else page = livePage();
        if (!page) return;
        const snap = buildPageSnapshot(page);
        const json = JSON.stringify(snap);
        if (snapshotFits(snap)) {
          await send('sync-state', { snapshot: snap });
        } else {
          const chunks = makeSyncChunks(
            S.share.shareId || S.share.$id, S.me, json);
          for (const c of chunks) await postEvent(c).catch(() => null);
        }
      } catch { /* ignore */ }
    }

    /* ----- Realtime + Polling ----- */

    function rtChannels() {
      const c = cfg();
      return [
        'databases.' + c.databaseId + '.tables.' + EVENT_TABLE + '.rows',
        'databases.' + c.databaseId + '.tables.' + SHARE_TABLE + '.rows',
      ];
    }
    function startRealtime() {
      stopRealtime();
      try {
        const c = cfg();
        const url = c.endpoint.replace(/^http/, 'ws') + '/realtime?project=' + c.projectId;
        const ws = new WebSocket(url);
        S.ws = ws;
        let hb = 0;
        ws.onopen = () => {
          S.wsOk = true;
          try { hb = setInterval(() => { try { ws.send(JSON.stringify({ type: 'ping' })); } catch { /* ignore */ } }, 20000); } catch { /* ignore */ }
          updateStatus();
        };
        ws.onmessage = (m) => {
          try {
            const msg = JSON.parse(m.data);
            if (!msg) return;
            if (msg.type === 'connected') {
              let secret = null;
              try { secret = (filesApi().loadSession() || {}).secret || null; } catch { /* ignore */ }
              if (secret && !(msg.data && msg.data.user)) {
                try { ws.send(JSON.stringify({ type: 'authentication', data: { session: secret } })); } catch { /* ignore */ }
              }
              try {
                ws.send(JSON.stringify({
                  type: 'subscribe',
                  data: [{ subscriptionId: 'live-' + Date.now().toString(36), channels: rtChannels(), queries: [] }],
                }));
              } catch { /* ignore */ }
            } else if (msg.type === 'event') {
              const d = msg.data || {};
              const row = d.payload || d.row || null;
              const ch = (d.channels || []).join(' ');
              if (row && ch.indexOf(EVENT_TABLE) >= 0) handleRemoteRow(row);
              else pollOnce();
            }
          } catch { /* ignore */ }
        };
        ws.onerror = () => { /* Polling trägt */ };
        ws.onclose = () => {
          S.wsOk = false; S.ws = null;
          try { clearInterval(hb); } catch { /* ignore */ }
          updateStatus();
        };
      } catch { /* nur Polling */ }
    }
    function stopRealtime() {
      try { if (S.ws) S.ws.close(); } catch { /* ignore */ }
      S.ws = null; S.wsOk = false;
    }
    async function pollOnce() {
      if (!S.share || !S.joined) return;
      try {
        const rows = await listEvents(S.share.shareId || S.share.$id, S.lastEventAt);
        for (const r of rows) handleRemoteRow(r);
      } catch { /* offline -> still */ }
    }
    function startLoops() {
      stopLoops(false);
      S.pollTimer = setInterval(pollOnce, POLL_MS);
      const beat = async () => {
        if (!S.share || !S.joined) return;
        S.peers = presencePrune(S.peers);
        renderLiveBar(); renderCursors();
        await send(S.joined ? 'heartbeat' : 'hello', { wantSync: !S.isOwner }).catch(() => null);
      };
      beat();
      S.hbTimer = setInterval(beat, HEARTBEAT_MS);
    }
    function stopLoops(resetLast) {
      try { clearInterval(S.pollTimer); } catch { /* ignore */ }
      try { clearInterval(S.hbTimer); } catch { /* ignore */ }
      S.pollTimer = 0; S.hbTimer = 0;
      if (resetLast !== false) S.lastEventAt = null;
    }

    /* ----- Live-Buch (Gast) ----- */

    function ensureLiveBook(shareRow, snapshot) {
      const A = appGlobals();
      if (!A.state) throw new Error('App-State fehlt');
      const id = 'live-' + (shareRow.shareId || shareRow.$id);
      let b = (A.state.books || []).find(x => x && x.id === id);
      if (!b) {
        b = {
          id, title: '🔴 ' + (shareRow.title || 'Live'),
          kind: 'notebook', paper: 'grid-a4', updatedAt: Date.now(),
          folderId: null, pages: [{ id: (shareRow.pageId || 'p1'), strokes: [], texts: [], images: [], bg: null }],
          _liveShareId: (shareRow.shareId || shareRow.$id),
          _liveReadonly: normalizeMode(shareRow.mode) === 'read',
        };
        A.state.books.unshift(b);
      }
      b.title = '🔴 ' + (shareRow.title || 'Live');
      b._liveReadonly = normalizeMode(shareRow.mode) === 'read' && !S.isOwner;
      const page = b.pages[0];
      if (shareRow.pageId) page.id = shareRow.pageId;
      if (snapshot && (snapshot.strokes || snapshot.texts)) {
        applyPageSnapshot(page, snapshot);
      }
      try { if (A.persistSoon) A.persistSoon(); } catch { /* ignore */ }
      return b;
    }
    function removeLiveBook() {
      try {
        const A = appGlobals();
        if (!A.state || !S.share) return;
        const id = 'live-' + (S.share.shareId || S.share.$id);
        const ix = (A.state.books || []).findIndex(x => x && x.id === id);
        if (ix >= 0) {
          // Gast-Kopie ist Wegwerf-Sicht: nicht in Cloud syncen, einfach entfernen.
          A.state.books.splice(ix, 1);
          if (A.persistSoon) A.persistSoon();
          if (A.renderAll) A.renderAll();
        }
      } catch { /* ignore */ }
    }

    /* ----- UI: Status, Bar, Cursor, Dialog ----- */

    function el(id) { try { return document.getElementById(id); } catch { return null; } }
    function esc(s) {
      return String(s == null ? '' : s).replace(/[&<>"']/g, c => (
        { '&': '&amp;', '<': '&lt;', '>': '&gt;', '"': '&quot;', "'": '&#39;' }[c]));
    }
    function updateStatus() {
      const t = el('liveStatus');
      if (!t) return;
      if (!S.joined) { t.textContent = 'Liveshare: aus – über „🔴 Live“ starten.'; return; }
      const n = presenceList(S.peers).length + 1;
      t.textContent = '🔴 Live (' + n + ' online' + (S.wsOk ? ', realtime' : ', polling') + ')';
    }
    function renderLiveBar() {
      updateStatus();
      let bar = el('liveBar');
      if (!bar || !S.joined) { if (bar) bar.style.display = 'none'; return; }
      bar.style.display = 'flex';
      const peers = presenceList(S.peers);
      const dots = peers.map(p =>
        '<span class="live-avatar" title="' + esc(p.userName) + '" style="background:' + esc(p.userColor) + '">' +
        esc(String(p.userName || '?').slice(0, 1).toUpperCase()) + '</span>').join('');
      bar.innerHTML =
        '<span class="live-dot"></span><span>Live · ' + (peers.length + 1) + '</span>' +
        '<span class="live-avatars">' + dots +
        '<span class="live-avatar live-me" title="' + esc(S.me ? S.me.userName : 'ich') + '">ich</span></span>' +
        '<button class="mini-button" onclick="window.FederwerkLive.copyLink()" title="Share-Link kopieren">🔗</button>' +
        '<button class="mini-button" onclick="window.FederwerkLive.leave()" title="Live verlassen">✕</button>';
    }
    function renderCursors() {
      try {
        const peers = presenceList(S.peers);
        for (const idx of [0, 1]) {
          const stage = document.getElementById(idx === 0 ? 'stage' : 'stageB');
          if (!stage) continue;
          let layer = stage.querySelector(':scope > .live-cursors');
          if (!layer) {
            layer = document.createElement('div');
            layer.className = 'live-cursors';
            layer.setAttribute('aria-hidden', 'true');
            stage.appendChild(layer);
          }
          const myPage = currentPageId();
          const html = peers
            .filter(p => p.cursor && p.cursor.nx != null && (!p.cursor.pageId || p.cursor.pageId === myPage))
            .map(p => {
              const nx = Math.max(0, Math.min(1, Number(p.cursor.nx) || 0)) * 100;
              const ny = Math.max(0, Math.min(1, Number(p.cursor.ny) || 0)) * 100;
              return '<div class="live-cursor" style="left:' + nx + '%;top:' + ny + '%">' +
                '<div class="live-cursor-dot" style="background:' + esc(p.userColor) + '"></div>' +
                '<div class="live-cursor-name" style="background:' + esc(p.userColor) + '">' + esc(p.userName) + '</div></div>';
            }).join('');
          if (layer._html !== html) { layer.innerHTML = html; layer._html = html; }
        }
      } catch { /* ignore */ }
    }
    function openDialog(mode) {
      const ov = el('liveOverlay');
      if (!ov) return;
      ov.classList.add('active');
      const tabH = el('liveTabHost'), tabJ = el('liveTabJoin');
      const pH = el('liveHostPane'), pJ = el('liveJoinPane');
      const host = mode !== 'join';
      if (tabH) tabH.classList.toggle('picked', host);
      if (tabJ) tabJ.classList.toggle('picked', !host);
      if (pH) pH.style.display = host ? '' : 'none';
      if (pJ) pJ.style.display = host ? 'none' : '';
      if (host) fillHostPane(); else fillJoinPane('');
      updateStatus();
    }
    function closeDialog() {
      const ov = el('liveOverlay');
      if (ov) ov.classList.remove('active');
    }
    function fillHostPane() {
      try {
        const A = appGlobals();
        const sel = el('liveBookSel');
        if (sel && A.state) {
          const books = (A.state.books || []).filter(b => b && !String(b.id || '').startsWith('live-'));
          sel.innerHTML = books.map(b =>
            '<option value="' + esc(b.id) + '">' + esc(b.title || 'Unbenannt') + '</option>').join('');
          const cur = A.openBook ? A.openBook() : null;
          if (cur) sel.value = cur.id;
        }
        const link = el('liveLink');
        if (link) link.value = S.share ? encodeShareLink(location.origin, location.pathname, S.share.shareId || S.share.$id) : '';
        const meta = el('liveHostMeta');
        if (meta) {
          meta.textContent = S.share
            ? ('Aktiv: ' + (S.share.mode === 'edit' ? '✎ Edit' : '👁 Lesen') +
              (S.share.expiresAt ? ' · läuft ab ' + new Date(S.share.expiresAt).toLocaleString('de-DE') : ' · ohne Ablauf'))
            : 'Noch keine aktive Freigabe auf diesem Gerät.';
        }
      } catch { /* ignore */ }
    }
    function fillJoinPane(code) {
      const inp = el('liveCode');
      if (inp && code !== undefined) inp.value = code || '';
    }

    /* ----- Öffentliche Aktionen ----- */

    async function host() {
      const msg = el('liveMsg');
      const say = t => { if (msg) msg.textContent = t; };
      try {
        const A = appGlobals();
        S.me = await currentUser();
        const bookId = (el('liveBookSel') || {}).value || (A.openBook ? (A.openBook() || {}).id : null);
        if (!bookId) throw new Error('Kein Buch gewählt.');
        const book = (A.state.books || []).find(b => b && b.id === bookId);
        if (!book) throw new Error('Buch nicht gefunden.');
        const mode = normalizeMode((el('liveMode') || {}).value);
        const ttl = parseFloat((el('liveExpiry') || {}).value);
        const page = (A.currentPage && A.openBook && A.openBook() && A.openBook().id === bookId)
          ? A.currentPage()
          : (book.pages || [])[0];
        if (!page) throw new Error('Seite fehlt.');
        ensureStrokeIds(page.strokes || []);
        const snap = buildPageSnapshot(page);
        const code = makeShareCode();
        const body = shareRowBody({
          shareId: code, bookId: book.id, ownerId: S.me.userId,
          ownerName: S.me.userName, title: book.title || 'Geteilte Seite',
          mode, pageId: page.id, expiresAt: expiryIso(Number.isFinite(ttl) ? ttl : null),
          revoked: false, snapshot: snapshotFits(snap) ? snap : { pageId: page.id, strokes: [], texts: [], at: snap.at, truncated: true },
          createdAt: msToIso(nowMs()), updatedAt: msToIso(nowMs()),
        });
        say('Erstelle Freigabe …');
        const row = await createShareRow(body, S.me.userId);
        S.share = Object.assign({}, body, row, { shareId: code });
        S.isOwner = true;
        S.joined = true;
        S.peers = presenceNew();
        S.chunkStore = {};
        S.lastEventAt = null;
        startRealtime(); startLoops();
        const link = encodeShareLink(location.origin, location.pathname, code);
        const linkEl = el('liveLink');
        if (linkEl) linkEl.value = link;
        try { await navigator.clipboard.writeText(link); say('Link kopiert – teile ihn mit deinen Leuten.'); }
        catch { say('Freigabe aktiv – Link kopieren und teilen.'); }
        fillHostPane(); renderLiveBar();
        if (!snapshotFits(snap)) {
          // Großer Snapshot folgt per Chunk-Events für bereits Wartende.
          sendSnapshotTo();
        }
      } catch (e) {
        say('Fehler: ' + (e && e.message ? e.message : e));
        if (e && (e.status === 404 || /not found|unknown table/i.test(e.message || ''))) {
          say('Fehler: Tabellen `shares`/`share_events` fehlen in Appwrite – Setup siehe specs/36-liveshare.md.');
        }
      }
    }
    async function join(codeIn) {
      const msg = el('liveMsg');
      const say = t => { if (msg) msg.textContent = t; };
      try {
        const code = normalizeCode(codeIn != null ? codeIn : ((el('liveCode') || {}).value || ''));
        if (!code) throw new Error('Bitte einen gültigen Share-Code einfügen (z. B. aus dem Link).');
        S.me = await currentUser();
        say('Trete bei ' + code + ' …');
        const row = await getShareRow(code);
        const share = Object.assign({}, row, { shareId: code });
        const use = shareUsable(share, nowMs());
        if (!use.ok) throw new Error('Freigabe nicht nutzbar: ' + use.reason + '.');
        let snap = null;
        try { snap = JSON.parse(share.snapshot || '{}'); } catch { snap = null; }
        S.share = share;
        S.isOwner = share.ownerId === S.me.userId;
        S.joined = true;
        S.peers = presenceNew();
        S.chunkStore = {};
        S.lastEventAt = null;
        if (!S.isOwner) {
          const b = ensureLiveBook(share, snap && !snap.truncated ? snap : null);
          try {
            const A = appGlobals();
            if (A.openBookInPane) A.openBookInPane(b.id, 0);
            else if (A.renderAll) A.renderAll();
          } catch { /* ignore */ }
          if (!snap || snap.truncated) {
            // Vollbild beim Owner anfordern (Antwort kommt per Event).
            setTimeout(() => send('sync-request', { wantSync: true }).catch(() => null), 800);
          }
        } else {
          // Owner (z. B. Zweitgerät): Original suchen, sonst Live-Kopie wie Gast.
          try {
            const A = appGlobals();
            const orig = A.state && (A.state.books || []).find(x => x && x.id === share.bookId);
            if (!orig) {
              const b = ensureLiveBook(share, snap && !snap.truncated ? snap : null);
              if (A.openBookInPane) A.openBookInPane(b.id, 0);
              else if (A.renderAll) A.renderAll();
            }
          } catch { /* Wunschzustand, kein Muss */ }
          setTimeout(() => send('sync-request', { wantSync: true }).catch(() => null), 800);
        }
        startRealtime(); startLoops();
        say(S.isOwner ? 'Eigene Freigabe geöffnet.' : 'Beigetreten – Live-Seite ist da. ' + (normalizeMode(share.mode) === 'edit' ? 'Du darfst mitschreiben.' : 'Lesemodus: zuschauen.'));
        closeDialogSoon();
        renderLiveBar();
      } catch (e) {
        say('Fehler: ' + (e && e.message ? e.message : e));
      }
    }
    let closeT = 0;
    function closeDialogSoon() {
      try { clearTimeout(closeT); } catch { /* ignore */ }
      closeT = setTimeout(closeDialog, 900);
    }
    async function leave(removeGuestBook) {
      try { await send('bye', {}).catch(() => null); } catch { /* ignore */ }
      stopLoops(); stopRealtime();
      // Live-Kopie (live-<code>) ist reine Wegwerf-Sicht: auf jedem Gerät
      // entfernen – auf dem Owner-Hauptgerät existiert sie eh nicht (No-op).
      if (removeGuestBook !== false) removeLiveBook();
      S.share = null; S.isOwner = false; S.joined = false;
      S.peers = presenceNew(); S.chunkStore = {};
      renderLiveBar(); renderCursors(); updateStatus();
      fillHostPane();
    }
    async function revoke() {
      if (!S.share || !S.isOwner) return;
      const msg = el('liveMsg');
      try {
        const code = S.share.shareId || S.share.$id;
        await patchShareRow(code, { revoked: true, updatedAt: msToIso(nowMs()) });
        S.share.revoked = true;
        if (msg) msg.textContent = 'Freigabe zurückgezogen.';
        await leave(true).catch(() => null);
      } catch (e) { if (msg) msg.textContent = 'Fehler: ' + e.message; }
    }
    async function setMode(mode) {
      if (!S.share || !S.isOwner) return;
      const msg = el('liveMsg');
      try {
        const m = normalizeMode(mode != null ? mode : ((el('liveMode') || {}).value || 'read'));
        const code = S.share.shareId || S.share.$id;
        await patchShareRow(code, { mode: m, updatedAt: msToIso(nowMs()) });
        S.share.mode = m;
        if (msg) msg.textContent = 'Modus: ' + (m === 'edit' ? '✎ Edit' : '👁 Lesen') + '.';
        fillHostPane();
      } catch (e) { if (msg) msg.textContent = 'Fehler: ' + e.message; }
    }
    async function copyLink() {
      try {
        if (!S.share) return;
        const link = encodeShareLink(location.origin, location.pathname, S.share.shareId || S.share.$id);
        await navigator.clipboard.writeText(link);
        const msg = el('liveMsg');
        if (msg) msg.textContent = 'Link kopiert.';
      } catch { /* ignore */ }
    }

    /* ----- Lokale Hooks (ruft app.js auf) ----- */

    function emitLocalStroke(stroke) {
      if (!S.joined || !stroke) return;
      if (!canWrite((S.share && S.share.mode) || 'read', S.isOwner)) return;
      send('stroke-add', { stroke }).catch(() => null);
    }
    function emitLocalStrokeDeletes(ids) {
      if (!S.joined || !ids || !ids.length) return;
      if (!canWrite((S.share && S.share.mode) || 'read', S.isOwner)) return;
      send('stroke-del', { ids }).catch(() => null);
    }
    function emitLocalText(text) {
      if (!S.joined || !text) return;
      if (!canWrite((S.share && S.share.mode) || 'read', S.isOwner)) return;
      send('text-upsert', { text }).catch(() => null);
    }
    function isReadonlyGuest() {
      return S.joined && !S.isOwner && normalizeMode((S.share && S.share.mode) || 'read') === 'read';
    }
    function activeShare() { return S.joined ? S.share : null; }

    /* ----- Cursor-Sender (eigene Stage-Listener) ----- */

    function bindCursorSenders() {
      try {
        for (const [stageId] of [['stage'], ['stageB']]) {
          const st = document.getElementById(stageId);
          if (!st || st._liveBound) continue;
          st._liveBound = true;
          st.addEventListener('pointermove', (ev) => {
            try {
              if (!S.joined || !S.me) return;
              const now = Date.now();
              if (!shouldSendCursor(S.lastCursorSent, now)) return;
              S.lastCursorSent = now;
              const r = st.getBoundingClientRect();
              if (!r.width || !r.height) return;
              const nx = (ev.clientX - r.left) / r.width;
              const ny = (ev.clientY - r.top) / r.height;
              send('cursor', { nx, ny, pageId: currentPageId() }).catch(() => null);
            } catch { /* ignore */ }
          }, { passive: true });
        }
      } catch { /* ignore */ }
    }

    /* ----- Hash-Autojoin ----- */

    function checkHash() {
      try {
        const code = parseShareCodeFromHash(location.hash || '');
        if (code && !S.joined) {
          openDialog('join');
          fillJoinPane(code);
        }
      } catch { /* ignore */ }
    }

    const UI = {
      openDialog, closeDialog, host, join, leave, revoke, setMode, copyLink,
      emitLocalStroke, emitLocalStrokeDeletes, emitLocalText,
      isReadonlyGuest, activeShare,
      _state: S,
      _pollOnce: pollOnce,
      _handleRemoteRow: handleRemoteRow,
    };
    window.FederwerkLive = UI;
    document.addEventListener('DOMContentLoaded', () => {
      bindCursorSenders();
      setTimeout(bindCursorSenders, 2000);
      setTimeout(checkHash, 800);
    });
    window.addEventListener('hashchange', checkHash);
    window.addEventListener('beforeunload', () => {
      try {
        if (S.joined && S.share && S.me) {
          const c = cfg();
          const ev = buildEvent({
            shareId: S.share.shareId || S.share.$id,
            userId: S.me.userId, userName: S.me.userName, userColor: S.me.userColor,
            kind: 'bye', payload: {},
          });
          const b = eventRowBody(ev);
          navigator.sendBeacon && navigator.sendBeacon(
            c.endpoint + tablesPath(EVENT_TABLE),
            new Blob([JSON.stringify({ rowId: 'unique()', data: b.row, permissions: b.permissions })],
              { type: 'application/json' }));
        }
      } catch { /* ignore */ }
    });
  }

  if (typeof module !== 'undefined' && module.exports) module.exports = Live;
  else if (typeof window !== 'undefined') window.FederwerkLiveCore = Live;
})();
