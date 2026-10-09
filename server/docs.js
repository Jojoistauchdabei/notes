'use strict';
/* Federwerk: Dokumente und Ordner.
 *
 * Bewusst EINE Tabelle docs fuer alles, was der Client je ein Buch nennt -
 * Notizbuch, Karteikarten-Deck, Office-Dokument. Das entspricht dem
 * bestehenden Datenmodell (SPEC-40: ein Office-Dokument ist ein Buch mit
 * einem zusaetzlichen Feld, kein eigener Bestand) und haelt Ordner, Suche,
 * Verschieben und Sync bei genau einem Pfad.
 */

const db = require('./db.js');
const files = require('./files.js');

const MAX_CONTENT = 8 * 1024 * 1024; // 8 MB Dokument-JSON

function bad(msg) { const e = new Error(msg); e.status = 400; return e; }

function validId(id) {
  const s = String(id || '');
  if (!s || s.length > 64) throw bad('Ungültige ID.');
  if (!/^[A-Za-z0-9_.:-]+$/.test(s)) throw bad('Ungültige ID.');
  return s;
}

function rowToDoc(r) {
  if (!r) return null;
  return {
    id: r.id,
    title: r.title || '',
    folderId: r.folder_id || null,
    content: r.content || '',
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at || null,
  };
}

function rowToFolder(r) {
  if (!r) return null;
  return {
    id: r.id,
    name: r.name || '',
    parentId: r.parent_id || null,
    createdAt: r.created_at,
    updatedAt: r.updated_at,
    deletedAt: r.deleted_at || null,
  };
}

/* Dokumente seit einem Zeitpunkt, nach Aktualitaet sortiert. Der Client
 * zieht seinen Delta-Pull ueber genau diese Grenze; ohne Index waere das
 * ein Tabellenscan pro Sync. */
function since(userId, sinceMs, kind, limit) {
  const d = db.docs(userId);
  const lim = Math.min(Math.max(Number(limit) || 200, 1), 1000);
  if (kind === 'folder') {
    return d.prepare('SELECT * FROM folders WHERE updated_at > ? ORDER BY updated_at ASC, id ASC LIMIT ?')
      .all(Number(sinceMs) || 0, lim).map(rowToFolder);
  }
  return d.prepare('SELECT * FROM docs WHERE updated_at > ? ORDER BY updated_at ASC, id ASC LIMIT ?')
    .all(Number(sinceMs) || 0, lim).map(rowToDoc);
}

function get(userId, id) {
  return rowToDoc(db.docs(userId).prepare('SELECT * FROM docs WHERE id = ?').get(validId(id)));
}

function upsert(userId, input) {
  const d = db.docs(userId);
  const id = validId(input && input.id);
  const content = String((input && input.content) || '');
  if (Buffer.byteLength(content, 'utf8') > MAX_CONTENT) {
    const e = new Error(`Dokument zu gross (max. ${MAX_CONTENT} Bytes). Groessere Inhalte bitte als Datei ablegen.`);
    e.status = 413;
    throw e;
  }
  const now = Number((input && input.updatedAt)) || Date.now();
  const prev = d.prepare('SELECT created_at, updated_at FROM docs WHERE id = ?').get(id);

  // Last-Write-Wins auf updated_at - und zwar VOLLSTAENDIG oder gar nicht.
  //
  // Ein aelterer eingehender Stand darf keinen neueren Inhalt ueberschreiben.
  // Das ist nicht theoretisch: zwei Geraete, von denen eines offline war,
  // pushen beide. Wenn hier nur updated_at per max() geschuetzt wuerde und
  // title/content trotzdem ueberschrieben, stuende am Ende ein Dokument mit
  // NEUERER Zeit und AELTEREM Inhalt da - genau die Sorte Zustand, die man
  // Wochen spaeter nicht mehr erklaeren kann.
  if (prev && input && input.updatedAt && Number(input.updatedAt) < prev.updated_at) {
    return get(userId, id);
  }

  d.prepare(
    `INSERT INTO docs (id, title, folder_id, content, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       title      = excluded.title,
       folder_id  = excluded.folder_id,
       content    = excluded.content,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`
  ).run(
    id,
    String((input && input.title) || '').slice(0, 500),
    input && input.folderId ? validId(input.folderId) : null,
    content,
    prev ? prev.created_at : now,
    now,
    input && input.deletedAt ? Number(input.deletedAt) || now : null
  );

  // Referenzindex mitziehen. Ohne das wuesste gc.js nicht, welche Datei noch
  // gebraucht wird, und wuerde bei leerem Index alles als verwaist melden.
  const refs = files.hashesFromContent(content);
  if (refs.length || prev) files.setRefs(userId, id, refs);

  return get(userId, id);
}

