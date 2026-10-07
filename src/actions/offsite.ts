"use server";
// Settings -> Off-site backup (later-round-1-design.md 1.3 to 1.5). Owners and admins; every one works while the program is
// read-only (a backup is never lost to a lapse). Off until the recovery key is made AND typed back correctly: a backup nobody
// can open is worse than none.
import { revalidatePath } from "next/cache";
import { db } from "@/lib/db";
import { safe, noted, shownOnce } from "@/lib/action";
import { UserError } from "@/lib/user-error";
import { requireAdmin } from "@/lib/session";
import { str } from "@/lib/format";
import { actorOf, audit } from "@/lib/audit";
import { keyFromText, keyIdOf, keyToText, makeKeyPair, publicFromPrivate, OffsiteCryptoError } from "@/lib/offsite/crypto";
import { runOffsiteBackup, storeFor } from "@/lib/offsite/backup";
import { testRecoveryKey } from "@/lib/offsite/restore";
import { fmtBytes } from "@/lib/offsite/format";
import { Readable } from "node:stream";
import { seal } from "@/lib/messaging/secrets";
import { isDesktop } from "@/lib/modules";
import { bucketStoreFor, type BucketSettings } from "@/lib/offsite/bucket-store";
import { checkEndpoint } from "@/lib/offsite/s3";
import { readAll } from "@/lib/offsite/store";

const page = () => revalidatePath("/settings/offsite");

/** Makes the company's recovery key: the program keeps the public half, the private half is shown this once and thrown away. */
export const makeOffsiteKey = safe.whileLapsed("makeOffsiteKey")(async function makeOffsiteKey() {
  const user = await requireAdmin();
  const { publicKey, privateKey } = makeKeyPair();
  const keyId = keyIdOf(publicKey);
  const had = await db.offsiteSettings.findUnique({ where: { shopId: user.shopId }, select: { keyId: true } });
  await db.$transaction(async (tx) => {
    // A new key can't open what the old one sealed: backed-up pictures are sent again under the new key.
    if (had?.keyId) await tx.offsiteObject.updateMany({ where: { shopId: user.shopId, kind: "photo", goneAt: null }, data: { goneAt: new Date() } });
    await tx.offsiteSettings.upsert({
      where: { shopId: user.shopId },
      create: { shopId: user.shopId, on: false, publicKey: publicKey.toString("base64"), keyId, keyMadeAt: new Date() },
      update: { on: false, publicKey: publicKey.toString("base64"), keyId, keyMadeAt: new Date(), keyCheckedAt: null },
    });
    await audit(tx, actorOf(user), { action: "offsite.settings", subjectType: "Shop", subjectId: user.shopId, subjectLabel: "Off-site backup", changes: { keyId: [had?.keyId ?? null, keyId] } });
  });
  page();
  return shownOnce(keyToText(privateKey));
});

function typedKey(text: string | null): Buffer {
  try {
    return keyFromText(text ?? "");
  } catch (e) {
    if (e instanceof OffsiteCryptoError) throw new UserError(e.message);
    throw e;
  }
}

/** The owner types the whole recovery key back from the sheet; if it is this company's key, backups switch on. */
export const confirmOffsiteKey = safe.whileLapsed("confirmOffsiteKey")(async function confirmOffsiteKey(formData: FormData) {
  const user = await requireAdmin();
  const s = await db.offsiteSettings.findUnique({ where: { shopId: user.shopId } });
  if (!s?.publicKey) throw new UserError("Make the recovery key first.");
  const typed = typedKey(str(formData.get("key")));
  if (!publicFromPrivate(typed).equals(Buffer.from(s.publicKey, "base64"))) throw new UserError("That isn't the key on the sheet you just printed. Check each group, or make a new key.");
  await db.$transaction(async (tx) => {
    await tx.offsiteSettings.update({ where: { shopId: user.shopId }, data: { on: true, keyCheckedAt: new Date() } });
    await audit(tx, actorOf(user), { action: "offsite.settings", subjectType: "Shop", subjectId: user.shopId, subjectLabel: "Off-site backup", changes: { on: [false, true] } });
  });
  page();
  return noted("Backups are on. The first one runs tonight, or press Back up now.");
});

/** Where the backups go: the folder, or StitchHub (when it is available). */
export const saveOffsiteTarget = safe.whileLapsed("saveOffsiteTarget")(async function saveOffsiteTarget(formData: FormData) {
  const user = await requireAdmin();
  const target = str(formData.get("target")) ?? "hub";
  if (target !== "hub" && target !== "folder" && target !== "bucket") throw new UserError("Pick StitchHub, a folder or your own bucket.");
  // A folder is on the computer the program runs on: on the hosted server that is the server's own disk, not the shop's.
  if (target === "folder" && !isDesktop()) throw new UserError("A folder is for the Windows program. Pick StitchHub or your own bucket.");
  if (target === "bucket" && !(await db.offsiteSettings.findUnique({ where: { shopId: user.shopId }, select: { bucket: true } }))?.bucket) throw new UserError("Fill in your bucket's details first (Your own bucket, below).");
  const folderPath = (str(formData.get("folderPath")) ?? "").slice(0, 300);
  if (target === "folder" && !folderPath) throw new UserError("Type the folder the backups go to.");
  const before = await db.offsiteSettings.findUnique({ where: { shopId: user.shopId }, select: { target: true, folderPath: true } });
  await db.$transaction(async (tx) => {
    await tx.offsiteSettings.upsert({ where: { shopId: user.shopId }, create: { shopId: user.shopId, target, folderPath }, update: { target, folderPath } });
    await audit(tx, actorOf(user), {
      action: "offsite.settings",
      subjectType: "Shop",
      subjectId: user.shopId,
      subjectLabel: "Off-site backup",
      changes: { target: [before?.target ?? null, target], folderPath: [before?.folderPath ?? null, folderPath] },
    });
  });
  page();
});

