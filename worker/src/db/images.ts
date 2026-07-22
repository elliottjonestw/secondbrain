import type { NoteImageCreate, NoteImageMeta } from "@secondbrain/shared";

/**
 * Note images: bytes in Workers KV, metadata in D1. D1 caps a row at 2 MB, so
 * the base64 the client sends is decoded and written to KV; only the pointer
 * (blob_key) and the dimensions live in the `note_images` row.
 *
 * KV, not R2. R2 is the better-shaped product for blobs, but Cloudflare
 * requires a payment method on the account to enable it *even on its free
 * tier*, and no card on the account is the only real guarantee that an abusive
 * traffic spike can never produce a bill — free-plan products return errors
 * once a quota is spent rather than billing an overage. KV ships with the
 * Workers free plan and needs no card.
 *
 * What that trade costs, and why each cost is survivable here:
 *
 *  - 1 GB total (vs R2's 10 GB). At the ~300 KB an encoded note image lands at,
 *    that's a few thousand images. `docs/cloud-migration-plan.md` §11 records it
 *    as a known cap; outgrowing it is the trigger to revisit, not a surprise.
 *  - 1,000 writes and 1,000 deletes per day, each on its own counter. An upload
 *    is one write, so this bounds image *creation*, not viewing (reads are
 *    100,000/day).
 *  - 25 MB per value, an order of magnitude above anything `encodeNoteImage`
 *    produces.
 *  - KV is eventually consistent — a freshly written key can read as missing
 *    for up to 60s. Nothing here reads back a key it just wrote: the client
 *    calls `primeNoteImage` with the bytes it already holds, so the first
 *    render after an upload never touches the network. Do not add a read-back
 *    verification step to the upload path; it would fail intermittently.
 *
 * The key embeds the space and note so a stray value is self-describing and a
 * whole note's images share a prefix. It is derived, never taken from the
 * client — an id from the request can only ever address this space's tree.
 */

function blobKey(spaceId: string, noteId: string, imageId: string): string {
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
  blobs: KVNamespace,
  spaceId: string,
  noteId: string,
  input: NoteImageCreate,
): Promise<NoteImageMeta> {
  const key = blobKey(spaceId, noteId, input.id);
  const bytes = base64ToBytes(input.data);

  // Bytes first: a metadata row pointing at a missing value is worse than an
  // orphaned value (which a later sweep can reclaim), and the id is
  // client-generated so a retried upload overwrites the same key harmlessly.
  await blobs.put(key, bytes);

  const now = new Date().toISOString();
  await db
    .prepare(
      `INSERT OR REPLACE INTO note_images
         (id, space_id, note_id, mime, blob_key, byte_size, width, height, created_at)
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
  blob_key: string;
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
      "SELECT id, note_id, mime, blob_key, width, height, byte_size FROM note_images WHERE id = ? AND space_id = ?",
    )
    .bind(id, spaceId)
    .first<NoteImageRow>();
}

/** The bytes for a resolved row. Null if the value is gone. */
export async function getNoteImageBytes(
  blobs: KVNamespace,
  row: NoteImageRow,
): Promise<ArrayBuffer | null> {
  return blobs.get(row.blob_key, "arrayBuffer");
}

/**
 * Delete the values behind a set of keys (from deleteNote).
 *
 * KV deletes one key per call — unlike R2, which took the whole array in one
 * round-trip — so a note with many images costs one call each, against the
 * 1,000/day delete counter. They run concurrently rather than in sequence
 * because wall-clock time, not CPU, is what a long serial chain would spend.
 */
export async function deleteNoteImageBlobs(blobs: KVNamespace, keys: string[]): Promise<void> {
  if (keys.length === 0) return;
  await Promise.all(keys.map((key) => blobs.delete(key)));
}
