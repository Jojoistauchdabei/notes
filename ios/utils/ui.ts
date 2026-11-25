/** Kleine Helpers: Formatierung + eindeutige IDs. */

import * as Crypto from 'expo-crypto';

export function formatDateTime(iso?: string | null): string {
  if (!iso) return '';
  const d = new Date(iso);
  return Number.isNaN(d.getTime()) ? '' : d.toLocaleString();
}

export function randomId(): string {
  try {
    return Crypto.randomUUID();
  } catch {
    return `nb-${Math.random().toString(36).slice(2)}-${Date.now()}`;
  }
}