/** The shop's own bucket (offsite-bucket): address, name, region and keys. A blank secret keeps the one saved; the address is checked as a server must. */
export const saveOffsiteBucket = safe.whileLapsed("saveOffsiteBucket")(async function saveOffsiteBucket(formData: FormData) {
  const user = await requireAdmin();
  const before = await db.offsiteSettings.findUnique({ where: { shopId: user.shopId }, select: { bucket: true } });
  const old = (before?.bucket ?? null) as Partial<BucketSettings> | null;
  const endpoint = await checkEndpoint(str(formData.get("endpoint")) ?? "", { allowPrivate: isDesktop() });
  const bucket = (str(formData.get("bucket")) ?? "").slice(0, 100);
  const region = (str(formData.get("region")) ?? "auto").slice(0, 40);
  const accessKeyId = (str(formData.get("accessKeyId")) ?? "").slice(0, 200);
  const secret = str(formData.get("secret"));
  if (!bucket || !accessKeyId) throw new UserError("Fill in the bucket's name and its access key.");
  if (!/^[A-Za-z0-9._-]{1,100}$/.test(bucket)) throw new UserError("A bucket name has only letters, digits, dots, dashes and underscores.");
  if (!secret && !old?.secretSealed) throw new UserError("Fill in the secret key.");
  const next: BucketSettings = { endpoint, bucket, region, accessKeyId, secretSealed: secret ? seal(secret, user.shopId, "offsiteBucket") : old!.secretSealed! };
  await db.$transaction(async (tx) => {
    await tx.offsiteSettings.upsert({ where: { shopId: user.shopId }, create: { shopId: user.shopId, target: "bucket", bucket: next }, update: { target: "bucket", bucket: next } });
    // The secret is never written to the log, only that it changed.
    await audit(tx, actorOf(user), {
      action: "offsite.settings",
      subjectType: "Shop",
      subjectId: user.shopId,
      subjectLabel: "Off-site backup",
      changes: { bucket: [old?.bucket ?? null, bucket], endpoint: [old?.endpoint ?? null, endpoint], ...(secret ? { secret: ["", "changed"] as [unknown, unknown] } : {}) },
    });
  });
  page();
});

/** Puts, lists, reads and deletes one small file in the bucket: says in words what is wrong, or that all four worked. */
export const testOffsiteBucket = safe.whileLapsed("testOffsiteBucket")(async function testOffsiteBucket() {
  const user = await requireAdmin();
  const s = await db.offsiteSettings.findUnique({ where: { shopId: user.shopId }, select: { bucket: true } });
  const store = await bucketStoreFor(user.shopId, s?.bucket);
  const name = `data/connection-test-${Date.now().toString(36)}.sbob`;
  const body = Buffer.from("StitchBench connection test");
  await store.put(name, Readable.from([body]));
  try {
    if (!(await store.list()).some((o) => o.name === name && o.size === body.length)) throw new UserError("The file was saved but isn't in the bucket's listing: check that the keys may list the bucket.");
    if (!(await readAll(await store.get(name))).equals(body)) throw new UserError("The file read back isn't what was saved.");
  } finally {
    await store.delete(name).catch(() => {});
  }
  return noted("Your bucket works: a file was saved, listed, read back and deleted.");
});

export const turnOffsiteOff = safe.whileLapsed("turnOffsiteOff")(async function turnOffsiteOff() {
  const user = await requireAdmin();
  await db.$transaction(async (tx) => {
    const r = await tx.offsiteSettings.updateMany({ where: { shopId: user.shopId, on: true }, data: { on: false } });
    if (r.count) await audit(tx, actorOf(user), { action: "offsite.settings", subjectType: "Shop", subjectId: user.shopId, subjectLabel: "Off-site backup", changes: { on: [true, false] } });
  });
  page();
});

/** "Back up off-site now": the same job as the night's. */
export const backUpNow = safe.whileLapsed("backUpNow")(async function backUpNow() {
  const user = await requireAdmin();
  const r = await runOffsiteBackup(user.shopId);
  page();
  return noted(`Backed up: ${fmtBytes(r.bytes)}${r.photos ? `, ${r.photos} new picture${r.photos === 1 ? "" : "s"}` : ""}.`);
});

/** "Test my recovery key": opens the newest backup with the key typed in and shows its row counts beside today's. */
export const testOffsiteKey = safe.whileLapsed("testOffsiteKey")(async function testOffsiteKey(formData: FormData) {
  const user = await requireAdmin();
  const key = typedKey(str(formData.get("key")));
  const t = await testRecoveryKey(user.shopId, await storeFor(user.shopId), key);
  const today = Object.values(t.today).reduce((a, b) => a + b, 0);
  await db.offsiteSettings.update({ where: { shopId: user.shopId }, data: { keyCheckedAt: new Date() } });
  page();
  return noted(`The key opens the backup of ${t.at ? t.at.toISOString().slice(0, 10) : t.name}: ${t.rows.toLocaleString("en-US")} rows in it, ${today.toLocaleString("en-US")} in the program now.`);
});
