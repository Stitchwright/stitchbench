import "server-only";
// Proofs and cancels for an order paid on MakerFoundry (docs/plans/makerfoundry-orders-plan.md package 5). The customer is never given to
// the shop: the proof goes to MakerFoundry as a message (`proof.sent`, the mock-up as a file by the hub's signed address, checked there by
// size and SHA-256) and the customer's answer comes back as `proof.answer`; either side may cancel with `order.cancel`.
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { UserError } from "@/lib/user-error";
import { assertId } from "@/lib/input";
import { requireBaseWritable } from "@/lib/base-gate";
import { requireModule } from "@/lib/modules";
import { checkBucketUrl } from "@/lib/offsite/hub-store";
import { imageType } from "@/lib/decor";
import { MAX_PREVIEW_BYTES } from "@/lib/shop-orders/contract";
import { Prisma } from "@/generated/prisma/client";
import { plain, v2 } from "@/lib/shop-orders/hubv2";
import { enqueue } from "@/lib/shop-orders/outbox";
import type { MessageContext } from "@/lib/shop-orders/handlers";
import type { CurrentUser } from "@/lib/session";

/** Puts the mock-up with the hub (a file by a short-lived signed address, announced with its size and SHA-256) and says when it is there. */
async function uploadMockup(shopId: string, conversation: string, bytes: Uint8Array<ArrayBuffer>, type: "image/png" | "image/jpeg"): Promise<string> {
  const sha256 = crypto.createHash("sha256").update(bytes).digest("hex");
  const put = (await (await v2(shopId, "/v2/files/put", { method: "POST", json: { conversation, sha256, size: bytes.length, kind: "mockup", type } })).json()) as { ready?: boolean; url?: unknown; headers?: Record<string, string> };
  if (!put.ready) {
    const r = await fetch(checkBucketUrl(put.url), { method: "PUT", headers: put.headers ?? {}, body: bytes, redirect: "manual", signal: AbortSignal.timeout(2 * 60_000) });
    if (!r.ok) throw new UserError(`The file store didn't take the picture (${r.status}). Try again.`);
    await v2(shopId, "/v2/files/done", { method: "POST", json: { conversation, sha256 } });
  }
  return sha256;
}

/** Sends the order's mock-up to the customer as proof N, and tells MakerFoundry the order is waiting on their answer. */
export async function sendOnlineProofFor(user: CurrentUser, id: string, note: string | null): Promise<string> {
  await requireBaseWritable(user);
  await requireModule(user, "decorating");
  const shopId = user.shopId;
  const o = await db.decorOrder.findFirst({ where: { id: assertId(id), shopId }, select: { id: true, number: true, status: true, source: true, onlineRef: true, proofNo: true, mockupMime: true, mockupData: true } });
  if (!o) throw new UserError("Order not found.");
  if (o.source !== "MAKERFOUNDRY" || !o.onlineRef) throw new UserError("This order didn't come from MakerFoundry: send its proof by email or text.");
  if (o.status !== "QUOTED") throw new UserError("A proof goes out while the order is quoted, before it is approved.");
  if (!o.mockupData || o.mockupData.length === 0) throw new UserError("Add the mock-up picture first: it is the proof the customer sees.");
  const bytes = new Uint8Array(o.mockupData);
  const type = imageType(bytes);
  if (!type || bytes.length > MAX_PREVIEW_BYTES) throw new UserError("The mock-up has to be a PNG or JPEG of 2 MB at most.");
  const say = (note ?? "").replace(/[\u0000-\u001f\u007f]+/g, " ").replace(/\s+/g, " ").trim().slice(0, 500);
  let sha256: string;
  try {
    sha256 = await uploadMockup(shopId, o.onlineRef, bytes, type);
  } catch (e) {
    if (e instanceof UserError) throw e;
    throw new UserError(`The picture couldn't be sent to StitchHub just now (${plain(e)}). Nothing was sent; try again.`);
  }
  const proof = o.proofNo + 1;
  await db.$transaction(async (tx) => {
    const done = await tx.decorOrder.updateMany({ where: { id: o.id, shopId, status: "QUOTED", proofNo: o.proofNo }, data: { proofNo: proof, proofSentAt: new Date(), proofAnswer: null, proofNote: null } });
    if (done.count !== 1) throw new UserError("The order changed while you were looking. Reload and try again.");
    await enqueue(tx, shopId, { conversation: o.onlineRef!, type: "proof.sent", body: { proof, mockup: { size: bytes.length, sha256, type }, ...(say ? { note: say } : {}) } });
    await enqueue(tx, shopId, { conversation: o.onlineRef!, type: "order.status", body: { status: "proof_sent" } });
  });
  return `Proof ${proof} is on its way to the customer through MakerFoundry.`;
}

