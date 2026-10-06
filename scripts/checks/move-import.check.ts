// Moving a company in (company-move-design.md, package move-import): company A, with a row in every table that moves,
// is exported with package 1's exportCompany, deleted, and imported again: every table's rows are the originals (ids,
// values, Bytes) but for what the import changes on purpose (secrets null, email / texts / online shop off, marketing
// held, the move marks). Then the refusals, each with nothing written: the company already here, not a move file, a
// newer file version, this database behind the file, a row of another
// company, a child without its parent, a column this version doesn't know (named), counts that don't match, no end
// line, a cut file, lines after the end, rows out of order. The hosted door (8 MB parts, resume, out-of-step parts, the
// import in the background, the booking address cleared on a clash, the spool file gone) and the Windows program's door
// (the one-use token, one company per PC unless platformAdminEmails); company B untouched throughout; tenant: a
// non-administrator can't reach the hosted import, another company's administrator can't see or touch the upload.
//   npm run check scripts/checks/move-import.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import os from "node:os";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadable } from "node:stream/web";
import { db } from "@/lib/db";
import { isUserError } from "@/lib/action";
import { seal } from "@/lib/messaging/secrets";
import { encodeRow, MOVE_TABLES, MOVE_VERSION, shopFilterSql, UPLOAD_CHUNK, type MoveEnd, type MoveMeta, type MoveTable } from "@/lib/move/format";
import { exportCompany } from "@/lib/move/export";
import { importCompany, ONE_COMPANY, ONLY_ADMIN, spoolDir } from "@/lib/move/import";
import { importJob, type ImportJob } from "@/lib/move/import-jobs";
import { discardUpload, finishUpload, IMPORT_NOT_FOUND, putChunk, recentImports, startUpload, uploadView } from "@/lib/move/upload";
import { DOOR_SHUT, moveToken, pcImportOpen, startPcImport, takeMoveToken } from "@/lib/move/local";
import type { CurrentUser } from "@/lib/session";
import { ownKey } from "@/lib/partner-keys";
import { checkShop, cleanup, linkPair, messagingFor, withMock, withSink, type CheckShop } from "./lib";
import { removeCompany, RUN } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));
const DIR = fs.mkdtempSync(path.join(os.tmpdir(), "move-import-check-"));
let fileNo = 0;
/** The check's uploads, whose spool files (the sidecar is kept a day by design) it removes at the end. */
const uploads: string[] = [];

type Row = Record<string, unknown>;

/** A file in the check's own temp folder. */
function put(buf: Buffer, name = `f${(fileNo += 1)}.stitchmove.ndjson.gz`): string {
  const f = path.join(DIR, name);
  fs.writeFileSync(f, buf);
  return f;
}

async function toBuffer(stream: ReadableStream<Uint8Array>): Promise<Buffer> {
  const chunks: Buffer[] = [];
  for await (const c of Readable.fromWeb(stream as unknown as WebReadable)) chunks.push(Buffer.from(c as Uint8Array));
  return Buffer.concat(chunks);
}

/** The file's lines as text (without the trailing newline), and back. */
const linesOf = (raw: Buffer) => zlib.gunzipSync(raw).toString("utf8").replace(/\n$/, "").split("\n");
const pack = (lines: string[]) => zlib.gzipSync(Buffer.from(lines.join("\n") + "\n"));

/** One table's rows of a company, as the file writes them (encodeRow: Bytes base64, dates ISO, left-out columns null). */
async function tableRows(t: MoveTable, shopId: string): Promise<Row[]> {
  const rows = await db.$queryRawUnsafe<Row[]>(`SELECT *, (${t.key}) AS _k FROM "${t.t}" WHERE ${shopFilterSql(t)} ORDER BY (${t.key})`, shopId);
  return rows.map(({ _k, ...r }) => {
    void _k;
    return JSON.parse(JSON.stringify(encodeRow(t, r))) as Row;
  });
}

async function companyRows(shopId: string): Promise<Record<string, Row[]>> {
  const out: Record<string, Row[]> = {};
  for (const t of MOVE_TABLES) out[t.t] = await tableRows(t, shopId);
  return out;
}

