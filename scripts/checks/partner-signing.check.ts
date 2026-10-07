// Partner messages and invites signed end to end (round-3 W2, findings L134 and I27). Pure: a signed message verifies; a
// changed payload, type, id, link, sender, sequence or time, another key, and an envelope with a swapped key are refused;
// the canonical form ignores key order; invite and redeem proofs; one company can't sign as another. DB: a company's key
// (sealed, stable, made again when it can't be opened); an outbox message signed once and the same signature on a retry;
// incoming messages through takeMessage (unsigned before a key is pinned, the first signed message pins, then a replayed or
// older sequence, a changed message, another company's key and an unsigned one are refused, a retry skips only the
// sequence, unsigned is refused after the transition day); link.created held against the invites this company made (none:
// refused; the redeemer's proof for a code made here: taken; the window for invites made before there was a record);
// the redeem answer's key checked against the long code's fingerprint.
//   npm run check scripts/checks/partner-signing.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import { db } from "@/lib/db";
import { checkInviterKey, longPartnerCode, parsePartnerCode, saveLinkFromHub, signedOutbox, takeMessage, type HubMessage, type HubPartnerLink } from "@/lib/partners";
import { notePendingInvite, ownKey } from "@/lib/partner-keys";
import {
  asSent,
  canonical,
  codeHashOf,
  fingerprint,
  newKeyPair,
  sigShape,
  signInvite,
  signMessage,
  signRedeem,
  verifyInvite,
  verifyMessageSig,
  verifyRedeem,
  type SignedFields,
} from "@/lib/partner-signing";
import { checkShop, cleanup, linkPair } from "./lib";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

async function expectRefused(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.match((e as Error).message, re, `${label}: ${e instanceof Error ? e.message : String(e)}`);
    return;
  }
  assert.fail(`${label}: no error`);
}

const msg: SignedFields = { linkId: "link1", fromSide: "repair", type: "job.update", id: "m1", data: { id: "job1", status: "ON_BENCH", lines: [{ qty: 1, amountCents: 500 }] } };

async function pure() {
  const A = newKeyPair();
  const B = newKeyPair();
  const env = signMessage(A, msg, "1000");
  assert.ok(sigShape(env), "the envelope has the shape the hub passes on");
  assert.ok(verifyMessageSig(env, msg), "a signed message verifies");
  ok("a signed message verifies");
  // key order and a trip through JSON change nothing
  assert.ok(verifyMessageSig(env, { ...msg, data: JSON.parse(JSON.stringify({ lines: [{ amountCents: 500, qty: 1 }], status: "ON_BENCH", id: "job1" })) }), "key order doesn't matter");
  assert.equal(canonical({ b: 1, a: { d: [1, { z: 1, y: 2 }], c: undefined } }), '{"a":{"d":[1,{"y":2,"z":1}]},"b":1}');
  assert.deepEqual(asSent({ a: undefined, b: new Date(0) }), { b: "1970-01-01T00:00:00.000Z" });
  ok("the canonical form ignores key order and undefined");
  // everything is covered
  for (const [what, changed] of Object.entries({
    "a changed payload": { ...msg, data: { ...(msg.data as object), status: "READY_FOR_PICKUP" } },
    "an added field": { ...msg, data: { ...(msg.data as object), extra: 1 } },
    "a changed type": { ...msg, type: "job.cancel" },
    "a changed id (a replay under a new id)": { ...msg, id: "m2" },
    "another link": { ...msg, linkId: "link2" },
    "the other side as sender": { ...msg, fromSide: "retail" },
  })) assert.ok(!verifyMessageSig(env, changed), `${what} is refused`);
  assert.ok(!verifyMessageSig({ ...env, seq: "1001" }, msg), "a changed sequence is refused");
  assert.ok(!verifyMessageSig({ ...env, ts: new Date(0).toISOString() }, msg), "a changed time is refused");
  assert.ok(!verifyMessageSig({ ...env, pub: B.publicKey }, msg), "another key under A's signature is refused");
  assert.ok(!verifyMessageSig({ ...env, sig: signMessage(B, msg, "1000", env.ts).sig }, msg), "B's signature under A's key is refused");
  assert.ok(!verifyMessageSig({ ...env, pub: "not a key" }, msg), "a key that isn't one is refused");
  assert.equal(sigShape({ ...env, seq: "x" }), null);
  assert.equal(sigShape({ ...env, v: 2 }), null);
  ok("a changed payload, type, id, link, sender, sequence, time and key are each refused");
  // B signing "as A": B's envelope verifies under B's key only; whoever pins A's key refuses it
  const forged = signMessage(B, msg, "1000");
  assert.ok(verifyMessageSig(forged, msg) && forged.pub !== A.publicKey, "B's signature is B's");
  assert.ok(forged.pub !== env.pub && fingerprint(A.publicKey) !== fingerprint(B.publicKey));
  ok("B can sign only as B");
  // invites
  const inv = { side: "repair", shopRef: "shopA", terms: { repairCommissionPct: 15 } };
  const proof = signInvite(A, inv);
  assert.ok(verifyInvite(A.publicKey, inv, proof));
  assert.ok(!verifyInvite(A.publicKey, { ...inv, side: "retail" }, proof), "the invite's side is signed");
  assert.ok(!verifyInvite(A.publicKey, { ...inv, shopRef: "shopB" }, proof), "its shop is signed");
  assert.ok(!verifyInvite(A.publicKey, { ...inv, terms: { repairCommissionPct: 90 } }, proof), "its terms are signed");
  assert.ok(!verifyInvite(B.publicKey, inv, proof), "another key can't claim it");
  assert.ok(!verifyInvite(A.publicKey, inv, null));
  const redeem = signRedeem(B, { codeHash: codeHashOf("ABCDEFGHJKMN"), shopRef: "shopB" });
  assert.ok(verifyRedeem(B.publicKey, { codeHash: codeHashOf("ABCDEFGHJKMN"), shopRef: "shopB" }, redeem));
  assert.ok(!verifyRedeem(B.publicKey, { codeHash: codeHashOf("ZZZZZZZZZZZZ"), shopRef: "shopB" }, redeem), "a redeem proof is for one code");
  assert.ok(!verifyRedeem(A.publicKey, { codeHash: codeHashOf("ABCDEFGHJKMN"), shopRef: "shopB" }, redeem), "and one key");
  ok("invite and redeem proofs cover what they name");
  // the long code carries the fingerprint
  const long = longPartnerCode("https://hub.example.test", "ABCD-EFGH-JKMN", fingerprint(A.publicKey));
  assert.equal(parsePartnerCode(long).fp, fingerprint(A.publicKey));
  assert.equal(parsePartnerCode(longPartnerCode("https://hub.example.test", "ABCD-EFGH-JKMN")).fp, null);
  assert.equal(parsePartnerCode("ABCD-EFGH-JKMN").fp, null);
  ok("the long code carries the inviter's fingerprint");
}

