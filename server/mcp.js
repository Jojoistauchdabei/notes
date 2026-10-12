'use strict';
/* Federwerk: MCP-Fachoperationen auf SQLite.
 *
 * Der JSON-RPC-Kern (mcpserver/index.js) kennt keine Datenbank. Er ruft
 * einfach die 24 Handler auf, die ihm als `deps` here injiziert werden, und
 * packt das Ergebnis als Tool-Antwort. Alles Fachliche - Envelope, SM-2,
 * Suche, Wikilink-Graph - liegt in mcpserver/content.js und wird hier nur
 * gegen die SQLite-Schicht gestellt.
 *
 * ---- Warum userId NICHT als Argument durchgereicht wird ----
 *
 * Der Kern ruft z. B. `listDocuments(limit, folderId, opts)` und
 * `getDocument(id, opts)`. Ein userId-Parameter steht in KEINER dieser
 * Signaturen - der Kern ist absichtlich nutzerblind. Das ist auch richtig:
 * er darf keine Identitaetsentscheidung treffen, sonst muesste er Session-
 * und Rechtepruefung selbst kennen.
 *
 * Also bindet `createMcpDeps()` den Nutzer einmalig ueber die Schliessung.
 * Der Aufrufer (server/index.js) erzeugt die deps pro Anfrage neu, nachdem
 * er das Session-Cookie aufgeloest hat - damit gilt jeder Aufruf genau der
 * Identitaet, die zur HTTP-Anfrage gehoerte. Anders als die alte
 * Appwrite-Funktion gibt es damit kein `APPWRITE_USER_ID` mehr, das man
 * setzen und damit versehentlich einen fremden Datenbestand oeffnen koennte.
 *
 * ---- Was hier nicht liegt ----
 *
 * * Datei-Anhaenge. Die liegen im Dateisystem (server/files.js) und werden
 *   nur als Referenz-Hash im Dokument-JSON gefuehrt. Ein Schreibvorgang
 *   ueber den MCP aendert daran nichts - genau wie beim Editor.
 * * Freigaben/Liveshare. Die sind per Definition nutzeruebergreifend und
 *   liegen in social.db (server/shares.js). Kein der 24 Tools fasst sie an;
 *   sie bleiben bewusst ausserhalb dieses Moduls.
 */

const C = require('../mcpserver/content');
const db = require('./db.js');
const docsApi = require('./docs.js');

// Wie viele Dokumente ein Schreibvorgang bei einem Ordnerloeschen maximal
// umhaengt. Unbounded waere hier eine Denial-of-Service-Klammer: ein Ordner
// mit 50 000 Notizen wuerde einen einzelnen MCP-Aufruf blockieren.
const MAX_FOLDER_MOVE = 100;

/* ---------- Adapter zwischen SQLite-Zeile und MCP-Form ---------- */

// docFromRow() erwartet Appwrite-Feldnamen ($id/folderId/updatedAt). SQLite
// nutzt snake_case und Zeitstempel in Millisekunden. Der Adapter haelt diese
// eine Stelle zusammen, statt in jedem Handler zwei Namen umzubenennen.
function toMcpRow(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title || '',
    folderId: r.folder_id || null,
    content: r.content || '',
    createdAt: r.created_at ? new Date(r.created_at).toISOString() : null,
    updatedAt: r.updated_at ? new Date(r.updated_at).toISOString() : null,
  };
}

function live(row) {
  // deleted_at ist das Tombstone der App. '(gelöscht)' ist der Titel, den
  // aeltere Clients als Loeschsignal schrieben - beides wird respektiert,
  // damit ein aus einer alten Installation gewandertes Dokument nicht
  // plötzlich wieder auftaucht.
  return !!row && !row.deleted_at && row.title !== '(gelöscht)';
}

function requireUser(state) {
  if (!state.userId) throw new Error('Nicht angemeldet: keine Session fuer diesen MCP-Aufruf.');
  return state.userId;
}

function notFound(what) {
  const e = new Error(what || 'Document not found');
  e.status = 404;
  return e;
}

/* ---------- Lesezugriffe auf die Nutzer-DB ---------- */