function remove(userId, id) {
  const d = db.docs(userId);
  const vid = validId(id);
  const row = d.prepare('SELECT created_at FROM docs WHERE id = ?').get(vid);
  const now = Date.now();
  if (!row) {
    d.prepare('INSERT INTO docs (id, title, folder_id, content, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?,?)')
      .run(vid, '', null, '', now, now, now);
  } else {
    d.prepare('UPDATE docs SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, vid);
  }
  // Hard delete: alle Referenzen des Dokuments weg. Die Dateien selbst bleiben
  // liegen und werden vom GC bewertet - sie koennen noch in anderen Dokumenten
  // stecken, und das entscheidet der Index, nicht das Loeschen.
  d.prepare('DELETE FROM file_refs WHERE doc_id = ?').run(vid);
  return { id: vid, deletedAt: now };
}

function upsertFolder(userId, input) {
  const d = db.docs(userId);
  const id = validId(input && input.id);
  const now = Number(input && input.updatedAt) || Date.now();
  const prev = d.prepare('SELECT created_at, updated_at FROM folders WHERE id = ?').get(id);

  // Dieselbe Regel wie bei Dokumenten. Ein aelterer Push darf den neueren
  // Ordnernamen nicht ueberschreiben - sonst stuende am Ende ein Ordner mit
  // NEUERER Zeit und AELTEREM Namen da.
  if (prev && input && input.updatedAt && Number(input.updatedAt) < prev.updated_at) {
    return rowToFolder(prev);
  }

  d.prepare(
    `INSERT INTO folders (id, name, parent_id, created_at, updated_at, deleted_at)
     VALUES (?,?,?,?,?,?)
     ON CONFLICT(id) DO UPDATE SET
       name       = excluded.name,
       parent_id  = excluded.parent_id,
       updated_at = excluded.updated_at,
       deleted_at = excluded.deleted_at`
  ).run(id, String((input && input.name) || '').slice(0, 300),
        input && input.parentId ? validId(input.parentId) : null,
        prev ? prev.created_at : now, now,
        input && input.deletedAt ? Number(input.deletedAt) || now : null);
  return rowToFolder(d.prepare('SELECT * FROM folders WHERE id = ?').get(id));
}

function removeFolder(userId, id) {
  const d = db.docs(userId);
  const vid = validId(id);
  const now = Date.now();
  const prev = d.prepare('SELECT created_at FROM folders WHERE id = ?').get(vid);
  if (!prev) {
    d.prepare('INSERT INTO folders (id, name, parent_id, created_at, updated_at, deleted_at) VALUES (?,?,?,?,?,?)')
      .run(vid, '', null, now, now, now);
  } else {
    d.prepare('UPDATE folders SET deleted_at = ?, updated_at = ? WHERE id = ?').run(now, now, vid);
  }
  return { id: vid, deletedAt: now };
}

function allFolders(userId) {
  return db.docs(userId).prepare('SELECT * FROM folders ORDER BY updated_at ASC, id ASC').all().map(rowToFolder);
}

module.exports = { since, get, upsert, remove, upsertFolder, removeFolder, allFolders, rowToDoc, rowToFolder, MAX_CONTENT };