const linkRaw = (id: string, repair: { shopRef: string; key?: string; proof?: unknown }, retail: { shopRef: string; key?: string; proof?: unknown }, terms: unknown = {}): HubPartnerLink =>
  ({
    id,
    status: "ACTIVE",
    terms,
    repair: { installId: "i", shopRef: repair.shopRef, name: "Repair Co", publicKey: repair.key ?? null, proof: repair.proof ?? null },
    retail: { installId: "i", shopRef: retail.shopRef, name: "Quilt Co", publicKey: retail.key ?? null, proof: retail.proof ?? null },
    createdAt: new Date().toISOString(),
    endedAt: null,
  }) as HubPartnerLink;

async function database() {
  const A = await checkShop({ repair: true });
  const B = await checkShop({ retail: true });
  const C = await checkShop({ retail: true });
  const linkId = await linkPair(A.shopId, B.shopId);
  const hubMsg = (to: string, over: Partial<HubMessage> & { sigOf?: ReturnType<typeof signMessage> | null }): HubMessage => {
    const { sigOf, ...rest } = over;
    const base = { seq: String(Math.floor(Math.random() * 1e9)), id: `m${Math.random().toString(36).slice(2, 8)}`, linkId, fromSide: "repair", toSide: "retail", toShopRef: to, type: "caps.update", data: { features: ["pickup"] }, createdAt: new Date().toISOString(), ...rest } as HubMessage;
    return sigOf === undefined ? base : { ...base, sig: sigOf };
  };
  const signAs = (key: Awaited<ReturnType<typeof ownKey>>, m: HubMessage, seq: string) => signMessage(key, { linkId: m.linkId, fromSide: m.fromSide, type: m.type, id: m.id, data: m.data }, seq);

  // ----- the company's key -----
  const kA = await ownKey(A.shopId);
  const again = await ownKey(A.shopId);
  assert.equal(again.publicKey, kA.publicKey, "the key is made once");
  const row = await db.partnerKey.findUniqueOrThrow({ where: { shopId: A.shopId } });
  assert.ok(row.privateSealed && !row.privateSealed.includes(kA.privateKey), "the private key is stored sealed, never in the clear");
  assert.notEqual((await ownKey(B.shopId)).publicKey, kA.publicKey, "each company has its own key");
  await ownKey(C.shopId);
  await db.partnerKey.update({ where: { shopId: C.shopId }, data: { privateSealed: null } });
  const c1 = (await db.partnerKey.findUniqueOrThrow({ where: { shopId: C.shopId } })).publicKey;
  const c2 = await ownKey(C.shopId);
  assert.notEqual(c2.publicKey, c1, "a company whose private half is gone (a move leaves it out) makes a new key");
  ok("a company's key: sealed, stable, made again when the private half is missing");

  // ----- an outbox message is signed once, the same on a retry, with a rising sequence -----
  // (straight into the outbox: sendToPartner would also start a partner sync, which this check keeps off the hub)
  await db.partnerOutbox.create({ data: { shopId: A.shopId, linkId, type: "caps.update", data: { features: ["pickup"] } } });
  await db.partnerOutbox.create({ data: { shopId: A.shopId, linkId, type: "caps.update", data: { features: [] } } });
  const [o1, o2] = await db.partnerOutbox.findMany({ where: { shopId: A.shopId, linkId }, orderBy: { createdAt: "asc" } });
  const s1 = await signedOutbox(o1);
  const s1again = await signedOutbox(await db.partnerOutbox.findUniqueOrThrow({ where: { id: o1.id } }));
  assert.deepEqual(s1again, s1, "a retry sends the same signature");
  const s2 = await signedOutbox(o2);
  assert.ok(BigInt(s2.seq) > BigInt(s1.seq), "the sequence rises");
  assert.ok(verifyMessageSig(s1, { linkId, fromSide: "repair", type: o1.type, id: o1.id, data: o1.data }), "it verifies as the hub will carry it");
  assert.equal(s1.pub, kA.publicKey);
  assert.ok(!verifyMessageSig(s1, { linkId, fromSide: "repair", type: o1.type, id: o2.id, data: o1.data }), "and only for its own message");
  const aLink = await db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: A.shopId, id: linkId } } });
  assert.equal(aLink.sigSeqOut.toString(), s2.seq, "the link remembers the last sequence used");
  // a new key re-signs
  await db.partnerKey.update({ where: { shopId: A.shopId }, data: { privateSealed: null } });
  const kA2 = await ownKey(A.shopId);
  const s1new = await signedOutbox(await db.partnerOutbox.findUniqueOrThrow({ where: { id: o1.id } }));
  assert.equal(s1new.pub, kA2.publicKey);
  assert.ok(BigInt(s1new.seq) > BigInt(s2.seq));
  ok("an outbox message is signed once, sent the same on a retry, and signed again under a new key");

  // ----- incoming messages: B receives from A -----
  const bLink = () => db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: B.shopId, id: linkId } } });
  assert.equal((await bLink()).partnerKey, null);
  const unsigned = hubMsg(B.shopId, {});
  assert.equal(await takeMessage(B.shopId, unsigned), true, "an unsigned message from a partner with no key is taken");
  const afterUnsigned = await bLink();
  assert.equal(afterUnsigned.unsignedIn, 1, "and counted as unverified");
  assert.ok(afterUnsigned.lastUnsignedAt);
  assert.equal(afterUnsigned.partnerKey, null);
  const first = hubMsg(B.shopId, {});
  first.sig = signAs(kA2, first, "5000");
  assert.equal(await takeMessage(B.shopId, first), true);
  const pinned = await bLink();
  assert.equal(pinned.partnerKey, kA2.publicKey, "the first signed message pins the partner's key");
  assert.equal(pinned.partnerKeyHow, "first-message");
  assert.equal(pinned.sigSeqIn.toString(), "5000");
  assert.equal(await takeMessage(B.shopId, first), false, "the same message again changes nothing");
  ok("unsigned before a key is pinned; the first signed message pins it");

  const next = hubMsg(B.shopId, {});
  next.sig = signAs(kA2, next, "5001");
  assert.equal(await takeMessage(B.shopId, next), true, "a signed message with a newer sequence is taken");
  // refusals
  const tampered = hubMsg(B.shopId, {});
  tampered.sig = signAs(kA2, tampered, "5002");
  tampered.data = { features: ["pickup", "evil"] };
  await expectRefused("a changed payload", () => takeMessage(B.shopId, tampered), /signature doesn't check out/);
  const retyped = hubMsg(B.shopId, {});
  retyped.sig = signAs(kA2, retyped, "5002");
  retyped.type = "terms.propose";
  await expectRefused("a changed type", () => takeMessage(B.shopId, retyped), /signature doesn't check out/);
  const kB = await ownKey(B.shopId);
  const byB = hubMsg(B.shopId, {});
  byB.sig = signAs(kB, byB, "5003");
  await expectRefused("B signing as A", () => takeMessage(B.shopId, byB), /this shop's own key/);
  const swapped = hubMsg(B.shopId, {});
  swapped.sig = { ...signAs(kB, swapped, "5004"), pub: kA2.publicKey };
  await expectRefused("B's signature under A's key", () => takeMessage(B.shopId, swapped), /signature doesn't check out/);
  const notSigned = hubMsg(B.shopId, {});
  await expectRefused("unsigned once a key is pinned", () => takeMessage(B.shopId, notSigned), /isn't signed/);
  const replayed = hubMsg(B.shopId, {});
  replayed.sig = signAs(kA2, replayed, "5001");
  await expectRefused("a repeated sequence", () => takeMessage(B.shopId, replayed), /sequence number isn't newer/);
  const older = hubMsg(B.shopId, {});
  older.sig = signAs(kA2, older, "4000");
  await expectRefused("an older sequence", () => takeMessage(B.shopId, older), /sequence number isn't newer/);
  const malformed = hubMsg(B.shopId, {});
  malformed.sig = { v: 1, pub: kA2.publicKey, seq: "x", ts: "now", sig: "y" };
  await expectRefused("a malformed signature", () => takeMessage(B.shopId, malformed), /malformed/);
  assert.equal((await bLink()).sigSeqIn.toString(), "5001", "a refused message moves nothing");
  ok("changed payload and type, B signing as A, a swapped key, unsigned after pinning, a replayed and an older sequence, a malformed signature: all refused");
  // a message set aside and tried again by hand: only the sequence is skipped
  await db.partnerSeen.deleteMany({ where: { shopId: B.shopId, key: `${older.linkId}:${older.fromSide}:${older.id}:${older.toSide}` } });
  assert.equal(await takeMessage(B.shopId, older, true), true, "a retry of an older signed message is taken");
  await expectRefused("a retry still needs a real signature", () => takeMessage(B.shopId, { ...tampered, id: "other" }, true), /signature doesn't check out/);
  ok("a retry skips the sequence check and nothing else");
  // the transition day
  process.env.PARTNER_UNSIGNED_UNTIL = "2020-01-01";
  try {
    const D = await checkShop({ retail: true });
    const id2 = await linkPair(A.shopId, D.shopId);
    const late = hubMsg(D.shopId, { linkId: id2 });
    await expectRefused("unsigned after the transition day", () => takeMessage(D.shopId, late), /unsigned messages aren't taken any more/);
  } finally {
    delete process.env.PARTNER_UNSIGNED_UNTIL;
  }
  ok("unsigned messages are refused everywhere after the transition day");

  // ----- link.created is held against the invites this company made -----
  const R = await checkShop({ repair: true });
  const Q = newKeyPair();
  const Z = newKeyPair();
  const kR = await ownKey(R.shopId);
  await db.partnerKey.update({ where: { shopId: R.shopId }, data: { createdAt: new Date(Date.now() - 30 * 86400_000) } }); // the window for old invites is over
  const code = "ABCDEFGHJKMN";
  const linkA = `lnk${crypto.randomBytes(6).toString("hex")}`;
  const redeemerProof = signRedeem(Q, { codeHash: codeHashOf(code), shopRef: "quilt1" });
  const announced = (proof: unknown, key = Q.publicKey) => linkRaw(linkA, { shopRef: R.shopId, key: kR.publicKey }, { shopRef: "quilt1", key, proof }, { repairCommissionPct: 10 });
  await expectRefused("a partnership no code here made", () => saveLinkFromHub(R.shopId, "repair", announced(redeemerProof)), /no partner code made here/);
  assert.equal(await db.partnerLink.count({ where: { shopId: R.shopId, id: linkA } }), 0, "a hub can't make a partnership on its own");
  await notePendingInvite(R.shopId, { side: "repair", codeHash: codeHashOf(code), expiresAt: new Date(Date.now() + 14 * 86400_000).toISOString() });
  await expectRefused("a proof for another key", () => saveLinkFromHub(R.shopId, "repair", announced(signRedeem(Z, { codeHash: codeHashOf(code), shopRef: "quilt1" }), Q.publicKey)), /no partner code made here/);
  await expectRefused("a proof for another code", () => saveLinkFromHub(R.shopId, "repair", announced(signRedeem(Q, { codeHash: codeHashOf("ZZZZZZZZZZZZ"), shopRef: "quilt1" }))), /no partner code made here/);
  await saveLinkFromHub(R.shopId, "repair", announced(redeemerProof));
  const made = await db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: R.shopId, id: linkA } } });
  assert.deepEqual([made.partnerKey, made.partnerKeyHow], [Q.publicKey, "invite"], "the redeemer's key is pinned against the invite");
  assert.equal((await db.partnerKey.findUniqueOrThrow({ where: { shopId: R.shopId } })).invites instanceof Array && ((await db.partnerKey.findUniqueOrThrow({ where: { shopId: R.shopId } })).invites as unknown[]).length, 0, "the invite is used up");
  // the same announcement again, or one with other terms, changes nothing (no invite is left)
  await saveLinkFromHub(R.shopId, "repair", linkRaw(linkA, { shopRef: R.shopId, key: kR.publicKey }, { shopRef: "quilt1", key: Z.publicKey, proof: redeemerProof }, { repairCommissionPct: 99 }));
  const still = await db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: R.shopId, id: linkA } } });
  assert.deepEqual([still.partnerKey, normalizeCommission(still.terms)], [Q.publicKey, 10], "a link already here changes only through a code made or entered here");
  ok("link.created: refused with no invite, refused for another key or code, taken against an invite made here, then inert");
  // an invite made before there was a record: the window after the key was made
  const W = await checkShop({ repair: true });
  await ownKey(W.shopId);
  const linkW = `lnk${crypto.randomBytes(6).toString("hex")}`;
  await saveLinkFromHub(W.shopId, "repair", linkRaw(linkW, { shopRef: W.shopId }, { shopRef: "quilt2", key: Q.publicKey, proof: redeemerProof }));
  const w = await db.partnerLink.findUniqueOrThrow({ where: { shopId_id: { shopId: W.shopId, id: linkW } } });
  assert.deepEqual([w.partnerKey, w.partnerKeyHow], [Q.publicKey, "invite-unrecorded"]);
  ok("an invite made before signing existed is still taken while the company's key is new");

  // ----- the redeem answer: the inviter's key against the long code's fingerprint and the invite's signature -----
  const I = newKeyPair();
  const terms = { repairCommissionPct: 12 };
  const goodProof = signInvite(I, { side: "repair", shopRef: "repairShop", terms });
  const answer = (key: string, proof: unknown) => linkRaw("lnkX", { shopRef: "repairShop", key, proof }, { shopRef: "quilt" }, terms);
  const fp = fingerprint(I.publicKey);
  assert.deepEqual(checkInviterKey("retail", answer(I.publicKey, goodProof), fp), { key: I.publicKey, how: "code-checked" });
  assert.deepEqual(checkInviterKey("retail", answer(I.publicKey, goodProof), null), { key: I.publicKey, how: "code" });
  assert.deepEqual(checkInviterKey("retail", answer("", null), null), { key: null, how: "none" }, "an older inviter sends no key: nothing to pin");
  const Zfp = fingerprint(newKeyPair().publicKey);
  await expectRefused("a fingerprint that isn't the key's", async () => checkInviterKey("retail", answer(I.publicKey, goodProof), Zfp), /isn't the one in the code/);
  await expectRefused("a key the hub swapped in (its own invite signature)", async () => checkInviterKey("retail", answer(Z.publicKey, goodProof), fp), /signature on its partner code doesn't check out/);
  await expectRefused("a key and signature the hub made up, against the code's fingerprint", async () => checkInviterKey("retail", answer(Z.publicKey, signInvite(Z, { side: "repair", shopRef: "repairShop", terms })), fp), /isn't the one in the code/);
  await expectRefused("terms the hub changed", async () => checkInviterKey("retail", linkRaw("lnkX", { shopRef: "repairShop", key: I.publicKey, proof: goodProof }, { shopRef: "quilt" }, { repairCommissionPct: 90 }), fp), /signature on its partner code/);
  await expectRefused("the key left out of a code that named one", async () => checkInviterKey("retail", answer("", null), fp), /gave none back/);
  await expectRefused("no proof", async () => checkInviterKey("retail", answer(I.publicKey, null), null), /signature on its partner code/);
  ok("the redeem answer: the inviter's key must match the code's fingerprint and carry a valid invite signature (a mismatch is refused)");
}

const normalizeCommission = (t: unknown) => (t as { repairCommissionPct?: number }).repairCommissionPct;

(async () => {
  try {
    await pure();
    await database();
    console.log(`partner-signing: ${steps} checks passed`);
  } finally {
    await cleanup();
    await db.$disconnect();
  }
})().catch((e) => {
  console.error(e);
  process.exitCode = 1;
});

