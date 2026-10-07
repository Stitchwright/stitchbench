import "server-only";
// A company's signing key for partner messages and invites, and the partner codes it made that wait to be redeemed.
// The private key is sealed (secrets.ts) under the install's key and never leaves the install. A move leaves it out of
// the file (like the other sealed secrets), so a moved company, or one whose key can't be opened (the install's secret
// changed), makes a new key; its partners then trust the new one by a new partner code.
import { Prisma } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { seal, unseal } from "@/lib/messaging/secrets";
import { newKeyPair, type KeyPair } from "@/lib/partner-signing";

const PENDING_DAYS = 15; // an invite lasts 14 days at the hub; a day more for a clock that's a little off
/** After a key is made, a link.created with no invite on record is still taken for this long: the invite may predate the record. */
export const LEGACY_INVITE_DAYS = 15;

export type PendingInvite = { side: "repair" | "retail"; codeHash: string; expiresAt: string };

/** This company's key, made the first time it is needed (or again when the stored private half is gone or unreadable). */
export async function ownKey(shopId: string, tx: Prisma.TransactionClient = db): Promise<KeyPair & { createdAt: Date }> {
  const row = await tx.partnerKey.findUnique({ where: { shopId } });
  if (row?.privateSealed) {
    const opened = unseal(row.privateSealed, shopId, "partnerKey");
    if (opened) {
      if (opened.stale) await tx.partnerKey.update({ where: { shopId }, data: { privateSealed: seal(opened.plain, shopId, "partnerKey") } });
      return { publicKey: row.publicKey, privateKey: opened.plain, createdAt: row.createdAt };
    }
    console.error(`partner key: the signing key of company ${shopId} can't be opened (the install's secret changed?); a new one is made`);
  }
  const k = newKeyPair();
  const data = { publicKey: k.publicKey, privateSealed: seal(k.privateKey, shopId, "partnerKey"), createdAt: new Date() };
  if (row) {
    // The same row is changed only while it still holds what was read: two processes at once make one key.
    const r = await tx.partnerKey.updateMany({ where: { shopId, publicKey: row.publicKey, privateSealed: row.privateSealed }, data });
    if (!r.count) return ownKey(shopId, tx);
  } else {
    try {
      await tx.partnerKey.create({ data: { shopId, ...data } });
    } catch (e) {
      if (e instanceof Prisma.PrismaClientKnownRequestError && e.code === "P2002") return ownKey(shopId, tx);
      throw e;
    }
  }
  return { ...k, createdAt: data.createdAt };
}

function pendingOf(v: unknown): PendingInvite[] {
  const now = Date.now();
  return (Array.isArray(v) ? (v as PendingInvite[]) : []).filter((p) => p && typeof p.codeHash === "string" && Date.parse(p.expiresAt) + (PENDING_DAYS - 14) * 86400_000 > now);
}

/** Remember a partner code this company made, so the link.created that follows its redeeming is known for what it is. */
export async function notePendingInvite(shopId: string, p: PendingInvite) {
  await ownKey(shopId);
  const row = await db.partnerKey.findUniqueOrThrow({ where: { shopId } });
  await db.partnerKey.update({ where: { shopId }, data: { invites: [...pendingOf(row.invites), p].slice(-50) as unknown as Prisma.InputJsonValue } });
}

export async function pendingInvites(shopId: string, side: string, tx: Prisma.TransactionClient = db): Promise<PendingInvite[]> {
  const row = await tx.partnerKey.findUnique({ where: { shopId } });
  return pendingOf(row?.invites).filter((p) => p.side === side);
}

/** Used: taken off the waiting list (inside the transaction that saves the link). */
export async function consumePendingInvite(shopId: string, codeHash: string, tx: Prisma.TransactionClient = db) {
  const row = await tx.partnerKey.findUnique({ where: { shopId } });
  if (!row) return;
  await tx.partnerKey.update({ where: { shopId }, data: { invites: pendingOf(row.invites).filter((p) => p.codeHash !== codeHash) as unknown as Prisma.InputJsonValue } });
}

/** True while an invite with no record may still exist: the company's key is younger than the longest invite. */
export async function legacyInviteWindowOpen(shopId: string, tx: Prisma.TransactionClient = db): Promise<boolean> {
  const made = (await ownKey(shopId, tx)).createdAt;
  return made.getTime() + LEGACY_INVITE_DAYS * 86400_000 > Date.now();
}
