import type { NoteImageCreate, NoteImageMeta } from "@secondbrain/shared";

/**
 * Note images: bytes in R2, metadata in D1. D1 caps a row at 2 MB, so the
 * base64 the client sends is decoded and streamed to R2; only the pointer
 * (r2_key) and the dimensions live in the `note_images` row.
 *
 * The R2 key embeds the space and note so a stray object is self-describing and
 * a whole note's images share a prefix. It is derived, never taken from the
 * client — an id from the request can only ever address this space's tree.
 */

function r2Key(spaceId: string, noteId: string, imageId: string): string {
  return `spaces/${spaceId}/notes/${noteId}/${imageId}`;
}

function base64ToBytes(b64: string): Uint8Array {
  const bin = atob(b64);
  const out = new Uint8Array(bin.length);
  for (let i = 0; i < bin.length; i++) out[i] = bin.charCodeAt(i);
  return out;
}

export async function createNoteImage(
  db: D1Database,
  bucket: R2Bucket,
  spaceId: string,
  noteId: string,
  input: NoteImageCreate,
): Promise<NoteImageMeta> {
  const key = r2Key(spaceId, noteId, input.id);
  const bytes = base64ToBytes(input.data);

  // R2 first: a metadata row pointing at a missing object is worse than an
  // orphaned object (which a later sweep can reclaim), and the id is
  // client-generated so a retried upload overwrites the same key harmlessly.
  await bucket.put(key, bytes, { httpMetadata: { contentType: input.mime } });

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO note_images
         (id, space_id, note_id, mime, r2_key, byte_size, width, height, created_at)
       VALUES (?,?,?,?,?,?,?,?,?)`,
    )
    .bind(input.id, spaceId, noteId, input.mime, key, bytes.byteLength, input.width, input.height, now)
    .run();

  return {
    id: input.id,
    note_id: noteId,
    mime: input.mime,
    width: input.width,
    height: input.height,
    byte_size: bytes.byteLength,
    created_at: now,
  };
}

export interface NoteImageRow {
  id: string;
  note_id: string;
  mime: string;
  r2_key: string;
  width: number;
  height: number;
  byte_size: number;
}

/** The metadata row for an image, scoped to the space. */
export async function getNoteImageRow(
  db: D1Database,
  spaceId: string,
  id: string,
): Promise<NoteImageRow | null> {
  return db
    .prepare(
      "SELECT id, note_id, mime, r2_key, width, height, byte_size FROM note_images WHERE id = ? AND space_id = ?",
    )
    .bind(id, spaceId)
    .first<NoteImageRow>();
}

/** Fetch the bytes from R2 for a resolved row. Null if the object is gone. */
export async function getNoteImageObject(
  bucket: R2Bucket,
  row: NoteImageRow,
): Promise<R2ObjectBody | null> {
  return bucket.get(row.r2_key);
}

/** Delete the R2 objects behind a set of keys (from deleteNote). R2 delete
 *  accepts many keys per call, so one round-trip clears a whole note. */
export async function deleteR2Objects(bucket: R2Bucket, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await bucket.delete(keys);
}
