import { canWrite, type Role } from "@secondbrain/shared";
import { forbidden, notFound } from "./http";

/**
 * The single access-control choke point. Every domain route calls this before
 * touching a space's data; nothing else makes an access decision.
 *
 * Two distinctions carry the security of the whole API:
 *
 *  * No membership → `not_found`, NOT `forbidden`. `forbidden` would confirm
 *    the space id names a real space, turning the API into an existence oracle
 *    for other tenants. A caller who is not a member must not be able to tell a
 *    space that exists from one that doesn't.
 *
 *  * A member with the wrong role → `forbidden`. Here the caller already knows
 *    the space exists (they belong to it), so the honest answer is "you may
 *    read this but not write it" — a viewer, once sharing lands.
 *
 * The returned role lets a route make finer decisions without a second query.
 */
export async function authorize(
  db: D1Database,
  userId: string,
  spaceId: string,
  action: "read" | "write",
): Promise<Role> {
  const row = await db
    .prepare("SELECT role FROM space_members WHERE space_id = ? AND user_id = ?")
    .bind(spaceId, userId)
    .first<{ role: Role }>();

  if (!row) throw notFound();

  if (action === "write" && !canWrite(row.role)) {
    throw forbidden("You have read-only access to this space.");
  }

  return row.role;
}