// ---------------------------------------------------------------------------------------------------------------
// messages from MakerFoundry

/** The customer answered a proof. Approved moves a quoted order to approved; changes keeps it quoted with their words on it. */
export async function applyProofAnswer(c: MessageContext): Promise<"applied" | "defer"> {
  const b = c.body as { proof: number; answer: "approved" | "changes"; note?: string };
  const o = await db.decorOrder.findFirst({ where: { shopId: c.shopId, onlineRef: c.conversation, source: "MAKERFOUNDRY" }, select: { id: true, status: true, proofNo: true } });
  if (!o) return "defer"; // the order itself hasn't been applied yet
  // An answer to an older proof than the one now out says nothing about the picture the customer is looking at.
  if (b.proof !== o.proofNo) return "applied";
  await db.$transaction(async (tx) => {
    const at = new Date();
    if (b.answer === "approved" && o.status === "QUOTED") {
      const r = await tx.decorOrder.updateMany({ where: { id: o.id, shopId: c.shopId, status: "QUOTED" }, data: { status: "APPROVED", approvedAt: at, proofAnswer: "approved", proofNote: b.note ?? null } });
      if (r.count === 1) await enqueue(tx, c.shopId, { conversation: c.conversation, type: "order.status", body: { status: "approved" } });
    } else {
      await tx.decorOrder.updateMany({ where: { id: o.id, shopId: c.shopId }, data: { proofAnswer: b.answer, proofNote: b.note ?? null } });
    }
  });
  return "applied";
}

/**
 * The customer cancels. Before production the order is cancelled (MakerFoundry refunds in full). Once it is in production the shop decides,
 * so the order is only flagged: a refund then is the shop's to decide.
 */
export async function applyCustomerCancel(c: MessageContext): Promise<"applied" | "defer"> {
  const b = c.body as { by: "shop" | "customer"; why: string };
  if (b.by !== "customer") return "applied"; // a "shop" cancel is ours coming back; nothing to do
  const o = await db.decorOrder.findFirst({ where: { shopId: c.shopId, onlineRef: c.conversation, source: "MAKERFOUNDRY" }, select: { id: true, status: true, note: true, onlineFlag: true } });
  if (!o) return "defer";
  const why = `The customer cancelled: ${b.why}`.slice(0, 300);
  if (o.status === "QUOTED" || o.status === "APPROVED") {
    await db.decorOrder.updateMany({ where: { id: o.id, shopId: c.shopId, status: { in: ["QUOTED", "APPROVED"] } }, data: { status: "CANCELLED", closedAt: new Date(), turnedDownWhy: why, shipTo: Prisma.DbNull } });
  } else if (["IN_PRODUCTION", "READY"].includes(o.status)) {
    await db.decorOrder.updateMany({ where: { id: o.id, shopId: c.shopId }, data: { onlineFlag: [o.onlineFlag, `${why} It is already in production, so whether to refund is your decision.`].filter(Boolean).join("\n").slice(0, 600) } });
  }
  return "applied";
}

/** What the order page should warn about: a proof that never reached the customer, and messages the hub refused. */
export async function onlineNotices(shopId: string, ref: string) {
  const [proofLost, refused] = await Promise.all([
    db.syncOut.count({ where: { shopId, conversation: ref, type: "proof.sent", expiredAt: { not: null } } }),
    db.syncOut.findMany({ where: { shopId, conversation: ref, deadAt: { not: null } }, select: { type: true, error: true }, take: 5 }),
  ]);
  return { proofLost: proofLost > 0, refused };
}
