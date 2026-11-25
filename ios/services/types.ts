/** Typisierungen für Federwerk iOS – PocketBase-Backend und Notizen. */

export type PbNote = {
  id?: string;
  title: string;
  starred?: boolean;
  created?: string;
  updated?: string;
};

export type SyncResult = {
  ok: boolean;
  uploaded: number;
  deleted: number;
  error?: string;
};

export type PkNoteDraft = {
  id: string;
  title: string;
  image_data: string | null;
  created: string;
  updated: string;
  starred: boolean;
};