function allRows(userId) {
  return db.docs(userId).prepare(
    'SELECT id, title, folder_id, content, created_at, updated_at, deleted_at FROM docs'
  ).all();
}

function liveRows(userId) {
  return allRows(userId).filter(live);
}

function getRow(userId, id) {
  return db.docs(userId).prepare(
    'SELECT id, title, folder_id, content, created_at, updated_at, deleted_at FROM docs WHERE id = ?'
  ).get(String(id));
}

/* Dokumente mit dekodiertem Envelope. Suche und Graph brauchen den Markdown
 * bzw. die Wikilinks - die stehen nicht in der Spalte, sondern erst im
 * Seiten-Envelope. Einmal pro Aufruf geladen, nicht pro Kandidat. */
function fullDocs(userId) {
  const docs = [];
  for (const row of liveRows(userId)) {
    try {
      const d = C.docFromRow(toMcpRow(row));
      // Die App-Suche sieht den vollen Text; fuer MCP reicht eine harte
      // Obergrenze, sonst schleppt ein 2-MB-Dokument durch jeden Aufruf.
      d.markdown = (d.markdown || '').slice(0, 20000);
      docs.push(d);
    } catch { /* unlesbares Envelope ueberspringen, nicht die Suche killen */ }
  }
  return docs;
}

/* Row -> Arbeitskopie. Alles Schreibende arbeitet auf `parts` und schreibt
 * ueber saveDocParts() zurueck - damit gibt es genau einen Codepfad von
 * Seite/Decks hin zur Zeile und keine veralteten Zwischenstaende. */
function loadDocParts(userId, id) {
  const row = getRow(userId, id);
  if (!row) throw notFound('Document not found');
  if (!live(row)) throw newFoundDeleted();
  const dec = C.decodeContent(row.content || '');
  return {
    row,
    parts: {
      title: row.title || '',
      folderId: row.folder_id || null,
      pages: dec.pages,
      kind: dec.kind,
      cards: dec.cards.map((c) => C.normalizeCard(c)),
      deckOptions: C.normalizeDeckOptions(dec.deckOptions),
      reviewLog: C.normalizeReviewLog(dec.reviewLog),
      createdAt: row.created_at,
    },
  };
}

function notFoundDeleted() {
  const e = new Error('Document has been deleted');
  e.status = 404;
  return e;
}

function saveDocParts(userId, rowId, parts) {
  const content = C.encodeContent({
    pages: parts.pages || [],
    kind: parts.kind,
    cards: parts.cards,
    deckOptions: parts.deckOptions,
    reviewLog: parts.reviewLog,
  });
  C.checkContentBytes(content);
  // docs.js kappt den Titel, aktualisiert den GC-Referenzindex und schuetzt
  // per Last-Write-Wins vor aelteren Geraete-Pushes. Wir geben die Zeit
  // bewusst mit: ohne sie waere der Push ein "unbekanntes Alter" und
  // koennte stillschweigend verworfen werden.
  const now = Date.now();
  return docsApi.upsert(userId, {
    id: rowId,
    title: parts.title,
    folderId: parts.folderId,
    content,
    updatedAt: now,
  });
}

function newDocId() {
  // Gleiche ID-Regel wie vorher Appwrite (^[a-zA-Z0-9][a-zA-Z0-9._-]{0,35}$),
  // damit alte Links und mitgeschleppte IDs nicht brechen.
  return C.rowIdFor(C.newId('n'), 'b');
}

function ensureFolder(userId, folderId) {
  if (!folderId) return null;
  const fid = String(folderId).trim();
  if (!fid) return null;
  const d = db.docs(userId);
  const row = d.prepare('SELECT id, deleted_at FROM folders WHERE id = ?').get(fid);
  if (!row || !live(row)) throw notFound('Folder not found');
  return row;
}

/* ---------- Fabrik ---------- */

/**
 * Liefert die 24 Handler fuer createMcpHandler(deps).
 *
 * @param {object}  [opts]
 * @param {string}  [opts.userId]        Aus der HTTP-Session aufgeloeste Nutzer-ID.
 * @param {string}  [opts.email]         Nur Anzeigezweck.
 * @param {string}  [opts.sessionToken]  Token, das der MCP selbst verwaltet.
 * @param {object}  [opts.credentials]   {email, password} fuer das login-Tool.
 */
