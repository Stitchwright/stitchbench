// Off-site backup, core (later-round-1-design.md section 1, package offsite-core): the encryption (every kind of damage
// refused), the retention rule, a company backed up to a folder and restored into an empty database with every table equal, no
// picture sent twice, pruning, no freeze, the backup holding only the company's own rows, and one company never seeing another's.
//   npm run check scripts/checks/offsite.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import http from "node:http";
import os from "node:os";
import path from "node:path";
import readline from "node:readline";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { MOVE_TABLES, shopFilterSql, type MoveTable } from "@/lib/move/format";
import { importCompany } from "@/lib/move/import";
import {
  CHUNK,
  decryptBuffer,
  decryptStream,
  encryptBuffer,
  encryptStream,
  keyFromText,
  keyIdOf,
  keyToText,
  makeKeyPair,
  OffsiteCryptoError,
  publicFromPrivate,
} from "@/lib/offsite/crypto";
import { keepNames, KEEP_DAILY, KEEP_MONTHS, KEEP_SUNDAYS } from "@/lib/offsite/retention";
import { dataObjectName, dataObjectTime, photoObjectName, runOffsiteBackup, runDueOffsiteBackups } from "@/lib/offsite/backup";
import { listBackups, restoreToFile, testRecoveryKey } from "@/lib/offsite/restore";
import { folderStore } from "@/lib/offsite/store";
import { checkShop, cleanup } from "./lib";
import { removeCompany } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};

const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "offsite-check-"));

