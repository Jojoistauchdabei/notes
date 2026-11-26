/** Minimaler PocketBase-Client – shared Backend: https://federwerk.ponnet.org */

import Constants from 'expo-constants';
import type { PbNote } from './types';

export const PB_URL: string =
  (Constants.expoConfig?.extra?.PB_URL as string) ?? 'https://federwerk.ponnet.org';

const COLLECTIONS = {
  notes: 'notes',
  craftImports: 'craft_imports',
  devices: 'ios_devices',
  learningProgress: 'learning_progress',
} as const;

export { COLLECTIONS };

export async function pbCall<T = any>(
  method: 'GET' | 'POST' | 'PATCH' | 'DELETE',
  path: string,
  body?: Record<string, unknown>,
): Promise<T> {
  const res = await fetch(`${PB_URL}/api/${path}`, {
    method,
    headers: { 'Content-Type': 'application/json' },
    body: body ? JSON.stringify(body) : undefined,
  });
  const data = (await res.json().catch(() => null)) as any;
  if (!res.ok) {
    throw new Error(data?.message ?? `PocketBase ${method} /api/${path} failed (${res.status})`);
  }
  return data as T;
}

/** Neue Notiz auf dem shared Backend anlegen (Lern-Erinnerungen/Stift). */
export async function createNote(note: Omit<PbNote, 'id'>): Promise<PbNote> {
  return pbCall<PbNote>('POST', `collections/${COLLECTIONS.notes}/records`, note as any);
}

/** Craft-Import (PSD/SVG/IDML) auf dem shared Backend anlegen. */
export async function createCraftImport(rec: Record<string, unknown>): Promise<any> {
  return pbCall('POST', `collections/${COLLECTIONS.craftImports}/records`, rec as any);
}

export async function updateNote(id: string, patch: Partial<PbNote>): Promise<PbNote> {
  return pbCall<PbNote>('PATCH', `collections/${COLLECTIONS.notes}/records/${id}`, patch as any);
}

export async function deleteNote(id: string): Promise<void> {
  await pbCall('DELETE', `collections/${COLLECTIONS.notes}/records/${id}`);
}

export async function listNotes(perPage = 50, page = 1): Promise<{ items: PbNote[] }> {
  return pbCall<{ items: PbNote[] }>(
    'GET',
    `collections/${COLLECTIONS.notes}/records?per_page=${perPage}&page=${page}&sort=-created`,
  );
}

/** Expo Push-Token für Lern-Erinnerungen auf dem shared Backend speichern. */
export async function savePushToken(token: string, deviceName: string): Promise<void> {
  try {
    await pbCall('POST', `collections/${COLLECTIONS.devices}/records`, {
      device_name: deviceName,
      device_token: token,
    });
  } catch {
    // Scaffold: Nicht zwingend für den ersten Start.
  }
}

/** Lern-Fortschritt (XP / Level / Streak / Missionen) auf dem shared Backend speichern. */
export async function saveLearningProgress(progress: Record<string, unknown>): Promise<any> {
  const id = typeof progress.id === 'string' ? progress.id : typeof progress.$id === 'string' ? String(progress.$id) : null;
  const body: Record<string, unknown> = { ...progress };
  delete body.id;
  delete body.$id;
  const path = id
    ? `collections/${COLLECTIONS.learningProgress}/records/${id}`
    : `collections/${COLLECTIONS.learningProgress}/records`;
  const method = id ? 'PATCH' : 'POST';
  return pbCall(method, path, body);
}

/** Lern-Fortschritt vom shared Backend laden. */
export async function listLearningProgress(): Promise<{ items: Array<Record<string, unknown>> }> {
  return pbCall<{ items: Array<Record<string, unknown>> }>(
    'GET',
    `collections/${COLLECTIONS.learningProgress}/records?per_page=1&sort=-updated`,
  );
}