function createMcpDeps(opts = {}) {
  // Bewusst veränderlich: nur login/logout schreiben hier hinein. Alle
  // Datenoperationen lesen requireUser(state) - das schlägt fehl, statt
  // auf ein undefined-Handle zuzugreifen.
  const state = {
    userId: opts.userId ? String(opts.userId) : '',
    email: opts.email ? String(opts.email) : '',
    sessionToken: opts.sessionToken ? String(opts.sessionToken) : '',
    ownedSession: !!opts.ownedSession,
  };

  const sessionInfo = (extra = {}) => ({
    authenticated: !!state.userId,
    ownedByMcp: state.ownedSession,
    userId: state.userId,
    email: state.email,
    expiresAt: null,
    backend: 'sqlite',
    note: 'Die Identitaet kommt aus der HTTP-Session des Servers, nicht aus einer Appwrite-Session.',
    ...extra,
  });

  return {
    /* ---------- Sitzung ---------- */

    sessionInfo: async () => sessionInfo(),

    // Ein Anmeldewerkzeug gibt es hier bewusst nur fuer den Sonderfall, dass
    // jemand den MCP ueber stdio ohne Server-Session benutzt. Im regulaeren
    // HTTP-Betrieb ist die Identitaet schon gesetzt - und eine zusaetzliche
    // Session wuerde nur eine zweite Sitzung desselben Nutzers erzeugen.
    login: async () => {
      const c = opts.credentials;
      if (!c || !c.email || !c.password) {
        return sessionInfo({ loggedIn: false, note: 'Keine Zugangsdaten hinterlegt. Im Serverbetrieb wird die Session vom Client mitgeschickt; createMcpDeps({userId}) genuegt.' });
      }
      const auth = require('./auth.js');
      const s = auth.login(c.email, c.password, 'mcp');
      state.userId = s.user.id;
      state.email = s.user.email || '';
      state.sessionToken = s.token;
      state.ownedSession = true;
      return sessionInfo({ loggedIn: true, token: s.token });
    },

    logout: async () => {
      if (!state.sessionToken) return sessionInfo({ loggedOut: false, note: 'Keine Session aktiv' });
      if (!state.ownedSession) {
        return sessionInfo({
          loggedOut: false,
          note: 'Session gehoert nicht dem MCP (vom Server durchgereicht) - nicht geloescht, damit die App angemeldet bleibt.',
        });
      }
      require('./auth.js').logout(state.sessionToken);
      const was = state.userId;
      state.sessionToken = '';
      state.ownedSession = false;
      state.userId = '';
      state.email = '';
      return sessionInfo({ loggedOut: true, previousUserId: was });
    },

    /* ---------- Lesen ---------- */

    listDocuments: async (limit = 100, folderId = null, o = {}) => {
      const userId = requireUser(state);
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      const target = folderId || (o && o.folderId);
      const kind = o && o.kind;
      let list = liveRows(userId);
      if (target) list = list.filter((r) => r.folder_id === String(target));
      // Der Typ steckt im Envelope, nicht in einer Spalte - deshalb hier
      // dekodieren statt per SQL filtern.
      if (kind === 'notebook' || kind === 'flashcards') {
        list = list.filter((r) => C.decodeContent(r.content || '').kind === kind);
      }
      // Aufsteigend nach Aktualitaet, wie es die App auch sortiert: das
      // aelteste zuerst laesst sich vom Modell leichter "abarbeiten".
      list.sort((a, b) => (a.updated_at - b.updated_at) || String(a.id).localeCompare(String(b.id)));
      return list.slice(0, max).map((r) => C.docFromRow(toMcpRow(r), { includeContent: false }));
    },

    getDocument: async (id) => {
      const userId = requireUser(state);
      const { row } = loadDocParts(userId, id);
      // Volle Karten nur hier - Liste und Suche bleiben schlank.
      return C.docFromRow(toMcpRow(row), { cardsLimit: 200 });
    },

    listFolders: async () => {
      const userId = requireUser(state);
      return db.docs(userId)
        .prepare('SELECT id, name, parent_id, created_at, updated_at, deleted_at FROM folders ORDER BY updated_at ASC, id ASC')
        .all().filter(live).map(docsApi.rowToFolder);
    },

    searchDocuments: async (text, limit = 100) => {
      const userId = requireUser(state);
      const needle = String(text || '').trim().toLowerCase();
      if (!needle) return [];
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      const out = [];
      // Der Content liegt als HTML in Seiten-Textboxen. Ein SQL-LIKE auf die
      // JSON-Spalte fände "Wort" nicht, wenn der Editor es als <b>Wort</b>
      // gespeichert hat - deshalb erst dekodieren, dann vergleichen.
      for (const row of liveRows(userId)) {
        const dec = C.decodeContent(row.content || '');
        const md = C.pagesToMarkdown(dec.pages);
        const hay = [
          String(row.title || ''),
          md,
          ...dec.cards.map((c) => `${C.stripTagsLite(c.front)} ${C.stripTagsLite(c.back)}`),
        ].join('\n').toLowerCase();
        if (!hay.includes(needle)) continue;
        out.push({
          id: row.id,
          title: row.title || 'Unbenannt',
          snippet: C.snippetFor(md.replace(/\s+/g, ' ') || String(row.title || ''), [needle]),
          updatedAt: row.updated_at ? new Date(row.updated_at).toISOString() : null,
        });
        if (out.length >= max) break;
      }
      return out;
    },

    advancedSearch: async (text, limit) => {
      const userId = requireUser(state);
      const q = String(text || '').trim();
      if (!q) return [];
      return C.advancedSearchDocs(fullDocs(userId), q, limit);
    },

    getGraph: async (id, depth) => {
      const userId = requireUser(state);
      const graph = C.buildGraph(fullDocs(userId));
      if (!id) return graph;
      if (!graph.nodes.some((n) => n.id === id)) throw notFound('Document not found');
      return C.localGraph(graph, id, depth == null ? 1 : depth);
    },

    /* ---------- Notizen schreiben ---------- */

    createDocument: async (input = {}) => {
      const userId = requireUser(state);
      C.checkTitle(input.title);
      ensureFolder(userId, input.folderId);
      const kind = input.kind === 'flashcards' ? 'flashcards' : 'notebook';
      const rowId = newDocId();
      saveDocParts(userId, rowId, {
        title: C.normTitle(input.title),
        folderId: input.folderId ? String(input.folderId) : null,
        pages: C.contentToPages(input.content || '', input.contentFormat || 'markdown'),
        kind,
        cards: [],
        deckOptions: C.normalizeDeckOptions(null),
        reviewLog: [],
        createdAt: Date.now(),
      });
      const { row } = loadDocParts(userId, rowId);
      return C.docFromRow(toMcpRow(row));
    },

    updateDocument: async (id, input = {}) => {
      const userId = requireUser(state);
      const { parts } = loadDocParts(userId, id);
      if (input.title !== undefined) {
        C.checkTitle(input.title);
        parts.title = C.normTitle(input.title);
      }
      if (input.folderId !== undefined) {
        const fid = String(input.folderId || '').trim();
        ensureFolder(userId, fid || null);
        parts.folderId = fid || null;
      }
      if (input.content !== undefined) {
        const pages = C.contentToPages(input.content || '', input.contentFormat || 'markdown');
        if (input.append) {
          // Anhaengen statt ersetzen: ein neues Textfeld auf der letzten
          // Seite, damit der bisherige Inhalt im Editor sichtbar bleibt.
          const html = pages.length && pages[0].texts.length ? pages[0].texts[0].html : '';
          if (!parts.pages.length) parts.pages = [C.blankPage()];
          const last = parts.pages[parts.pages.length - 1];
          last.texts = Array.isArray(last.texts) ? last.texts : [];
          last.texts.push({ id: C.newId('t'), x: 0.08, y: 0.05, html: html || '<p></p>' });
        } else {
          parts.pages = pages;
        }
      }
      saveDocParts(userId, id, parts);
      const { row } = loadDocParts(userId, id);
      return C.docFromRow(toMcpRow(row));
    },

    deleteDocument: async (id, input = {}) => {
      const userId = requireUser(state);
      loadDocParts(userId, id); // Existenzpruefung: fremd/geloescht -> 404
      const d = db.docs(userId);
      const sid = String(id);
      if (input && input.permanent) {
        d.prepare('DELETE FROM file_refs WHERE doc_id = ?').run(sid);
        d.prepare('DELETE FROM docs WHERE id = ?').run(sid);
        return { id: sid, deleted: true, permanent: true };
      }
      // Tombstone statt DELETE: genau so loescht der App-Sync, damit ein
      // offline geraet die Notiz nicht beim naechsten Push wiederbringt.
      const now = Date.now();
      d.prepare("UPDATE docs SET title = '(gelöscht)', content = '', folder_id = NULL, deleted_at = ?, updated_at = ? WHERE id = ?")
        .run(now, now, sid);
      d.prepare('DELETE FROM file_refs WHERE doc_id = ?').run(sid);
      return { id: sid, deleted: true, permanent: false, deletedAt: new Date(now).toISOString() };
    },

    duplicateDocument: async (id, input = {}) => {
      const userId = requireUser(state);
      const { parts } = loadDocParts(userId, id);
      if (input && input.title !== undefined) C.checkTitle(input.title);
      const rowId = newDocId();
      const title = input && input.title ? C.normTitle(input.title) : `${parts.title} (Kopie)`;
      saveDocParts(userId, rowId, {
        ...parts,
        title,
        // Karten-IDs neu vergeben: sonst teilen sich Original und Kopie
        // dieselben IDs und die Review-Zuordnung laeuft auf die falsche Karte.
        cards: parts.cards.map((c) => ({ ...C.normalizeCard(c), id: C.newId('c') })),
        createdAt: Date.now(),
      });
      const { row } = loadDocParts(userId, rowId);
      return C.docFromRow(toMcpRow(row));
    },

    moveDocument: async (id, folderId) => {
      const userId = requireUser(state);
      const { parts } = loadDocParts(userId, id);
      const fid = String(folderId || '').trim();
      ensureFolder(userId, fid || null);
      parts.folderId = fid || null;
      saveDocParts(userId, id, parts);
      const { row } = loadDocParts(userId, id);
      return C.docFromRow(toMcpRow(row));
    },

    /* ---------- Ordner ---------- */

    createFolder: async (input = {}) => {
      const userId = requireUser(state);
      const name = String(input.name || '').trim().slice(0, 60);
      if (!name) throw new Error('name ist erforderlich');
      const parentId = input.parentId ? String(input.parentId) : null;
      if (parentId) ensureFolder(userId, parentId);
      const id = C.rowIdFor(C.newId('f'), 'f');
      docsApi.upsertFolder(userId, { id, name, parentId, updatedAt: Date.now() });
      return { id, name, parentId };
    },

    renameFolder: async (id, name) => {
      const userId = requireUser(state);
      const clean = String(name || '').trim().slice(0, 60);
      if (!clean) throw new Error('name ist erforderlich');
      const row = db.docs(userId).prepare('SELECT * FROM folders WHERE id = ?').get(String(id));
      if (!row || !live(row)) throw notFound('Folder not found');
      const f = docsApi.upsertFolder(userId, {
        id: String(id), name: clean, parentId: row.parent_id, updatedAt: Date.now(),
      });
      return { id: f.id, name: f.name, parentId: f.parentId };
    },

    deleteFolder: async (id, input = {}) => {
      const userId = requireUser(state);
      const d = db.docs(userId);
      const sid = String(id);
      const row = d.prepare('SELECT * FROM folders WHERE id = ?').get(sid);
      if (!row || !live(row)) throw notFound('Folder not found');
      const target = input && input.moveDocumentsTo ? String(input.moveDocumentsTo) : '';
      if (target) ensureFolder(userId, target);
      const victims = liveRows(userId).filter((r) => r.folder_id === sid).slice(0, MAX_FOLDER_MOVE);
      const now = Date.now();
      const move = d.prepare('UPDATE docs SET folder_id = ?, updated_at = ? WHERE id = ?');
      for (const v of victims) move.run(target || null, now, v.id);
      // Hart geloescht, wie vorher in Appwrite: der Ordner ist ein reines
      // Sortiermerkmal, ein Tombstone wuerde nur den "nicht mehr da"-Zustand
      // konservieren und beim naechsten Push wieder auftauchen.
      d.prepare('DELETE FROM folders WHERE id = ?').run(sid);
      return { id: sid, deleted: true, documentsMoved: victims.length, moveDocumentsTo: target || null };
    },

    /* ---------- Karteikarten (SM-2) ---------- */

    createDeck: async (input = {}) => {
      const userId = requireUser(state);
      C.checkTitle(input.title);
      ensureFolder(userId, input.folderId);
      const cards = C.checkCards(input.cards || [], false);
      const rowId = newDocId();
      saveDocParts(userId, rowId, {
        title: C.normTitle(input.title),
        folderId: input.folderId ? String(input.folderId) : null,
        pages: [C.blankPage()],
        kind: 'flashcards',
        cards,
        deckOptions: C.normalizeDeckOptions(null),
        reviewLog: [],
        createdAt: Date.now(),
      });
      const { row } = loadDocParts(userId, rowId);
      return C.docFromRow(toMcpRow(row), { cardsLimit: 200 });
    },

    listCards: async (deckId, filter, limit) => {
      const userId = requireUser(state);
      const { parts } = loadDocParts(userId, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const t = C.nowMs();
      const max = Math.min(Math.max(Number(limit) || 100, 1), 100);
      let list = parts.cards;
      if (filter === 'due') list = list.filter((c) => C.isDue(c, t));
      else if (filter === 'new') list = list.filter((c) => !c.lastReview && !c.suspended);
      return list.slice(0, max);
    },

    addCards: async (deckId, cards) => {
      const userId = requireUser(state);
      const fresh = C.checkCards(cards, true);
      const { parts } = loadDocParts(userId, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      parts.cards.push(...fresh);
      saveDocParts(userId, deckId, parts);
      return fresh;
    },

    updateCard: async (deckId, cardId, input = {}) => {
      const userId = requireUser(state);
      const { parts } = loadDocParts(userId, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const card = parts.cards.find((c) => c.id === cardId);
      if (!card) throw notFound('Card not found');
      if (input.front !== undefined) card.front = String(input.front);
      if (input.back !== undefined) card.back = String(input.back);
      if (input.suspended !== undefined) card.suspended = !!input.suspended;
      card.updatedAt = C.nowMs();
      C.normalizeCard(card);
      saveDocParts(userId, deckId, parts);
      return card;
    },

    deleteCard: async (deckId, cardId) => {
      const userId = requireUser(state);
      const { parts } = loadDocParts(userId, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const ix = parts.cards.findIndex((c) => c.id === cardId);
      if (ix < 0) throw notFound('Card not found');
      parts.cards.splice(ix, 1);
      saveDocParts(userId, deckId, parts);
      return { deckId, cardId, deleted: true };
    },

    reviewCard: async (deckId, cardId, grade) => {
      const userId = requireUser(state);
      const { parts } = loadDocParts(userId, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      const card = parts.cards.find((c) => c.id === cardId);
      if (!card) throw notFound('Card not found');
      const g = C.normalizeGrade(grade);
      if (!g) throw new Error('grade muss again|hard|good|easy sein');
      C.gradeCardInPlace(card, g);
      // Verlauf anhaengen, nicht ersetzen: er ist die einzige Quelle fuer
      // den Streak in den Deck-Statistiken.
      parts.reviewLog = C.normalizeReviewLog([...parts.reviewLog, { t: C.nowMs(), g, id: cardId }]);
      saveDocParts(userId, deckId, parts);
      return { card, preview: C.previewIntervals(card) };
    },

    deckStats: async (deckId) => {
      const userId = requireUser(state);
      const { parts } = loadDocParts(userId, deckId);
      if (parts.kind !== 'flashcards') throw new Error('Document is not a deck');
      return { deckId, ...C.deckStats(parts.cards, parts.reviewLog) };
    },
  };
}

module.exports = createMcpDeps;
module.exports.createMcpDeps = createMcpDeps;