async function rejectsWith(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.ok(e instanceof OffsiteCryptoError || isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

async function tableJson(t: MoveTable, shopId: string): Promise<string> {
  const rows = await db.$queryRawUnsafe<unknown[]>(`SELECT * FROM "${t.t}" WHERE ${shopFilterSql(t)} ORDER BY (${t.key})`, shopId);
  return JSON.stringify(rows, (_k, v) => (typeof v === "bigint" ? v.toString() : v instanceof Uint8Array ? Buffer.from(v).toString("base64") : v));
}

async function main() {
  const a = await checkShop({ repair: true, retail: true });
  const b = await checkShop({ repair: true, retail: true });
  const saved = { desktop: process.env.STITCH_DESKTOP, secret: process.env.MOVE_LOCAL_SECRET };
  delete process.env.STITCH_DESKTOP;
  try {
    // ---------- the encryption ----------
    const kp = makeKeyPair();
    assert.equal(kp.publicKey.length, 32);
    assert.equal(kp.privateKey.length, 32);
    assert.ok(publicFromPrivate(kp.privateKey).equals(kp.publicKey));
    const text = keyToText(kp.privateKey);
    assert.match(text, /^([A-Z2-7]{4}-){12}[A-Z2-7]{4}$/, "52 characters in 13 groups of four");
    assert.ok(keyFromText(text.toLowerCase().replace(/-/g, " ")).equals(kp.privateKey), "case, spaces and dashes don't matter");
    assert.throws(() => keyFromText(text.slice(0, -2)), OffsiteCryptoError);
    assert.throws(() => keyFromText(text.replace(/^./, "1")), OffsiteCryptoError);
    assert.equal(keyIdOf(kp.publicKey).length, 16);
    for (const size of [0, 1, CHUNK - 1, CHUNK, CHUNK + 1, 3 * CHUNK + 17]) {
      const plain = crypto.randomBytes(size);
      const sealed = await encryptBuffer(plain, kp.publicKey);
      assert.ok(!sealed.includes(plain.subarray(0, 16)) || size < 16, "the plaintext isn't in the file");
      assert.ok((await decryptBuffer(sealed, kp.privateKey)).equals(plain), `${size} bytes round-trip`);
    }
    const big = crypto.randomBytes(3 * CHUNK + 5);
    const sealed = await encryptBuffer(big, kp.publicKey);
    const other = makeKeyPair();
    await rejectsWith("a wrong key", () => decryptBuffer(sealed, other.privateKey), /does not open this backup/);
    const flip = (buf: Buffer, at: number) => {
      const c = Buffer.from(buf);
      c[at] ^= 1;
      return c;
    };
    await rejectsWith("a flipped byte in the body", () => decryptBuffer(flip(sealed, sealed.length - 40), kp.privateKey), /damaged/);
    const headerEnd = 6 + 4 + sealed.readUInt32BE(6);
    await rejectsWith("a flipped byte in the first chunk", () => decryptBuffer(flip(sealed, headerEnd + 20), kp.privateKey), /damaged/);
    await rejectsWith("a flipped byte in the header", () => decryptBuffer(flip(sealed, 30), kp.privateKey), /not a StitchBench backup|does not open|damaged/);
    await rejectsWith("a cut file", () => decryptBuffer(sealed.subarray(0, sealed.length - 100), kp.privateKey), /damaged/);
    await rejectsWith("a file cut at a chunk boundary", () => decryptBuffer(sealed.subarray(0, sealed.length - (big.length % CHUNK) - 16 - 4), kp.privateKey), /damaged/);
    await rejectsWith("nothing at all", () => decryptBuffer(Buffer.alloc(0), kp.privateKey), /not a StitchBench backup|damaged/);
    await rejectsWith("not a backup", () => decryptBuffer(crypto.randomBytes(500), kp.privateKey), /not a StitchBench backup/);
    // a dropped middle chunk: split the frames and rejoin without the second
    const frames: Buffer[] = [];
    for (let p = headerEnd; p < sealed.length; ) {
      const len = sealed.readUInt32BE(p);
      frames.push(sealed.subarray(p, p + 4 + len));
      p += 4 + len;
    }
    assert.equal(frames.length, 4);
    await rejectsWith("a dropped chunk", () => decryptBuffer(Buffer.concat([sealed.subarray(0, headerEnd), frames[0], frames[2], frames[3]]), kp.privateKey), /damaged/);
    await rejectsWith("reordered chunks", () => decryptBuffer(Buffer.concat([sealed.subarray(0, headerEnd), frames[1], frames[0], frames[2], frames[3]]), kp.privateKey), /damaged/);
    // streaming: odd write sizes give the same file contents back
    const enc = encryptStream(kp.publicKey);
    const dec = decryptStream(kp.privateKey);
    const got: Buffer[] = [];
    dec.on("data", (c: Buffer) => got.push(c));
    const done = new Promise<void>((res, rej) => {
      dec.on("end", res);
      dec.on("error", rej);
    });
    enc.pipe(dec);
    for (let p = 0; p < big.length; p += 7001) enc.write(big.subarray(p, p + 7001));
    enc.end();
    await done;
    assert.ok(Buffer.concat(got).equals(big), "streamed in odd pieces");
    ok("encryption: round-trips at every size; a wrong key, a flipped byte, a cut file, a dropped or reordered chunk are each refused in words");

    // ---------- retention ----------
    const day = (n: number, h = 2) => new Date(Date.UTC(2026, 9, 6 - n, h));
    const many = Array.from({ length: 400 }, (_, n) => ({ name: dataObjectName(day(n)), at: day(n) }));
    const keep = keepNames(many);
    assert.ok(keep.has(many[0].name), "the newest is kept");
    for (let n = 0; n < KEEP_DAILY; n++) assert.ok(keep.has(many[n].name), `daily ${n}`);
    assert.ok(!keep.has(many[KEEP_DAILY + 1].name) || many[KEEP_DAILY + 1].at.getUTCDay() === 0 || many[KEEP_DAILY + 1].at.getUTCDate() === 1, "an older ordinary day goes");
    const sundays = many.filter((x) => x.at.getUTCDay() === 0).slice(0, KEEP_SUNDAYS);
    for (const s of sundays) assert.ok(keep.has(s.name), "the last 8 Sundays");
    const firsts = many.filter((x) => x.at.getUTCDate() === 1).slice(0, KEEP_MONTHS);
    for (const f of firsts) assert.ok(keep.has(f.name), "the last 12 firsts of a month");
    assert.ok(keep.size <= KEEP_DAILY + KEEP_SUNDAYS + KEEP_MONTHS && keep.size >= KEEP_DAILY);
    // two backups on one day: the newer one counts for the day
    const twice = keepNames([{ name: "data/a", at: day(0, 1) }, { name: "data/b", at: day(0, 5) }]);
    assert.deepEqual([...twice].sort(), ["data/b"]);
    assert.equal(dataObjectTime(dataObjectName(day(3, 2)))?.getTime(), day(3, 2).getTime());
    assert.equal(dataObjectTime("data/nope"), null);
    ok(`retention: the newest, ${KEEP_DAILY} dailies, ${KEEP_SUNDAYS} Sundays and ${KEEP_MONTHS} firsts of a month`);

    // A folder is a Windows program target only (refused on the hosted server): these sections run as the program.
    process.env.STITCH_DESKTOP = "1";
    // ---------- a company backed up to a folder ----------
    const folderA = path.join(DIR, "store-a");
    const folderB = path.join(DIR, "store-b");
    const storeA = folderStore(folderA);
    const key = makeKeyPair();
    await db.offsiteSettings.create({ data: { shopId: a.shopId, on: true, target: "folder", folderPath: folderA, publicKey: key.publicKey.toString("base64"), keyId: keyIdOf(key.publicKey), keyMadeAt: new Date(), keyCheckedAt: new Date() } });
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Backup Betty", phone: "5551230000" } });
    const mach = await db.machine.create({ data: { shopId: a.shopId, customerId: cust.id, brand: "Bernina", model: "B 570", modelKey: "b570" } });
    const t = await db.ticket.create({ data: { shopId: a.shopId, number: 5001, machineId: mach.id, customerId: cust.id, status: "ON_BENCH", intake: {} } });
    await db.ticketLine.create({ data: { ticketId: t.id, kind: "SERVICE", description: "Clean and oil", unitPriceCents: 9500 } });
    await db.part.create({ data: { shopId: a.shopId, partNumber: "OFF-1", description: "Hook", priceCents: 1200, qtyOnHand: 3, numberKeys: [] } });
    const photos = [crypto.randomBytes(40_000), crypto.randomBytes(300_000)];
    for (const [i, data] of photos.entries()) await db.machinePhoto.create({ data: { shopId: a.shopId, machineId: mach.id, ticketId: t.id, mime: "image/jpeg", data, caption: `p${i}` } });
    // company B has its own rows, never in A's backup
    const custB = await db.customer.create({ data: { shopId: b.shopId, name: "Other Olive" } });
    const machB = await db.machine.create({ data: { shopId: b.shopId, customerId: custB.id, brand: "Janome", model: "MC6700P", modelKey: "mc6700p" } });
    await db.machinePhoto.create({ data: { shopId: b.shopId, machineId: machB.id, mime: "image/jpeg", data: crypto.randomBytes(5000) } });

    const movingBefore = (await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { movingAt: true } })).movingAt;
    const moves = await db.companyMove.count({ where: { shopId: a.shopId } });
    const first = await runOffsiteBackup(a.shopId, { now: new Date(Date.UTC(2026, 9, 1, 6)) });
    assert.equal(first.photos, 2, "both pictures sent");
    const files = await storeA.list();
    assert.equal(files.filter((f) => f.name.startsWith("photo/")).length, 2);
    assert.equal(files.filter((f) => f.name.startsWith("data/")).length, 1);
    for (const f of files) assert.ok(fs.readFileSync(path.join(folderA, ...f.name.split("/"))).subarray(0, 6).toString() === "SBOB1\n", `${f.name} is ciphertext`);
    const raw = Buffer.concat(files.map((f) => fs.readFileSync(path.join(folderA, ...f.name.split("/")))));
    assert.ok(!raw.includes(Buffer.from("Backup Betty")) && !raw.includes(photos[0].subarray(100, 140)), "no clear text in the store");
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId }, select: { movingAt: true } })).movingAt, movingBefore, "a backup freezes nothing");
    assert.equal(await db.companyMove.count({ where: { shopId: a.shopId } }), moves, "and writes no move record");
    const idx = await db.offsiteObject.findMany({ where: { shopId: a.shopId } });
    assert.equal(idx.length, 3);
    assert.ok(idx.every((o) => files.some((f) => f.name === o.name && f.size === o.size)), "the index matches the store: names and sizes");
    const run1 = await db.offsiteRun.findUniqueOrThrow({ where: { id: first.runId } });
    assert.deepEqual([run1.status, run1.photos, Number(run1.bytes) > 0], ["ok", 2, true]);

    // the second night: no picture again
    const second = await runOffsiteBackup(a.shopId, { now: new Date(Date.UTC(2026, 9, 2, 6)) });
    assert.equal(second.photos, 0, "no picture is sent twice");
    assert.equal((await storeA.list()).filter((f) => f.name.startsWith("photo/")).length, 2);
    assert.equal((await storeA.list()).filter((f) => f.name.startsWith("data/")).length, 2);
    // a new picture goes, and only it
    const p3 = crypto.randomBytes(1000);
    const row3 = await db.machinePhoto.create({ data: { shopId: a.shopId, machineId: mach.id, mime: "image/png", data: p3 } });
    const third = await runOffsiteBackup(a.shopId, { now: new Date(Date.UTC(2026, 9, 3, 6)) });
    assert.equal(third.photos, 1);
    await db.machinePhoto.delete({ where: { id: row3.id } });
    await runOffsiteBackup(a.shopId, { now: new Date(Date.UTC(2026, 9, 4, 6)) });
    const gone = await db.offsiteObject.findFirstOrThrow({ where: { shopId: a.shopId, photoId: row3.id } });
    assert.ok(gone.goneAt, "a picture whose row is gone is marked, and its object waits out the grace period");
    assert.ok((await storeA.list()).some((f) => f.name === gone.name));
    ok("backup to a folder: ciphertext only, indexed, no freeze; each picture sent once; a deleted picture's object waits");

    // ---------- restore into an empty database ----------
    const backups = await listBackups(storeA);
    assert.equal(backups.length, 4);
    const latest = backups[0].name;
    const before: Record<string, string> = {};
    for (const mt of MOVE_TABLES) before[mt.t] = await tableJson(mt, a.shopId);
    const file = path.join(DIR, "restored.stitchmove.ndjson.gz");
    await rejectsWith("restore with a wrong key", () => restoreToFile(storeA, makeKeyPair().privateKey, latest, path.join(DIR, "x.gz")), /does not open this backup/);
    const info = await restoreToFile(storeA, key.privateKey, latest, file);
    assert.equal(info.shopId, a.shopId);
    assert.equal(info.photos, 2, "the pictures were fetched from their own objects");
    const tableCounts = info.tables;
    assert.equal(tableCounts.Customer, 1);
    assert.equal(tableCounts.MachinePhoto, 2);
    // nothing of the file's lines has a clear marker or another company's rows
    const lines: Record<string, unknown>[] = [];
    for await (const l of readline.createInterface({ input: fs.createReadStream(file).pipe(zlib.createGunzip()) })) lines.push(JSON.parse(l));
    assert.ok(lines.every((l) => !("_ref" in l)), "no _ref left in the restored file");
    const foreign = lines.filter((l) => l.shopId && l.shopId !== a.shopId);
    assert.equal(foreign.length, 0, "the backup holds only the company's own rows");
    assert.ok(!lines.some((l) => l.id === custB.id));
    await removeCompany(a.shopId);
    assert.equal(await db.customer.count({ where: { shopId: a.shopId } }), 0);
    const summary = await importCompany(file, { by: "operator" });
    assert.equal(summary.shopId, a.shopId);
    for (const mt of MOVE_TABLES) {
      if (["OffsiteObject", "Shop", "MessagingSettings", "OffsiteSettings"].includes(mt.t)) continue; // the index grew after the snapshot; the import's own changes
      assert.equal(await tableJson(mt, a.shopId), before[mt.t], `${mt.t}: every row as it was`);
    }
    const ph = await db.machinePhoto.findMany({ where: { shopId: a.shopId }, orderBy: { caption: "asc" } });
    assert.ok(Buffer.from(ph[0].data).equals(photos[0]) && Buffer.from(ph[1].data).equals(photos[1]), "the pictures came back byte for byte");
    ok("restore into an empty database: every table's rows as they were, the pictures byte for byte, none of B's rows in the file");

    // ---------- damage to what is in the store ----------
    const dataFile = path.join(folderA, ...latest.split("/"));
    const good = fs.readFileSync(dataFile);
    const out = path.join(DIR, "damaged.gz");
    fs.writeFileSync(dataFile, flip(good, good.length - 30));
    await rejectsWith("a flipped byte in the stored file", () => restoreToFile(storeA, key.privateKey, latest, out), /damaged/);
    fs.writeFileSync(dataFile, good.subarray(0, good.length - 50));
    await rejectsWith("a cut stored file", () => restoreToFile(storeA, key.privateKey, latest, out), /damaged|ends before/);
    fs.writeFileSync(dataFile, good);
    assert.ok(!fs.existsSync(out), "a refused restore leaves no file");
    const aPhoto = (await storeA.list()).find((f) => f.name.startsWith("photo/MachinePhoto/"))!;
    const photoFile = path.join(folderA, ...aPhoto.name.split("/"));
    const photoBytes = fs.readFileSync(photoFile);
    fs.rmSync(photoFile);
    await rejectsWith("a missing picture", () => restoreToFile(storeA, key.privateKey, latest, out), /picture of the backup is missing/);
    fs.writeFileSync(photoFile, photoBytes);
    // another company's picture swapped in for this one: the hash in the file refuses it
    const bPhotoSealed = await encryptBuffer(crypto.randomBytes(photos[0].length), key.publicKey);
    fs.writeFileSync(photoFile, bPhotoSealed);
    await rejectsWith("a picture that doesn't match its hash", () => restoreToFile(storeA, key.privateKey, latest, out), /doesn't match/);
    fs.writeFileSync(photoFile, photoBytes);
    assert.equal((await restoreToFile(storeA, key.privateKey, latest, out)).photos, 2, "put back, it restores again");
    ok("damage in the store (a flipped byte, a cut file, a missing or swapped picture) is refused in words and leaves nothing behind");

    // ---------- the key test ----------
    const kt = await testRecoveryKey(a.shopId, storeA, key.privateKey);
    assert.equal(kt.name, (await db.offsiteObject.findFirstOrThrow({ where: { shopId: a.shopId, kind: "data" }, orderBy: { name: "desc" } })).name);
    assert.ok(kt.rows > 0 && kt.tables.Customer === 1 && kt.today.Customer === 1);
    await rejectsWith("a wrong key on the test", () => testRecoveryKey(a.shopId, storeA, makeKeyPair().privateKey), /does not open this backup/);
    ok("Test my recovery key: opens the newest backup, row counts beside today's; a wrong key says so");

    // ---------- pruning ----------
    const now = new Date(Date.UTC(2026, 9, 20, 6));
    await db.offsiteObject.deleteMany({ where: { shopId: a.shopId, kind: "data" } });
    fs.rmSync(path.join(folderA, "data"), { recursive: true, force: true });
    const olds = Array.from({ length: 60 }, (_, n) => new Date(Date.UTC(2026, 9, 19 - n, 2)));
    for (const at of olds) {
      const name = dataObjectName(at);
      await storeA.put(name, Readable.from([Buffer.from("x")]));
      await db.offsiteObject.create({ data: { shopId: a.shopId, name, kind: "data", size: 1, sha256: "00", uploadedAt: at } });
    }
    const run = await runOffsiteBackup(a.shopId, { now });
    const left = (await db.offsiteObject.findMany({ where: { shopId: a.shopId, kind: "data" } })).map((o) => o.name);
    const expected = keepNames([...olds.map((at) => ({ name: dataObjectName(at), at })), { name: run.dataName, at: now }]);
    assert.deepEqual([...left].sort(), [...expected].sort(), "the rule decides what is left");
    assert.deepEqual((await storeA.list()).filter((f) => f.name.startsWith("data/")).map((f) => f.name).sort(), [...expected].sort(), "and the store matches the index");
    assert.ok(run.pruned > 0 && left.includes(run.dataName));
    ok("pruning after a good run keeps what the rule says in the store and the index");

    // ---------- off, and the schedule ----------
    await db.offsiteSettings.update({ where: { shopId: a.shopId }, data: { on: false } });
    await rejectsWith("backups off", () => runOffsiteBackup(a.shopId), /switched off/);
    await db.offsiteSettings.update({ where: { shopId: a.shopId }, data: { on: true } });
    const runs = await db.offsiteRun.count({ where: { shopId: a.shopId } });
    assert.equal(await runDueOffsiteBackups(new Date(now.getTime() + 3600_000)), 0, "an hour after a good run: nothing due");
    assert.equal(await db.offsiteRun.count({ where: { shopId: a.shopId } }), runs);
    const later = new Date(now.getTime() + 27 * 3600_000);
    assert.ok((await runDueOffsiteBackups(later)) >= 1, "27 hours on: due");
    ok("off means off; a company is due after a day, not an hour");

    // ---------- tenant ----------
    await rejectsWith("B has nothing set up", () => runOffsiteBackup(b.shopId), /isn't set up/);
    await db.offsiteSettings.create({ data: { shopId: b.shopId, on: true, target: "folder", folderPath: folderB, publicKey: key.publicKey.toString("base64"), keyId: keyIdOf(key.publicKey) } });
    const storeB = folderStore(folderB);
    const rb = await runOffsiteBackup(b.shopId, { now: new Date(Date.UTC(2026, 9, 21, 6)) });
    assert.equal(rb.photos, 1);
    assert.ok((await storeB.list()).every((f) => !f.name.includes(a.shopId)), "B's store names none of A's");
    const bFile = path.join(DIR, "b.stitchmove.ndjson.gz");
    const bi = await restoreToFile(storeB, key.privateKey, (await listBackups(storeB))[0].name, bFile);
    assert.equal(bi.shopId, b.shopId);
    assert.equal(bi.tables.Customer, 1);
    const bLines: Record<string, unknown>[] = [];
    for await (const l of readline.createInterface({ input: fs.createReadStream(bFile).pipe(zlib.createGunzip()) })) bLines.push(JSON.parse(l));
    assert.equal(bLines.filter((l) => l.shopId && l.shopId !== b.shopId).length, 0);
    assert.ok(!bLines.some((l) => l.id === cust.id), "none of A's customers in B's backup");
    const aIndex = await db.offsiteObject.findMany({ where: { shopId: a.shopId, kind: "photo" } });
    assert.ok(aIndex.every((o) => o.name.startsWith("photo/")) && !aIndex.some((o) => o.photoId === machB.id));
    await assert.rejects(testRecoveryKey("no-such-company", storeB, key.privateKey), isUserError);
    assert.ok(photoObjectName("MachinePhoto", "x", "abcdef0123456789ff").endsWith("x-abcdef0123456789"));
    ok("tenant: B's backup holds B's rows only, in B's store; A's index names none of B's; a company with nothing set up is refused");

    delete process.env.STITCH_DESKTOP;
    // A folder saved in the Windows program, now on the hosted server: the run fails, and says why on its row.
    await assert.rejects(runOffsiteBackup(a.shopId, { now: new Date(Date.UTC(2031, 0, 1, 6)) }), /folder is for the Windows program/);
    const folderRun = await db.offsiteRun.findFirstOrThrow({ where: { shopId: a.shopId }, orderBy: { startedAt: "desc" } });
    assert.equal(folderRun.status, "failed");
    assert.match(folderRun.error ?? "", /Pick StitchHub or your own bucket/);
    ok("a folder target on the hosted server: a failed run row says to pick StitchHub or a bucket");
    // ---------- the hub target, against a mock StitchHub and a mock bucket ----------
    const bucket = new Map<string, Buffer>();
    const objs = new Map<string, Map<string, { size: number; confirmed: boolean }>>(); // by company
    const calls: { path: string; shop: string | undefined; auth: string | undefined }[] = [];
    const KEY = "install-key-offsite-check";
    const CODE = "shr_check_restore_code";
    let hubDown = false;
    let full = false;
    let restoreShop = "";
    const bucketServer = http.createServer((req, res) => {
      const key = decodeURIComponent((req.url ?? "").split("?")[0]).slice(1);
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        if (req.method === "PUT") {
          bucket.set(key, Buffer.concat(chunks));
          res.writeHead(200).end();
        } else if (req.method === "GET") {
          const got = bucket.get(key);
          if (!got) res.writeHead(404).end();
          else res.writeHead(200, { "Content-Length": got.length }).end(got);
        } else res.writeHead(405).end();
      });
    });
    await new Promise<void>((r) => bucketServer.listen(0, "127.0.0.1", r));
    const bucketUrl = `http://127.0.0.1:${(bucketServer.address() as { port: number }).port}`;
    const mine = (shop: string) => objs.get(shop) ?? objs.set(shop, new Map()).get(shop)!;
    const json = (res: http.ServerResponse, status: number, body: unknown) => res.writeHead(status, { "Content-Type": "application/json" }).end(JSON.stringify(body));
    const hubServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const body = chunks.length ? JSON.parse(Buffer.concat(chunks).toString()) : {};
        const shop = req.headers["x-shop-ref"] as string | undefined;
        if (url.pathname === "/health") return json(res, 200, { ok: true });
        calls.push({ path: url.pathname, shop, auth: req.headers.authorization });
        if (hubDown) return json(res, 503, { error: "The hub is down." });
        if (url.pathname.startsWith("/v1/backup/restore/")) {
          if (body.code !== CODE) return json(res, 403, { error: "That restore code isn't right." });
          if (url.pathname.endsWith("/list")) {
            return json(res, 200, { shop: { shopRef: restoreShop, name: "Restored", kind: "both", program: "StitchBench" }, objects: [...mine(restoreShop)].filter(([, o]) => o.confirmed).map(([name, o]) => ({ name, size: o.size })) });
          }
          return json(res, 200, { url: `${bucketUrl}/${restoreShop}/${body.name}` });
        }
        if (req.headers.authorization !== `Bearer ${KEY}` || !shop) return json(res, 401, { error: "Sign in with the install key." });
        if (url.pathname === "/v1/backup/put") {
          if (full && String(body.name).startsWith("photo/")) return json(res, 413, { error: "This company's backup space is full." });
          mine(shop).set(body.name, { size: body.size, confirmed: false });
          return json(res, 200, { url: `${bucketUrl}/${shop}/${body.name}`, method: "PUT", expiresIn: 900 });
        }
        if (url.pathname === "/v1/backup/done") {
          const o = mine(shop).get(body.name);
          const stored = bucket.get(`${shop}/${body.name}`);
          if (!o || !stored || stored.length !== o.size) return json(res, 409, { error: "The object isn't in the backup store." });
          o.confirmed = true;
          return json(res, 200, { ok: true });
        }
        if (url.pathname === "/v1/backup/list") return json(res, 200, { objects: [...mine(shop)].filter(([, o]) => o.confirmed).map(([name, o]) => ({ name, size: o.size })) });
        if (url.pathname === "/v1/backup/get") return mine(shop).get(body.name)?.confirmed ? json(res, 200, { url: `${bucketUrl}/${shop}/${body.name}` }) : json(res, 404, { error: "That backup object isn't there." });
        if (url.pathname === "/v1/backup/delete") {
          mine(shop).delete(body.name);
          bucket.delete(`${shop}/${body.name}`);
          return json(res, 200, { ok: true });
        }
        json(res, 404, { error: "no such route" });
      });
    });
    await new Promise<void>((r) => hubServer.listen(0, "127.0.0.1", r));
    const hubUrl = `http://127.0.0.1:${(hubServer.address() as { port: number }).port}`;
    const savedHub = await db.hubState.findUnique({ where: { id: 1 } });
    try {
      await db.hubState.upsert({
        where: { id: 1 },
        create: { id: 1, url: hubUrl, installId: "check-install", installKey: KEY, joinedAt: new Date() },
        update: { url: hubUrl, installId: "check-install", installKey: KEY, joinedAt: new Date() },
      });
      await db.offsiteSettings.update({ where: { shopId: b.shopId }, data: { target: "hub", folderPath: "" } });
      await db.offsiteObject.deleteMany({ where: { shopId: b.shopId } });
      const hubRun = await runOffsiteBackup(b.shopId, { now: new Date(Date.UTC(2026, 9, 22, 6)) });
      assert.equal(hubRun.photos, 1);
      const keys = [...bucket.keys()].filter((k) => k.startsWith(`${b.shopId}/`));
      assert.equal(keys.length, 2, "the picture and the company file are in the bucket, under the company's own prefix");
      assert.ok(keys.every((k) => bucket.get(k)!.subarray(0, 6).toString() === "SBOB1\n"), "the bucket holds ciphertext only");
      assert.ok(calls.filter((c) => c.path.startsWith("/v1/backup/") && !c.path.includes("/restore/")).every((c) => c.shop === b.shopId && c.auth === `Bearer ${KEY}`), "every call names the company and carries the install key");
      assert.ok(![...bucket.keys()].some((k) => k.startsWith(`${a.shopId}/`)), "none of A's objects");
      const again = await runOffsiteBackup(b.shopId, { now: new Date(Date.UTC(2026, 9, 23, 6)) });
      assert.equal(again.photos, 0, "no picture is sent twice through the hub either");
      // a restore with a restore code from the hub, no install key
      restoreShop = b.shopId;
      const { hubCodeStore } = await import("@/lib/offsite/hub-store");
      const { store: codeStore, shop: codeShop } = await hubCodeStore(hubUrl, CODE);
      assert.equal(codeShop.shopRef, b.shopId);
      const dataNames = (await codeStore.list()).map((o) => o.name).filter((n) => n.startsWith("data/")).sort();
      assert.equal(dataNames.length, 2);
      const hubFile = path.join(DIR, "b-from-hub.stitchmove.ndjson.gz");
      const hr = await restoreToFile(codeStore, key.privateKey, dataNames.at(-1)!, hubFile, { moveToken: CODE });
      assert.equal(hr.photos, 1);
      assert.equal(hr.tables.Customer, 1);
      await assert.rejects(hubCodeStore(hubUrl, "shr_wrong"), /isn't right/);
      await assert.rejects(codeStore.put("data/x", Readable.from([Buffer.from("x")])), /only read/);
      // the hub refuses a picture (space full): the run fails in words and indexes nothing half done
      full = true;
      await db.machinePhoto.create({ data: { shopId: b.shopId, machineId: machB.id, mime: "image/jpeg", data: crypto.randomBytes(900) } });
      await assert.rejects(runOffsiteBackup(b.shopId, { now: new Date(Date.UTC(2026, 9, 24, 6)) }), /space is full/);
      const failedRun = await db.offsiteRun.findFirstOrThrow({ where: { shopId: b.shopId }, orderBy: { startedAt: "desc" } });
      assert.equal(failedRun.status, "failed");
      assert.match(failedRun.error ?? "", /space is full/);
      assert.equal(await db.offsiteObject.count({ where: { shopId: b.shopId, kind: "data" } }), 2, "no data file was indexed by the failed run");
      full = false;
      // the hub down: the run fails and is recorded; the next one carries on and sends what waited
      hubDown = true;
      await assert.rejects(runOffsiteBackup(b.shopId, { now: new Date(Date.UTC(2026, 9, 25, 6)) }));
      hubDown = false;
      const after = await runOffsiteBackup(b.shopId, { now: new Date(Date.UTC(2026, 9, 26, 6)) });
      assert.equal(after.photos, 1, "the picture that waited goes once there is room");
    } finally {
      if (savedHub) {
        const { id, ...data } = savedHub;
        void id;
        await db.hubState.update({ where: { id: 1 }, data }).catch(() => undefined);
      } else await db.hubState.deleteMany({ where: { id: 1 } }).catch(() => undefined);
      bucketServer.closeAllConnections?.();
      hubServer.closeAllConnections?.();
      bucketServer.close();
      hubServer.close();
    }
    ok("the hub target (mock hub and bucket): signed addresses, ciphertext only under the company's prefix, every call names the company, no picture twice, a restore code reads the store with no install key, a full store and a down hub fail the run in words");

    // ---------- the shop's own bucket (offsite-bucket): a stand-in that checks every signature on its own ----------
    process.env.OFFSITE_ALLOW_LOOPBACK = "1";
    const { seal } = await import("@/lib/messaging/secrets");
    const { checkEndpoint, isPrivate, presign } = await import("@/lib/offsite/s3");
    const { bucketStoreFor, bucketPrefix } = await import("@/lib/offsite/bucket-store");
    const BKEY = "OWNBUCKETKEY";
    const BSECRET = "own-bucket-secret";
    const own = new Map<string, Buffer>();
    const refusedSigs: string[] = [];
    const hm = (k: crypto.BinaryLike, d: string) => crypto.createHmac("sha256", k).update(d).digest();
    const enc2 = (s: string) => encodeURIComponent(s).replace(/[!'()*]/g, (c) => `%${c.charCodeAt(0).toString(16).toUpperCase()}`);
    const verifySig = (req: http.IncomingMessage, url: URL): string | null => {
      const q = url.searchParams;
      const [kid, date, region, svc, term] = (q.get("X-Amz-Credential") ?? "").split("/");
      if (kid !== BKEY || svc !== "s3" || term !== "aws4_request") return "credential";
      const stamp = q.get("X-Amz-Date") ?? "";
      const issued = Date.parse(`${stamp.slice(0, 4)}-${stamp.slice(4, 6)}-${stamp.slice(6, 8)}T${stamp.slice(9, 11)}:${stamp.slice(11, 13)}:${stamp.slice(13, 15)}Z`);
      if (Date.now() > issued + Number(q.get("X-Amz-Expires")) * 1000 || Number(q.get("X-Amz-Expires")) > 3600) return "expired";
      const params = [...q.entries()].filter(([k]) => k !== "X-Amz-Signature").sort(([x], [y]) => (x < y ? -1 : 1));
      const canon = [req.method, url.pathname.split("/").map((s) => enc2(decodeURIComponent(s))).join("/"), params.map(([k, v]) => `${enc2(k)}=${enc2(v)}`).join("&"), `host:${req.headers.host}\n`, q.get("X-Amz-SignedHeaders"), "UNSIGNED-PAYLOAD"].join("\n");
      const toSign = ["AWS4-HMAC-SHA256", stamp, `${date}/${region}/s3/aws4_request`, crypto.createHash("sha256").update(canon).digest("hex")].join("\n");
      const want = crypto.createHmac("sha256", hm(hm(hm(hm(`AWS4${BSECRET}`, date), region), "s3"), "aws4_request")).update(toSign).digest("hex");
      return want === q.get("X-Amz-Signature") ? null : "signature";
    };
    const ownServer = http.createServer((req, res) => {
      const url = new URL(req.url ?? "/", "http://x");
      const chunks: Buffer[] = [];
      req.on("data", (c) => chunks.push(c));
      req.on("end", () => {
        const bad = verifySig(req, url);
        if (bad) {
          refusedSigs.push(bad);
          return res.writeHead(403, { "Content-Type": "application/xml" }).end("<Error><Code>SignatureDoesNotMatch</Code></Error>");
        }
        const rest = decodeURIComponent(url.pathname).replace(/^\/mybucket\/?/, "");
        if (req.method === "GET" && url.searchParams.get("list-type") === "2") {
          const prefix = url.searchParams.get("prefix") ?? "";
          const all = [...own].filter(([k]) => k.startsWith(prefix)).sort(([x], [y]) => (x < y ? -1 : 1));
          const from = Number(url.searchParams.get("continuation-token") ?? 0);
          const page = all.slice(from, from + 2); // two a page, to make it follow the token
          const more = from + 2 < all.length;
          return res.writeHead(200, { "Content-Type": "application/xml" }).end(
            `<?xml version="1.0"?><ListBucketResult><IsTruncated>${more}</IsTruncated>${more ? `<NextContinuationToken>${from + 2}</NextContinuationToken>` : ""}${page
              .map(([k, v]) => `<Contents><Key>${k.replace(/&/g, "&amp;")}</Key><Size>${v.length}</Size></Contents>`)
              .join("")}</ListBucketResult>`,
          );
        }
        if (req.method === "PUT") {
          own.set(rest, Buffer.concat(chunks));
          return res.writeHead(200).end();
        }
        if (req.method === "GET") {
          const got = own.get(rest);
          return got ? res.writeHead(200, { "Content-Length": got.length }).end(got) : res.writeHead(404).end();
        }
        if (req.method === "DELETE") {
          own.delete(rest);
          return res.writeHead(204).end();
        }
        res.writeHead(405).end();
      });
    });
    await new Promise<void>((r) => ownServer.listen(0, "127.0.0.1", r));
    const ownUrl = `http://127.0.0.1:${(ownServer.address() as { port: number }).port}`;
    try {
      const mk = (secret: string) => ({ endpoint: ownUrl, bucket: "mybucket", region: "auto", accessKeyId: BKEY, secretSealed: seal(secret, a.shopId, "offsiteBucket") });
      // A's own bucket and B's, the same one: each company writes under its own prefix
      await db.offsiteSettings.update({ where: { shopId: a.shopId }, data: { target: "bucket", bucket: mk(BSECRET), on: true } });
      await db.offsiteObject.deleteMany({ where: { shopId: a.shopId } });
      const runA = await runOffsiteBackup(a.shopId, { now: new Date(Date.UTC(2026, 10, 1, 6)) });
      assert.equal(runA.photos, 2, "both of A's pictures sent");
      assert.ok([...own.keys()].every((k) => k.startsWith(bucketPrefix(a.shopId))), "everything is under the company's prefix");
      assert.ok([...own.values()].every((v) => v.subarray(0, 6).toString() === "SBOB1\n"), "the bucket holds ciphertext only");
      assert.equal(refusedSigs.length, 0, `the bucket took every address: ${refusedSigs}`);
      const sA = await bucketStoreFor(a.shopId, (await db.offsiteSettings.findUniqueOrThrow({ where: { shopId: a.shopId } })).bucket);
      for (let i = 0; i < 5; i++) await sA.put(`data/2026-09-0${i + 1}-020000.sbob`, Readable.from([Buffer.from(`x${i}`)])); // more than a page of two
      const listed = await sA.list();
      assert.equal(listed.length, 8, "listing follows the continuation token (two a page, eight objects)");
      assert.deepEqual(listed.map((o) => o.name).sort(), [...own.keys()].map((k) => k.slice(bucketPrefix(a.shopId).length)).sort(), "names come back without the prefix");
      // restore from it
      const ownLatest = (await listBackups(sA))[0].name;
      const fromBucket = await restoreToFile(sA, key.privateKey, ownLatest, path.join(DIR, "a-from-bucket.stitchmove.ndjson.gz"));
      assert.equal(fromBucket.photos, 2);
      assert.equal(fromBucket.tables.Customer, 1);
      // B in the same bucket sees none of A's
      await db.offsiteSettings.update({ where: { shopId: b.shopId }, data: { target: "bucket", bucket: { ...mk(BSECRET), secretSealed: seal(BSECRET, b.shopId, "offsiteBucket") } } });
      const sB = await bucketStoreFor(b.shopId, (await db.offsiteSettings.findUniqueOrThrow({ where: { shopId: b.shopId } })).bucket);
      assert.deepEqual(await sB.list(), [], "B lists nothing of A's");
      await assert.rejects(sB.get("data/2026-09-01-020000.sbob"), /isn't in the bucket/);
      // A's secret copied into B's row doesn't open (sealed to the company), a wrong secret is refused by the bucket in words
      await db.offsiteSettings.update({ where: { shopId: b.shopId }, data: { bucket: { ...mk(BSECRET) } } });
      await assert.rejects(bucketStoreFor(b.shopId, (await db.offsiteSettings.findUniqueOrThrow({ where: { shopId: b.shopId } })).bucket), /can't be read here/);
      await db.offsiteSettings.update({ where: { shopId: a.shopId }, data: { bucket: mk("wrong-secret") } });
      const bad = await bucketStoreFor(a.shopId, (await db.offsiteSettings.findUniqueOrThrow({ where: { shopId: a.shopId } })).bucket);
      await assert.rejects(bad.list(), /refused the listing \(403 SignatureDoesNotMatch\)/);
      assert.ok(refusedSigs.includes("signature"));
      // what a shop may point it at
      delete process.env.OFFSITE_ALLOW_LOOPBACK;
      await assert.rejects(checkEndpoint("http://s3.example.com"), /https/);
      await assert.rejects(checkEndpoint("https://127.0.0.1"), /name address/);
      await assert.rejects(checkEndpoint("https://localhost:9000"), /this computer/);
      await assert.rejects(checkEndpoint("https://printer.local"), /this computer/);
      await assert.rejects(checkEndpoint("https://user:pw@s3.example.com"), /user name and password/);
      await assert.rejects(checkEndpoint("not a url"), /should look like/);
      assert.equal(await checkEndpoint("https://192.168.1.20:9000", { allowPrivate: true }), "https://192.168.1.20:9000", "a NAS on the shop's own PC network is allowed on the PC");
      for (const ip of ["10.0.0.1", "127.0.0.1", "169.254.169.254", "172.16.5.5", "192.168.0.1", "100.64.0.1", "::1", "fd00::1", "fe80::1", "::ffff:10.1.1.1"]) assert.ok(isPrivate(ip), `${ip} is private`);
      for (const ip of ["8.8.8.8", "1.1.1.1", "2606:4700::1111"]) assert.ok(!isPrivate(ip), `${ip} is public`);
      // the presigned address is for one method and key (the bucket stand-in checks), and expires
      const cfg = { endpoint: ownUrl, bucket: "mybucket", region: "auto", accessKeyId: BKEY, secret: BSECRET, prefix: "" };
      assert.equal((await fetch(presign(cfg, "GET", "x/y", { now: new Date(Date.now() - 2 * 3600_000), expires: 600 }))).status, 403, "an address that has run out is refused");
      assert.equal((await fetch(presign(cfg, "PUT", "x/y"), { method: "GET" })).status, 403, "a PUT address can't read");
    } finally {
      process.env.OFFSITE_ALLOW_LOOPBACK = "1";
      ownServer.closeAllConnections?.();
      ownServer.close();
      delete process.env.OFFSITE_ALLOW_LOOPBACK;
    }
    ok("the shop's own bucket: signed addresses a stand-in verifies on its own, a company's own prefix, ciphertext only, the listing follows its pages, restore from it, another company in the same bucket sees nothing, a secret sealed to its company, a wrong secret said in words, the address held to https and a public name on a server");

    console.log(`\n${steps} offsite checks passed`);
  } finally {
    if (saved.desktop !== undefined) process.env.STITCH_DESKTOP = saved.desktop;
    await cleanup();
    fs.rmSync(DIR, { recursive: true, force: true });
    await removeCompany(a.shopId).catch(() => {});
  }
}

main()
  .then(() => process.exit(0))
  .catch((e) => {
    console.error(e);
    process.exit(1);
  });