/** Every moved table's whole row count (all companies) and CompanyMove's: unchanged means nothing was written. */
async function counts(): Promise<Record<string, number>> {
  const out: Record<string, number> = {};
  for (const t of [...MOVE_TABLES.map((x) => x.t), "CompanyMove"]) {
    out[t] = (await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${t}"`))[0].n;
  }
  return out;
}

async function expectUserError(label: string, fn: () => Promise<unknown>, re: RegExp): Promise<string> {
  try {
    await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return (e as Error).message;
  }
  assert.fail(`${label}: no error`);
}

async function waitJob(id: string): Promise<ImportJob> {
  for (let i = 0; i < 1200; i += 1) {
    const j = importJob(id);
    if (j && (j.status === "done" || j.status === "failed")) return j;
    await sleep(100);
  }
  assert.fail(`import job ${id} didn't finish`);
}

function withEnv<T>(vars: Record<string, string | undefined>, fn: () => Promise<T>): Promise<T> {
  const saved: Record<string, string | undefined> = {};
  for (const k of Object.keys(vars)) {
    saved[k] = process.env[k];
    if (vars[k] === undefined) delete process.env[k];
    else process.env[k] = vars[k];
  }
  return fn().finally(() => {
    for (const k of Object.keys(saved)) {
      if (saved[k] === undefined) delete process.env[k];
      else process.env[k] = saved[k];
    }
  });
}

/** A row in every table that moves, for company A (linked to B as its partner). */
async function seed(a: CheckShop, b: CheckShop, bigPhoto: Buffer) {
  const shopId = a.shopId;
  const now = Date.now();
  const day = 86_400_000;
  await messagingFor(shopId, { email: true, sms: true, settings: { testPhones: ["+12125550111"] } });
  const tech = await db.user.create({ data: { shopId, email: `move-tech-${RUN}@stitchbench.test`, name: "Tess Tech", role: "TECH", passwordHash: "$2b$10$abcdefghijklmnopqrstuv" } });
  const cust = await db.customer.create({ data: { shopId, name: "Mona Mover", email: "mona@example.test", phone: "555-0199" } });
  const account = await db.customer.create({ data: { shopId, name: "Dealer Account" } });
  const machine = await db.machine.create({ data: { shopId, customerId: cust.id, brand: "Bernina", model: "770 QE", modelKey: "770qe", details: { bobbin: "B9" } } });
  const stockMachine = await db.machine.create({ data: { shopId, brand: "Miele", model: "C3", modelKey: "c3" } });
  await db.modelNote.create({ data: { shopId, brand: "Bernina", modelKey: "770qe", modelLabel: "Bernina 770 QE", body: "Hook timing drifts.", authorId: a.user.id } });
  await db.shopEquipmentKind.create({
    data: { shopId, key: `espresso-${RUN}`, label: "Espresso machine", types: ["Lever"], brands: ["Gaggia"], accessories: ["Portafilter"], defaultChecked: [], checklist: ["Descale"] },
  });
  const part = await db.part.create({ data: { shopId, partNumber: "MV-100", description: "Hook", numberKeys: ["MV100"], qtyOnHand: 3, priceCents: 4500 } });
  await db.partSource.create({ data: { partId: part.id, vendor: "Sewing Parts Online" } });
  const ticket = await db.ticket.create({
    data: { shopId, number: 9001, status: "ON_BENCH", machineId: machine.id, customerId: cust.id, viaAccountId: account.id, techId: tech.id, openedById: a.user.id, intake: { issue: "skips" } },
  });
  await db.ticketLine.create({ data: { ticketId: ticket.id, kind: "PART", description: "Hook", unitPriceCents: 4500, partId: part.id } });
  await db.payment.create({ data: { ticketId: ticket.id, method: "CASH", amountCents: 5000 } });
  await db.ticketSite.create({ data: { ticketId: ticket.id, shopId, address: "1 Main St", startsAt: new Date(now + day) } });
  await db.partWait.create({ data: { shopId, ticketId: ticket.id, partId: part.id, description: "Hook" } });
  await db.stockMove.create({ data: { shopId, partId: part.id, qty: 3, reason: "RECEIVED", userId: a.user.id } });
  await db.machinePhoto.create({ data: { shopId, machineId: machine.id, ticketId: ticket.id, mime: "image/jpeg", data: crypto.randomBytes(3000) } });
  // A photo bigger than one upload part, so the hosted door's file is two parts.
  await db.machinePhoto.create({ data: { shopId, machineId: machine.id, mime: "image/jpeg", data: new Uint8Array(bigPhoto) } });
  await db.partPhoto.create({ data: { shopId, partId: part.id, mime: "image/jpeg", data: crypto.randomBytes(500) } });
  const post = await db.sharedPost.create({
    data: { shopId, authorId: a.user.id, brand: "Bernina", model: "770 QE", modelKey: "770qe", title: "Hook timing", body: "Check it.", hubId: `hub-${RUN}-${crypto.randomBytes(4).toString("hex")}` },
  });
  await db.sharedPhoto.create({ data: { postId: post.id, kind: "CONDITION", mime: "image/jpeg", data: crypto.randomBytes(700) } });
  const sale = await db.sale.create({
    data: { shopId, number: 7001, subtotalCents: 4500, taxCents: 0, totalCents: 4500, taxRatePct: 0, customerId: cust.id, userId: a.user.id, tenders: [{ method: "CASH", cents: 4500 }] },
  });
  await db.saleLine.create({ data: { saleId: sale.id, partId: part.id, description: "Hook", qty: 1, unitPriceCents: 4500 } });
  await db.stockUnit.create({ data: { shopId, machineId: stockMachine.id, priceCents: 29900, events: [{ at: new Date(now).toISOString(), note: "in" }] } });
  await db.vacCare.create({ data: { machineId: machine.id, shopId, contactNote: "Called" } });
  const linkId = await linkPair(shopId, b.shopId);
  await ownKey(shopId); // the company's partner signing key (its private half stays behind in a move)
  await db.partnerOutbox.create({ data: { shopId, linkId, type: "job.update", data: { status: "ON_BENCH" } } });
  await db.repairJob.create({
    data: {
      id: `rj${RUN}`,
      shopId,
      linkId,
      side: "repair",
      tag: "T-1",
      customerName: "Mona M.",
      brand: "Bernina",
      model: "770 QE",
      accessories: ["Foot pedal"],
      customerId: cust.id,
      machineId: machine.id,
    },
  });
  await db.partnerOrder.create({ data: { id: `po${RUN}`, shopId, linkId, side: "seller", number: "PO-1", lines: [{ itemKey: "MV-100", qty: 1 }], totalCents: 4500 } });
  await db.consignItem.create({ data: { shopId, linkId, side: "owner", itemKey: "MV-100", partNumber: "MV-100", description: "Hook", priceCents: 4500 } });
  await db.consignSale.create({ data: { id: `cs${RUN}`, shopId, linkId, itemKey: "MV-100", qty: 1.5, priceCents: 4500, soldAt: new Date(now - day) } });
  await db.settlement.create({ data: { id: `st${RUN}`, shopId, linkId, periodFrom: new Date(now - 30 * day), periodTo: new Date(now), netCents: -1200, summary: { lines: 2 } } });
  await db.partnerSeen.create({ data: { shopId, key: `${linkId}:1` } });
  await db.partnerFailure.create({ data: { shopId, key: `${linkId}:2`, linkId, type: "job.update", data: { x: 1 }, error: "bad" } });
  await db.partnerRun.create({ data: { id: `pr${RUN}`, shopId, linkId, ownerSide: "repair", startsAt: new Date(now + day), collect: [`rj${RUN}`], deliver: [], collected: [], delivered: [] } });
  await db.moduleGrant.create({ data: { shopId, module: "vac", mode: "on", byEmail: "admin@stitchbench.test", note: "trial" } });
  const campaign = await db.campaign.create({ data: { shopId, name: "Fall sale", channel: "email", body: "Hello", audience: { all: true } } });
  await db.outMessage.create({
    data: { shopId, customerId: cust.id, channel: "email", purpose: "notice", kind: "ready", address: "mona@example.test", body: "Ready.", status: "SENT", ticketId: ticket.id, sentAt: new Date(now) },
  });
  // Claimed for sending when the company moved: marketing is cancelled, a notice goes back to the queue.
  await db.outMessage.create({
    data: {
      shopId,
      customerId: cust.id,
      campaignId: campaign.id,
      channel: "email",
      purpose: "marketing",
      kind: "campaign",
      address: "mona@example.test",
      body: "Sale!",
      status: "SENDING",
      claimedAt: new Date(now),
      optOutToken: crypto.randomBytes(16).toString("hex"),
    },
  });
  await db.outMessage.create({
    data: {
      shopId,
      customerId: cust.id,
      channel: "sms",
      purpose: "notice",
      kind: "ready",
      address: "+12125550123",
      body: "Ready.",
      status: "SENDING",
      claimedAt: new Date(now),
      nextTryAt: new Date(now),
    },
  });
  await db.suppression.create({ data: { shopId, channel: "email", address: "gone@example.test", scope: "marketing", source: "link" } });
  await db.consentEvent.create({ data: { shopId, customerId: cust.id, channel: "email", event: "marketing_yes", source: "counter" } });
  await db.inboundText.create({ data: { shopId, sid: `SM${crypto.randomBytes(16).toString("hex")}`, fromNumber: "+12125550123", body: "Thanks", receivedAt: new Date(now - day) } });
  await db.estimateLink.create({
    data: {
      shopId,
      ticketId: ticket.id,
      tokenHash: crypto.randomBytes(16).toString("hex"),
      tokenSealed: seal("tok", shopId, "estimateToken:chk"),
      maskedUrl: "https://x/e/•••abcd",
      totalCents: 9800,
      lines: [{ description: "Full service", amountCents: 9800 }],
      expiresAt: new Date(now + 5 * day),
    },
  });
  const cls = await db.shopClass.create({ data: { shopId, title: "Quilting 101", seats: 8 } });
  await db.classMeeting.create({ data: { shopId, classId: cls.id, startsAt: new Date(now + 2 * day), endsAt: new Date(now + 2 * day + 7_200_000) } });
  await db.enrollment.create({ data: { shopId, classId: cls.id, name: "Mona Mover", feeCents: 5000, customerId: cust.id } });
  const type = await db.appointmentType.create({ data: { shopId, name: "Machine pickup" } });
  await db.appointment.create({
    data: {
      shopId,
      name: "Mona Mover",
      title: "Machine pickup",
      startsAt: new Date(now + 3 * day),
      endsAt: new Date(now + 3 * day + 1_800_000),
      typeId: type.id,
      customerId: cust.id,
      staffId: tech.id,
    },
  });
  await db.shift.create({ data: { shopId, name: "Tess Tech", startsAt: new Date(now + day), endsAt: new Date(now + day + 28_800_000), userId: tech.id } });
  await db.bookingLink.create({ data: { shopId, tokenHash: crypto.randomBytes(16).toString("hex"), expiresAt: new Date(now + day), customerId: cust.id } });
  await db.webOrder.create({
    data: {
      shopId,
      number: 1001,
      name: "Mona Mover",
      subtotalCents: 4500,
      taxCents: 0,
      totalCents: 4500,
      tokenHash: crypto.randomBytes(16).toString("hex"),
      linkSealed: seal("https://x/o/abc", shopId, "orderLink:chk"),
      stripeSessionId: `cs_test_${crypto.randomBytes(8).toString("hex")}`,
      items: [{ partId: part.id, qty: 1 }],
    },
  });
  await db.shop.update({
    where: { id: shopId },
    data: {
      bookingSlug: `move-${RUN}`.toLowerCase(),
      shopOn: true,
      shopPayVia: "own",
      stripeKeySealed: seal("sk_test_x", shopId, "stripeKey"),
      stripeWebhookSealed: seal("whsec_x", shopId, "stripeWebhook"),
    },
  });
  // B has rows of its own, which nothing here may touch.
  const bCust = await db.customer.create({ data: { shopId: b.shopId, name: "Bea Bystander", email: "bea@example.test" } });
  const bMachine = await db.machine.create({ data: { shopId: b.shopId, customerId: bCust.id, brand: "Janome", model: "MC6700P", modelKey: "mc6700p" } });
  await db.ticket.create({ data: { shopId: b.shopId, number: 9001, status: "ON_BENCH", machineId: bMachine.id, customerId: bCust.id, intake: {} } });
  await db.machinePhoto.create({ data: { shopId: b.shopId, machineId: bMachine.id, mime: "image/jpeg", data: crypto.randomBytes(400) } });
}

async function main() {
  await withSink();
  await withMock();
  const a = await checkShop({ retail: true, repair: true, modules: ["marketing", "scheduling"] });
  const b = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
  const c = await checkShop({ repair: true });
  const original = { admins: process.env.PLATFORM_ADMIN_EMAILS, desktop: process.env.STITCH_DESKTOP, secret: process.env.MOVE_LOCAL_SECRET };
  delete process.env.STITCH_DESKTOP;
  delete process.env.MOVE_LOCAL_SECRET;
  const asUser = (s: CheckShop): CurrentUser => s.user;
  try {
    // ---------- 1. the fixture: a row in every table that moves ----------
    const bigPhoto = crypto.randomBytes(UPLOAD_CHUNK + 512 * 1024);
    await seed(a, b, bigPhoto);
    const before = await companyRows(a.shopId);
    for (const t of MOVE_TABLES) assert.ok(before[t.t].length > 0, `the fixture has a ${t.t} row`);
    const bBefore = await companyRows(b.shopId);
    ok(`company A has rows in all ${MOVE_TABLES.length} tables that move (a ${(bigPhoto.length / 1024 / 1024).toFixed(1)} MB photo among them); B has its own`);

    // ---------- 2. export, delete, import: every row comes back ----------
    const ex = await exportCompany(asUser(a), a.shopId);
    const raw = await toBuffer(ex.stream);
    const file = put(raw, ex.fileName);
    const lines = linesOf(raw);
    const meta = JSON.parse(lines[0]) as MoveMeta;
    const end = JSON.parse(lines[lines.length - 1]) as MoveEnd;
    assert.equal(meta.shop.id, a.shopId);
    assert.equal(end.t, "end");
    assert.ok(raw.length > UPLOAD_CHUNK, "the file is more than one upload part");
    await removeCompany(a.shopId);
    assert.equal(await db.shop.count({ where: { id: a.shopId } }), 0, "A is gone");
    // Deleting a company leaves the rows of the two tables without a foreign key to Shop; the import replaces them.
    const loose = ["PartnerSeen", "PartnerFailure"];
    for (const t of MOVE_TABLES) assert.equal((await tableRows(t, a.shopId)).length, loose.includes(t.t) ? before[t.t].length : 0, `${t.t} rows of A left after the delete`);
    const progress: string[] = [];
    const t0 = Date.now();
    const summary = await importCompany(file, { by: "operator", onProgress: (p) => progress.push(p.phase) });
    assert.ok(progress.includes("checking") && progress.includes("importing"), "both passes reported progress");
    assert.equal(summary.shopId, a.shopId);
    assert.equal(summary.shopName, a.name);
    assert.equal(summary.rows, end.rows);
    assert.deepEqual(summary.tables, end.tables, "the summary's counts are the file's");
    assert.deepEqual(summary.owners, [a.user.email]);
    const after = await companyRows(a.shopId);
    // What the import changes on purpose (design 3 and 4); everything else is the original, id for id.
    const expect = structuredClone(before);
    Object.assign(expect.Shop[0], { shopOn: false });
    Object.assign(expect.PartnerKey[0], { privateSealed: null }); // the sealed private key is left out of the file
    const ms = after.MessagingSettings[0];
    assert.ok(typeof ms.marketingHoldAt === "string" && Date.parse(ms.marketingHoldAt) >= t0 - 1000, "marketing is held");
    Object.assign(expect.MessagingSettings[0], { emailOn: false, smsOn: false, marketingHoldAt: ms.marketingHoldAt, inboundAt: null, inboundIncomplete: 0 });
    for (const m of expect.OutMessage) {
      if (m.status !== "SENDING") continue;
      if (m.purpose === "marketing") Object.assign(m, { status: "CANCELLED", error: "Not sent: the company moved while it was being sent (it may have gone out already)" });
      else Object.assign(m, { status: "QUEUED", claimedAt: null, nextTryAt: null });
    }
    for (const t of MOVE_TABLES) assert.deepEqual(after[t.t], expect[t.t], `${t.t}: the rows that came back are the originals`);
    const photo = await db.machinePhoto.findFirstOrThrow({ where: { shopId: a.shopId, data: { equals: bigPhoto } }, select: { id: true } });
    assert.ok(photo.id, "the big photo's bytes came back byte for byte");
    // The secrets stay behind; the channels that need them are off.
    const shop = await db.shop.findUniqueOrThrow({ where: { id: a.shopId } });
    assert.equal(shop.stripeKeySealed, null);
    assert.equal(shop.stripeWebhookSealed, null);
    assert.equal(shop.shopOn, false);
    assert.equal(shop.bookingSlug, `move-${RUN}`.toLowerCase(), "the booking address is kept when nobody here has it");
    assert.ok(shop.movedInAt && shop.movedInAt.getTime() >= t0 - 1000, "Shop.movedInAt set");
    assert.match(shop.movedFrom ?? "", /^Stitch(Bench|Shop).*exported \d{4}-\d{2}-\d{2}$/);
    assert.equal(shop.movingAt, null);
    const msRow = await db.messagingSettings.findUniqueOrThrow({ where: { shopId: a.shopId } });
    assert.equal(msRow.smtpPassSealed, null);
    assert.equal((await db.partnerKey.findUniqueOrThrow({ where: { shopId: a.shopId } })).privateSealed, null, "the partner signing key's private half stays behind");
    assert.ok((await ownKey(a.shopId)).privateKey, "and the company makes a new key when it next needs one");
    assert.equal(msRow.twilioTokenSealed, null);
    assert.equal(msRow.emailOn, false);
    assert.equal(msRow.smsOn, false);
    assert.ok(msRow.smtpHost && msRow.twilioSid, "the rest of the message settings came");
    assert.equal((await db.estimateLink.findFirstOrThrow({ where: { shopId: a.shopId } })).tokenSealed, null);
    assert.equal((await db.webOrder.findFirstOrThrow({ where: { shopId: a.shopId } })).linkSealed, null);
    const moved = await db.companyMove.findMany({ where: { shopId: a.shopId } });
    assert.equal(moved.length, 1);
    assert.equal(moved[0].direction, "import");
    assert.equal(moved[0].status, "done");
    assert.equal(moved[0].rowsDone, end.rows);
    assert.equal(Number(moved[0].bytes), raw.length);
    assert.ok(summary.reenter.some((r) => /mail password/.test(r)));
    assert.ok(summary.reenter.some((r) => /Twilio/.test(r)));
    assert.ok(summary.reenter.some((r) => /Stripe/.test(r)));
    assert.ok(summary.reenter.some((r) => /^1 estimate link still waiting/.test(r)));
    assert.ok(summary.reenter.some((r) => /signs in again/.test(r)));
    assert.ok(summary.notes.some((r) => /marketing is on hold/.test(r)));
    assert.ok(
      summary.notes.some((r) => /StitchHub/.test(r)),
      "partner links: the hub step is said",
    );
    assert.equal(summary.bookingSlugCleared, null);
    assert.deepEqual(summary.warnings, meta.warnings, "the export's warnings are passed on");
    ok(
      "export, delete, import: every table's rows are the originals (ids, values, Bytes); secrets null; email, texts and the online shop off; marketing held; moved-in marks and record; the summary says what to enter again",
    );

    // ---------- 3. the company already here ----------
    const snapA = await companyRows(a.shopId);
    let n0 = await counts();
    await expectUserError("same company", () => importCompany(file, { by: "operator" }), new RegExp(`The company "${a.name}" \\(${a.shopId}\\) is already on this install\\. A move never merges`));
    assert.deepEqual(await counts(), n0, "nothing written");
    assert.deepEqual(await companyRows(a.shopId), snapA, "A unchanged");
    ok("a company already here is refused (a move never merges); nothing written");

    // ---------- 4. the refusals, each with nothing written ----------
    await removeCompany(a.shopId);
    n0 = await counts();
    const refuse = async (label: string, buf: Buffer, re: RegExp) => {
      const msg = await expectUserError(label, () => importCompany(put(buf), { by: "operator" }), re);
      assert.deepEqual(await counts(), n0, `${label}: nothing written`);
      assert.equal(await db.shop.count({ where: { id: a.shopId } }), 0, `${label}: no company`);
      return msg;
    };
    const edit = (fn: (l: string[]) => void) => {
      const l = [...lines];
      fn(l);
      return pack(l);
    };
    const at = (l: string[], t: string, k = 0) => {
      const i = l.findIndex((x, j) => j > 0 && x.startsWith(`{"t":"${t}"`) && k-- === 0);
      assert.ok(i > 0, `a ${t} line`);
      return i;
    };
    const change = (l: string[], t: string, fn: (r: Row) => void) => {
      const i = at(l, t);
      const r = JSON.parse(l[i]) as Row;
      fn(r);
      l[i] = JSON.stringify(r);
    };
    await refuse("not gzipped", Buffer.from(lines.join("\n")), /isn't a StitchBench move file/);
    await refuse("another format", pack([JSON.stringify({ t: "meta", format: "something-else", version: 1 })]), /isn't a StitchBench move file/);
    await refuse(
      "newer file version",
      edit((l) => (l[0] = JSON.stringify({ ...meta, version: MOVE_VERSION + 1 }))),
      new RegExp(`made by a newer program \\(move file version ${MOVE_VERSION + 1}; this one reads version ${MOVE_VERSION}\\)\\. Update this program first`),
    );
    await refuse(
      "this database behind",
      edit((l) => (l[0] = JSON.stringify({ ...meta, lastMigration: "29991231235959_from_the_future" }))),
      /taken at database version 29991231235959_from_the_future, which this program doesn't have \(it is at \d{14}_\w+\)\. Update this program first/,
    );
    // Round 3 W1: a login email is unique inside one company, so a file whose login has the address of a login in another
    // company here imports, and the other company's login is untouched (people in both choose a company at sign-in).
    const sameEmail = edit((l) => change(l, "User", (r) => (r.email = b.user.email)));
    const bLoginBefore = await db.user.findUniqueOrThrow({ where: { id: b.user.id } });
    const sameSummary = await importCompany(put(sameEmail), { by: "operator" });
    assert.equal(sameSummary.shopId, a.shopId, "a login email used by another company no longer refuses the import");
    assert.equal(await db.user.count({ where: { email: b.user.email } }), 2, "the address now has a login in two companies");
    assert.deepEqual(await db.user.findUniqueOrThrow({ where: { id: b.user.id } }), bLoginBefore, "the other company's login is untouched");
    await removeCompany(a.shopId);
    n0 = await counts();
    // A login with a reserved (platform administrator) address would make an administrator on import: refused.
    const adminAddr = `move-admin-${RUN}@stitchbench.test`;
    process.env.PLATFORM_ADMIN_EMAILS = adminAddr;
    try {
      await refuse("a reserved administrator address", edit((l) => change(l, "User", (r) => (r.email = adminAddr))), /reserved on this StitchBench/);
    } finally {
      delete process.env.PLATFORM_ADMIN_EMAILS;
    }
    await refuse(
      "a row of another company",
      edit((l) => change(l, "Customer", (r) => (r.shopId = b.shopId))),
      /Line \d+ of the move file \(Customer\) belongs to another company: the file has been changed/,
    );
    await refuse(
      "a child without its parent",
      edit((l) => change(l, "TicketLine", (r) => (r.ticketId = "nosuchticket"))),
      /Line \d+ of the move file \(TicketLine\) names a Ticket that isn't in the file \(ticketId nosuchticket\)/,
    );
    const bCustomer = await db.customer.findFirstOrThrow({ where: { shopId: b.shopId }, select: { id: true } });
    await refuse(
      "a reference to another company's row",
      edit((l) => change(l, "Machine", (r) => (r.customerId = bCustomer.id))),
      new RegExp(`\\(Machine\\) names a Customer that isn't in the file \\(customerId ${bCustomer.id}\\)`),
    );
    await refuse(
      "a column this version doesn't know",
      edit((l) => {
        change(l, "Customer", (r) => (r.bogus = 1));
        change(l, "Ticket", (r) => (r.alsoBogus = "x"));
      }),
      /has columns this version doesn't know: Customer\.bogus, Ticket\.alsoBogus\. Update this program first/,
    );
    await refuse(
      "a table count that doesn't match",
      edit((l) => (l[l.length - 1] = JSON.stringify({ ...end, tables: { ...end.tables, Customer: end.tables.Customer + 1 } }))),
      /counts don't match its rows \(Customer: says \d+, has \d+\)/,
    );
    await refuse(
      "a row total that doesn't match",
      edit((l) => (l[l.length - 1] = JSON.stringify({ ...end, rows: end.rows + 1 }))),
      /counts don't match its rows \(rows in all: says/,
    );
    await refuse(
      "no end line",
      edit((l) => l.pop()),
      /cut short: its last line is missing/,
    );
    await refuse(
      "a row missing (counts)",
      edit((l) => l.splice(at(l, "PartnerSeen"), 1)),
      /counts don't match its rows \(PartnerSeen: says 1, has 0/,
    );
    await refuse("a cut file", raw.subarray(0, Math.floor(raw.length / 2)), /damaged or cut short: it doesn't unpack/);
    await refuse(
      "lines after the end",
      edit((l) => l.push(l[at(l, "Customer")])),
      /lines after its end line/,
    );
    await refuse(
      "rows out of order",
      edit((l) => {
        const i = at(l, "ServiceItem");
        const [line] = l.splice(i, 1);
        l.splice(l.length - 1, 0, line);
      }),
      /rows are out of order at line \d+ \(ServiceItem\)/,
    );
    await refuse(
      "a header that doesn't match its company row",
      edit((l) => change(l, "Shop", (r) => (r.id = "another-company"))),
      /company row doesn't match its header/,
    );
    await refuse(
      "a table that isn't a company's",
      edit((l) => l.splice(l.length - 1, 0, JSON.stringify({ t: "HubState", id: "x" }))),
      /HubState row, which isn't part of a company/,
    );
    ok(
      "refused with nothing written: not a move file, a newer version, this database behind (named), another company's row, a missing parent, unknown columns (named), wrong counts, no end, a cut file, lines after the end, out of order",
    );

    // ---------- 5. the hosted door: 8 MB parts, resume, the import in the background ----------
    await withEnv({ PLATFORM_ADMIN_EMAILS: `${b.user.email},${c.user.email}` }, async () => {
      // The booking address is now B's: the imported company's is cleared and the summary says so.
      await db.shop.update({ where: { id: b.shopId }, data: { bookingSlug: `move-${RUN}`.toLowerCase() } });
      const name = path.basename(file);
      const v0 = await startUpload(asUser(b), { name, size: raw.length });
      uploads.push(v0.id);
      assert.equal(v0.status, "uploading");
      assert.equal(v0.received, 0);
      assert.equal(v0.size, raw.length);
      // A part ahead of what the server has answers ok: false with what it has, so the browser goes back.
      assert.deepEqual(await putChunk(asUser(b), v0.id, 1, raw.subarray(UPLOAD_CHUNK)), { ok: false, received: 0 });
      assert.deepEqual(await putChunk(asUser(b), v0.id, 0, raw.subarray(0, UPLOAD_CHUNK)), { ok: true, received: UPLOAD_CHUNK });
      // A reload: the same file chosen again finds the same upload, part way.
      const v1 = await startUpload(asUser(b), { name, size: raw.length });
      assert.equal(v1.id, v0.id, "the same upload");
      assert.equal(v1.received, UPLOAD_CHUNK);
      // A part sent twice (a retry after a lost answer) is fine; a part of the wrong size, or past the end, is refused.
      assert.deepEqual(await putChunk(asUser(b), v0.id, 0, raw.subarray(0, UPLOAD_CHUNK)), { ok: true, received: UPLOAD_CHUNK });
      await expectUserError("short middle part", () => putChunk(asUser(b), v0.id, 0, raw.subarray(0, 100)), /Part 0 isn't the right size/);
      await expectUserError("past the end", () => putChunk(asUser(b), v0.id, 2, raw.subarray(0, 10)), /Part 2 isn't the right size/);
      await expectUserError("import before it's all here", () => finishUpload(asUser(b), v0.id), /The file isn't all here \(8\.0 of/);
      // Tenant: another company's administrator, and a non-administrator, can't see or touch it.
      for (const [label, fn] of [
        ["view", () => uploadView(asUser(c), v0.id)],
        ["part", () => putChunk(asUser(c), v0.id, 1, raw.subarray(UPLOAD_CHUNK))],
        ["import", () => finishUpload(asUser(c), v0.id)],
        ["discard", () => discardUpload(asUser(c), v0.id)],
      ] as const) {
        await expectUserError(`C's administrator: ${label}`, fn, new RegExp(IMPORT_NOT_FOUND));
      }
      assert.deepEqual(await recentImports(asUser(c)), [], "C sees none of B's uploads");
      assert.deepEqual(await putChunk(asUser(b), v0.id, 1, raw.subarray(UPLOAD_CHUNK)), { ok: true, received: raw.length });
      const started = await finishUpload(asUser(b), v0.id);
      assert.ok(started.status === "checking" || started.status === "importing" || started.status === "done");
      const job = await waitJob(v0.id);
      assert.equal(job.status, "done", job.error ?? "");
      assert.equal(job.door, "hosted");
      const vDone = await uploadView(asUser(b), v0.id);
      assert.equal(vDone.status, "done");
      assert.equal(vDone.summary?.bookingSlugCleared, `move-${RUN}`.toLowerCase());
      assert.ok(vDone.summary?.notes.some((x) => /is taken by another company here, so it was cleared/.test(x)));
      const row = await db.companyMove.findUniqueOrThrow({ where: { id: v0.id } });
      assert.equal(row.shopId, b.shopId, "the upload is a record of the importing administrator's company");
      assert.equal(row.status, "done");
      assert.equal(row.filePath, null);
      assert.ok(!fs.existsSync(path.join(spoolDir(), `${v0.id}.upload`)), "the spooled file is deleted once the company is in");
      const imported = await db.shop.findUniqueOrThrow({ where: { id: a.shopId } });
      assert.equal(imported.bookingSlug, null, "A's booking address cleared");
      assert.equal((await db.shop.findUniqueOrThrow({ where: { id: b.shopId } })).bookingSlug, `move-${RUN}`.toLowerCase(), "B keeps its address");
      assert.equal(await db.customer.count({ where: { shopId: a.shopId } }), before.Customer.length);
      assert.ok((await recentImports(asUser(b))).some((v) => v.id === v0.id && v.status === "done"));

      // A refused upload keeps its file for "Import again"; Discard deletes it.
      const bad = edit(() => undefined); // the company is already here: refused
      const u = await startUpload(asUser(b), { name: "bad.stitchmove.ndjson.gz", size: bad.length });
      uploads.push(u.id);
      await putChunk(asUser(b), u.id, 0, bad.subarray(0, Math.min(UPLOAD_CHUNK, bad.length)));
      if (bad.length > UPLOAD_CHUNK) await putChunk(asUser(b), u.id, 1, bad.subarray(UPLOAD_CHUNK));
      await finishUpload(asUser(b), u.id);
      const failed = await waitJob(u.id);
      assert.equal(failed.status, "failed");
      assert.match(failed.error ?? "", /is already on this install/);
      const uv = await uploadView(asUser(b), u.id);
      assert.equal(uv.status, "failed");
      assert.equal(uv.canRetry, true, "the file is kept for another try");
      await discardUpload(asUser(b), u.id);
      assert.equal((await db.companyMove.findUniqueOrThrow({ where: { id: u.id } })).status, "cancelled");
      await sleep(50);
      assert.ok(!fs.existsSync(path.join(spoolDir(), `${u.id}.upload`)), "Discard deletes the file");
      await db.shop.update({ where: { id: b.shopId }, data: { bookingSlug: null } });
    });
    ok(
      "hosted: 8 MB parts with resume (same file, same upload), a part twice or ahead handled; the import in the background; the booking address cleared on a clash and said; the spool file deleted; a refused one kept for Import again, then discarded",
    );

    // Tenant: nobody but the StitchBench administrator reaches the hosted import.
    await removeCompany(a.shopId);
    n0 = await counts();
    await withEnv({ PLATFORM_ADMIN_EMAILS: c.user.email }, async () => {
      await expectUserError("start (not the administrator)", () => startUpload(asUser(b), { name: "x.gz", size: 10 }), new RegExp(ONLY_ADMIN));
      await expectUserError("view (not the administrator)", () => uploadView(asUser(b), "anything"), new RegExp(ONLY_ADMIN));
      await expectUserError("part (not the administrator)", () => putChunk(asUser(b), "anything", 0, Buffer.from("x")), new RegExp(ONLY_ADMIN));
      await expectUserError("import (not the administrator)", () => importCompany(file, { by: asUser(b) }), new RegExp(ONLY_ADMIN));
      assert.deepEqual(await recentImports(asUser(b)), []);
    });
    assert.deepEqual(await counts(), n0, "nothing written");
    ok("tenant: a non-administrator can't start, see, send to or import through the hosted door; another company's administrator gets Import not found");

    // ---------- 6. the Windows program's door ----------
    const secret = crypto.randomBytes(32).toString("base64url");
    await withEnv({ STITCH_DESKTOP: "1", PLATFORM_ADMIN_EMAILS: "", MOVE_LOCAL_SECRET: undefined }, async () => {
      // No secret (not started by the program): shut.
      await expectUserError("no secret", () => startPcImport(file, moveToken("anything", file)), new RegExp(DOOR_SHUT));
      process.env.MOVE_LOCAL_SECRET = secret;
      await expectUserError("no token", () => startPcImport(file, null), new RegExp(DOOR_SHUT));
      await expectUserError("another secret's token", () => startPcImport(file, moveToken("not-the-secret", file)), new RegExp(DOOR_SHUT));
      await expectUserError("a token for another file", () => startPcImport(file, moveToken(secret, `${file}.other`)), new RegExp(DOOR_SHUT));
      await expectUserError("an expired token", () => startPcImport(file, moveToken(secret, file, Date.now() - 10 * 60_000)), new RegExp(DOOR_SHUT));
      await expectUserError("a relative path", () => startPcImport("move.stitchmove.ndjson.gz", moveToken(secret, "move.stitchmove.ndjson.gz")), new RegExp(DOOR_SHUT));
      const once = moveToken(secret, file);
      assert.equal(takeMoveToken(once, file), true);
      assert.equal(takeMoveToken(once, file), false, "a token is good once");
      // This install has companies (B, C, ...) and no platformAdminEmails: one company per PC.
      assert.equal(await pcImportOpen(), false);
      await expectUserError("a PC that has its company", () => startPcImport(file, moveToken(secret, file)), new RegExp(ONE_COMPANY.slice(0, 40)));
      await expectUserError("importCompany on such a PC", () => importCompany(file, { by: "operator" }), new RegExp(ONE_COMPANY.slice(0, 40)));
      assert.deepEqual(await counts(), n0, "nothing written");
      // Set up to host several: allowed.
      process.env.PLATFORM_ADMIN_EMAILS = "operator@stitchbench.test";
      assert.equal(await pcImportOpen(), true);
      const id = await startPcImport(file, moveToken(secret, file));
      assert.ok(id.length >= 32, "the job's id is long and random (the progress page's only key)");
      const job = await waitJob(id);
      assert.equal(job.status, "done", job.error ?? "");
      assert.equal(job.door, "pc");
      assert.equal(job.summary?.shopId, a.shopId);
      assert.ok(fs.existsSync(file), "the owner's file is left where it was");
    });
    assert.equal(await db.customer.count({ where: { shopId: a.shopId } }), before.Customer.length);
    ok(
      "the PC door: shut without the program's secret, a good token, the same file or in time; a token is good once; refused on a PC that has its company unless platformAdminEmails is set; then the import runs",
    );

    // ---------- 7. B untouched ----------
    assert.deepEqual(await companyRows(b.shopId), bBefore, "every row of B as it was");
    ok("company B's rows are exactly as before, through three imports and every refusal");
  } finally {
    process.env.PLATFORM_ADMIN_EMAILS = original.admins;
    if (original.admins === undefined) delete process.env.PLATFORM_ADMIN_EMAILS;
    if (original.desktop === undefined) delete process.env.STITCH_DESKTOP;
    else process.env.STITCH_DESKTOP = original.desktop;
    if (original.secret === undefined) delete process.env.MOVE_LOCAL_SECRET;
    else process.env.MOVE_LOCAL_SECRET = original.secret;
    // PartnerSeen and PartnerFailure have no foreign key to Shop: deleting the companies leaves their rows.
    const ids = [a.shopId, b.shopId, c.shopId];
    await db.partnerSeen.deleteMany({ where: { shopId: { in: ids } } });
    await db.partnerFailure.deleteMany({ where: { shopId: { in: ids } } });
    await cleanup();
    for (const id of uploads) for (const ext of [".upload", ".json"]) fs.rmSync(path.join(spoolDir(), id + ext), { force: true });
    fs.rmSync(DIR, { recursive: true, force: true, maxRetries: 5, retryDelay: 200 });
  }
  console.log(`move-import.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
