/** Offline-Sync: SQLite <-> shared Backend (PocketBase), op-basierte Sync-Queue. */

import { createNote, deleteNote, listNotes, updateNote } from './pocketbase';
import { query, run } from './sqlite';
import type { PkNoteDraft, SyncResult } from './types';

export async function enqueueNote(note: PkNoteDraft): Promise<void> {
  const payload = JSON.stringify({
    title: note.title,
    starred: note.starred,
    image_data: note.image_data,
  });
  await run(
    `INSERT INTO notes (id, title, created, updated, starred, image_data, synced)
     VALUES (?, ?, ?, ?, ?, ?, 0)
     ON CONFLICT(id) DO UPDATE SET
       title=excluded.title, updated=excluded.updated,
       starred=excluded.starred, image_data=excluded.image_data`,
    [note.id, note.title, note.created, note.updated, note.starred ? 1 : 0, note.image_data],
  );
  await run(
    `INSERT INTO sync_queue (op, note_id, payload) VALUES (?, ?, ?)`,
    ['create', note.id, payload],
  );
}

export async function enqueueNoteUpdate(id: string, note: Partial<Pick<PkNoteDraft, 'title' | 'starred'>>): Promise<void> {
  const payload = JSON.stringify(note);
  await run(
    `INSERT INTO sync_queue (op, note_id, payload) VALUES (?, ?, ?)`,
    ['update', id, payload],
  );
}

export async function enqueueNoteDelete(id: string): Promise<void> {
  await run(`INSERT INTO sync_queue (op, note_id) VALUES (?, ?)`, ['delete', id]);
}

/** Bestehende lokale Notizen alle einmal auf das Backend hochladen. */
export async function syncNow(): Promise<SyncResult> {
  const result: SyncResult = { ok: true, uploaded: 0, deleted: 0 };

  const ops = await query<{ id: number; op: string; note_id: string; payload: string | null }>(
    'SELECT id, op, note_id, payload FROM sync_queue ORDER BY id',
  );

  for (const op of ops) {
    try {
      if (op.op === 'create') {
        const payload = op.payload ? JSON.parse(op.payload) : {};
        await createNote(payload);
        result.uploaded++;
      } else if (op.op === 'update') {
        const payload = op.payload ? JSON.parse(op.payload) : {};
        await updateNote(op.note_id, payload);
        result.uploaded++;
      } else if (op.op === 'delete') {
        try {
          await deleteNote(op.note_id);
        } catch {
          // Bereits auf dem Backend – weiter so.
        }
        await run('DELETE FROM notes WHERE id = ?', [op.note_id]);
        result.deleted++;
      }
      await run('DELETE FROM sync_queue WHERE id = ?', [op.id]);
    } catch (error) {
      result.ok = false;
      result.error = error instanceof Error ? error.message : String(error);
      break;
    }
  }

  return result;
}

/** Optional: Notizen vom Backend in SQLite holen (unterstützt, falls gewünscht). */
export async function pullNotes(): Promise<number> {
  const { items } = await listNotes(50);
  let n = 0;
  for (const item of items) {
    if (!item.id) continue;
    await run(
      `INSERT INTO notes (id, title, created, updated, starred, synced)
       VALUES (?, ?, ?, ?, ?, 1)
       ON CONFLICT(id) DO UPDATE SET title=excluded.title, updated=excluded.updated, starred=excluded.starred, synced=1`,
      [item.id, item.title ?? '', item.created ?? '', item.updated ?? '', item.starred ? 1 : 0],
    );
    n++;
  }
  return n;
}
