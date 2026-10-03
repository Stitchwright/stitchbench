// Moving a company out (company-move-design.md, package move-export): the table list covers every model with a shopId;
// the file parses, the header is right, every table's count matches the database and the rows are in table order with
// their ids, Bytes as base64, Dates as ISO; the sealed secrets are null and named in leftOut; nothing of company B is in
// A's file; the freeze (Shop.movingAt) makes a write refuse with the moving message through the base gate, safe() and
// lapseGuard, workers skip the company and hub writes refuse; Cancel lifts it; a download that stops part way ends the
// transaction and marks the move failed; tenant: B's owner (and A's own admin) can't start, read, export or cancel A's move.
//   npm run check scripts/checks/move-export.check.ts
import "dotenv/config";
import assert from "node:assert/strict";
import crypto from "node:crypto";
import fs from "node:fs";
import path from "node:path";
import zlib from "node:zlib";
import { Readable } from "node:stream";
import type { ReadableStream as WebReadable } from "node:stream/web";
import { db } from "@/lib/db";
import { isUserError, safe } from "@/lib/action";
import { lapseGuard, lapseUserFrom } from "@/lib/lapse-guard";
import { baseResponse, baseWritable, requireBaseWritable } from "@/lib/base-gate";
import { shopsWithModule } from "@/lib/modules";
import { requireHubWrites } from "@/lib/hub-writes";
import { appName } from "@/lib/shops";
import { seal } from "@/lib/messaging/secrets";
import {
  checkMeta,
  LEFT_OUT,
  MOVE_FORMAT,
  MOVE_TABLES,
  MOVE_VERSION,
  moveFileName,
  movingMessage,
  parseLine,
  PER_INSTALL,
  shopFilterSql,
  tableByName,
  type MoveEnd,
  type MoveMeta,
  type MoveRow,
} from "@/lib/move/format";
import { cancelMove, exportCompany, moveView, startMove, type Mover } from "@/lib/move/export";
import type { CurrentUser } from "@/lib/session";
import { checkShop, cleanup, linkPair, messagingFor, withSink, type CheckShop } from "./lib";
import { assertUnchanged, expectNotFound, snapshot } from "./tenant";

let steps = 0;
const ok = (what: string) => {
  steps += 1;
  console.log(`  ok  ${what}`);
};
const user = (s: CheckShop): CurrentUser => s.user;

async function expectError(label: string, fn: () => Promise<unknown>, re: RegExp) {
  try {
    await fn();
  } catch (e) {
    assert.ok(isUserError(e), `${label}: ${e instanceof Error ? e.stack : String(e)}`);
    assert.match((e as Error).message, re, label);
    return;
  }
  assert.fail(`${label}: no error`);
}

/** The whole stream, gunzipped, as parsed lines. */
async function readFile(stream: ReadableStream<Uint8Array>): Promise<{ raw: Buffer; lines: (MoveMeta | MoveEnd | MoveRow)[] }> {
  const chunks: Buffer[] = [];
  for await (const c of Readable.fromWeb(stream as unknown as WebReadable)) chunks.push(Buffer.from(c as Uint8Array));
  const raw = Buffer.concat(chunks);
  const text = zlib.gunzipSync(raw).toString("utf8");
  assert.ok(text.endsWith("\n"), "the file ends with a newline");
  const lines = text.slice(0, -1).split("\n");
  return { raw, lines: lines.map((l, i) => parseLine(l, i + 1)) };
}

async function count(table: string, shopId: string): Promise<number> {
  const t = tableByName(table) ?? { t: table, key: "id" };
  const r = await db.$queryRawUnsafe<{ n: number }[]>(`SELECT count(*)::int AS n FROM "${table}" WHERE ${shopFilterSql(t)}`, shopId);
  return r[0].n;
}

/** Models in prisma/schema.prisma with a shopId column, and every model name. */
function schemaModels(): { withShopId: string[]; all: string[] } {
  const text = fs.readFileSync(path.join(process.cwd(), "prisma", "schema.prisma"), "utf8").replace(/\r\n/g, "\n");
  const withShopId: string[] = [];
  const all: string[] = [];
  for (const m of text.matchAll(/^model (\w+) \{\n([\s\S]*?)\n\}/gm)) {
    all.push(m[1]);
    if (/^\s+shopId\s+String/m.test(m[2])) withShopId.push(m[1]);
  }
  return { withShopId, all };
}

const sleep = (ms: number) => new Promise((r) => setTimeout(r, ms));

async function main() {
  await withSink();
  const a = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
  const b = await checkShop({ retail: true, repair: true, modules: ["marketing"] });
  let who: CurrentUser | null = null;
  lapseUserFrom(async () => who);
  try {
    // ---------- 1. the table list against the schema ----------
    const { withShopId, all } = schemaModels();
    const listed = new Set(MOVE_TABLES.map((t) => t.t));
    const missing = withShopId.filter((m) => !listed.has(m) && !(m in PER_INSTALL));
    assert.deepEqual(missing, [], `models with a shopId that are neither in MOVE_TABLES nor PER_INSTALL: ${missing.join(", ")}`);
    for (const t of MOVE_TABLES) assert.ok(all.includes(t.t), `${t.t} is a model`);
    for (const m of Object.keys(PER_INSTALL)) assert.ok(all.includes(m), `${m} is a model`);
    assert.equal(new Set(MOVE_TABLES.map((t) => t.t)).size, MOVE_TABLES.length, "no table twice");
    // The five child tables without a shopId of their own come after their parents.
    const order = MOVE_TABLES.map((t) => t.t);
    for (const [child, parent] of [
      ["TicketLine", "Ticket"],
      ["Payment", "Ticket"],
      ["PartSource", "Part"],
      ["SaleLine", "Sale"],
      ["SharedPhoto", "SharedPost"],
      ["Machine", "Customer"],
      ["Ticket", "Machine"],
      ["OutMessage", "Campaign"],
      ["Enrollment", "ShopClass"],
      ["Appointment", "AppointmentType"],
    ]) {
      assert.ok(order.indexOf(child) > order.indexOf(parent), `${child} after ${parent}`);
    }
    assert.equal(order[0], "Shop");
    assert.equal(order[1], "User");
    ok(`MOVE_TABLES (${MOVE_TABLES.length}) covers every shopId model in the schema, parents first; PER_INSTALL names the rest`);

    // ---------- 2. a company with something in the main tables ----------
    await messagingFor(a.shopId, { email: true });
    await messagingFor(b.shopId, { email: true });
    const cust = await db.customer.create({ data: { shopId: a.shopId, name: "Mona Mover", email: "mona@example.test", phone: "555-0199" } });
    const machine = await db.machine.create({ data: { shopId: a.shopId, customerId: cust.id, brand: "Bernina", model: "770 QE", modelKey: "770qe", details: { bobbin: "B9" } } });
    const ticket = await db.ticket.create({ data: { shopId: a.shopId, number: 9001, status: "ON_BENCH", machineId: machine.id, customerId: cust.id, intake: { issue: "skips" } } });
    await db.ticketLine.create({ data: { ticketId: ticket.id, kind: "LABOR", description: "Full service", unitPriceCents: 9800 } });
    await db.payment.create({ data: { ticketId: ticket.id, method: "CASH", amountCents: 5000 } });
    const part = await db.part.create({ data: { shopId: a.shopId, partNumber: "MV-100", description: "Hook", numberKeys: ["MV100"], qtyOnHand: 3, priceCents: 4500 } });
    await db.partSource.create({ data: { partId: part.id, vendor: "Sewing Parts Online" } });
    await db.stockMove.create({ data: { shopId: a.shopId, partId: part.id, qty: 3, reason: "RECEIVED", userId: a.user.id } });
    const photoBytes = crypto.randomBytes(3000);
    const photo = await db.machinePhoto.create({ data: { shopId: a.shopId, machineId: machine.id, ticketId: ticket.id, mime: "image/jpeg", data: photoBytes } });
    await db.partPhoto.create({ data: { shopId: a.shopId, partId: part.id, mime: "image/jpeg", data: crypto.randomBytes(500) } });
    const sale = await db.sale.create({
      data: { shopId: a.shopId, number: 7001, subtotalCents: 4500, taxCents: 0, totalCents: 4500, taxRatePct: 0, customerId: cust.id, userId: a.user.id, tenders: [{ method: "CASH", cents: 4500 }] },
    });
    await db.saleLine.create({ data: { saleId: sale.id, partId: part.id, description: "Hook", qty: 1, unitPriceCents: 4500 } });
    await db.outMessage.create({
      data: { shopId: a.shopId, customerId: cust.id, channel: "email", purpose: "notice", kind: "ready", address: "mona@example.test", body: "Ready.", status: "SENT", ticketId: ticket.id },
    });
    await db.suppression.create({ data: { shopId: a.shopId, channel: "email", address: "gone@example.test", scope: "marketing", source: "link" } });
    await db.consentEvent.create({ data: { shopId: a.shopId, customerId: cust.id, channel: "email", event: "marketing_yes", source: "counter" } });
    await db.estimateLink.create({
      data: {
        shopId: a.shopId,
        ticketId: ticket.id,
        tokenHash: crypto.randomBytes(16).toString("hex"),
        tokenSealed: seal("tok", a.shopId, "estimateToken:chk"),
        maskedUrl: "https://x/e/•••abcd",
        totalCents: 9800,
        lines: [{ description: "Full service", amountCents: 9800 }],
        expiresAt: new Date(Date.now() + 86_400_000),
      },
    });
    await db.shop.update({ where: { id: a.shopId }, data: { stripeKeySealed: seal("sk_test_x", a.shopId, "stripeKey"), stripeWebhookSealed: seal("whsec_x", a.shopId, "stripeWebhook") } });
    const linkId = await linkPair(a.shopId, b.shopId);
    await db.partnerSeen.create({ data: { shopId: a.shopId, key: `${linkId}:1` } });
    // Company B has its own rows, none of which may appear in A's file.
    const bCust = await db.customer.create({ data: { shopId: b.shopId, name: "Bea Bystander" } });
    const bMachine = await db.machine.create({ data: { shopId: b.shopId, customerId: bCust.id, brand: "Janome", model: "MC6700P", modelKey: "mc6700p" } });
    await db.ticket.create({ data: { shopId: b.shopId, number: 9001, status: "ON_BENCH", machineId: bMachine.id, customerId: bCust.id, intake: {} } });
    ok("two companies: A with tickets, parts, photos, a sale, messages, consent, an estimate link, Stripe keys and a mail password sealed, a partner link with B");

    // ---------- 3. the file, without the freeze (a snapshot) ----------
    const ex = await exportCompany(user(a), a.shopId);
    assert.equal(ex.fileName, moveFileName((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).name));
    assert.match(ex.fileName, /^check-[a-z0-9]+-\d{4}-\d{2}-\d{2}\.stitchmove\.ndjson\.gz$/);
    assert.equal(ex.moveId, null, "no freeze: no move record");
    const { raw, lines } = await readFile(ex.stream);
    assert.ok(raw.length > 2000 && raw[0] === 0x1f && raw[1] === 0x8b, "gzipped");
    const meta = lines[0];
    assert.ok(checkMeta(meta), "line 1 is the meta header");
    assert.equal(meta.format, MOVE_FORMAT);
    assert.equal(meta.version, MOVE_VERSION);
    assert.equal(meta.program, appName());
    const mig = await db.$queryRawUnsafe<{ m: string }[]>(`SELECT max(migration_name) AS m FROM "_prisma_migrations"`);
    assert.equal(meta.lastMigration, mig[0].m);
    assert.ok(meta.lastMigration && meta.lastMigration >= "20261003150000_company_move");
    assert.deepEqual(meta.shop, { id: a.shopId, name: a.name, kind: "both" });
    // The hub's part (package move-hub; its own check is move-hub.check.ts): a copy made without the freeze names this
    // install's hub and its places in the feeds, and never carries a move token (it isn't a move).
    const hs = await db.hubState.findUnique({ where: { id: 1 } });
    if (hs?.url && hs.installKey) {
      assert.deepEqual(meta.hub, { url: hs.url, installId: hs.installId, moveToken: null, cursor: hs.cursor, orderCursor: hs.orderCursor, partnerCursor: hs.partnerCursor });
      assert.ok(
        meta.warnings.some((w) => /a copy, not a move/.test(w)),
        "the copy says it carries no move token",
      );
    } else assert.equal(meta.hub, null, "an install on no hub names none");
    assert.deepEqual(meta.leftOut, LEFT_OUT);
    assert.ok(
      meta.leftOut.includes("MessagingSettings.smtpPassSealed") &&
        meta.leftOut.includes("Shop.stripeKeySealed") &&
        meta.leftOut.includes("EstimateLink.tokenSealed") &&
        meta.leftOut.includes("WebOrder.linkSealed"),
    );
    assert.ok(Array.isArray(meta.warnings) && meta.warnings.some((w) => /Secrets are left out/.test(w)));
    assert.ok(!Number.isNaN(Date.parse(meta.exportedAt)));
    const end = lines[lines.length - 1];
    assert.equal(end.t, "end", "the last line is the end trailer");
    const trailer = end as MoveEnd;
    const rows = lines.slice(1, -1) as MoveRow[];
    assert.equal(trailer.rows, rows.length, "the trailer's row count is the number of row lines");
    assert.deepEqual(
      Object.keys(trailer.tables),
      MOVE_TABLES.map((t) => t.t),
      "the trailer names every table in order",
    );
    for (const t of MOVE_TABLES) {
      const inFile = rows.filter((r) => r.t === t.t).length;
      assert.equal(inFile, trailer.tables[t.t], `${t.t}: trailer count`);
      assert.equal(inFile, await count(t.t, a.shopId), `${t.t}: database count`);
    }
    for (const t of [
      "Shop",
      "User",
      "Customer",
      "Machine",
      "Ticket",
      "TicketLine",
      "Payment",
      "Part",
      "PartSource",
      "StockMove",
      "MachinePhoto",
      "PartPhoto",
      "Sale",
      "SaleLine",
      "PartnerLink",
      "PartnerSeen",
      "License",
      "MessagingSettings",
      "OutMessage",
      "Suppression",
      "ConsentEvent",
      "EstimateLink",
      "ServiceItem",
    ]) {
      assert.ok(trailer.tables[t] > 0, `${t} has rows in the file`);
    }
    // Rows come in table order, each table's block together.
    const seen: string[] = [];
    for (const r of rows) if (seen[seen.length - 1] !== r.t) seen.push(r.t);
    assert.deepEqual(
      seen,
      MOVE_TABLES.map((t) => t.t).filter((t) => trailer.tables[t] > 0),
      "tables in order, each in one block",
    );
    ok("the file: gzipped JSON lines, the meta header right, every table's count matches the database and the trailer, tables in order");

    // Ids as before, bytes as base64, dates as ISO, Json as is, sealed fields null, nothing of B's.
    const fileTicket = rows.find((r) => r.t === "Ticket" && r.id === ticket.id);
    assert.ok(fileTicket, "the ticket is in the file under its own id");
    assert.equal(fileTicket.shopId, a.shopId);
    assert.equal(fileTicket.machineId, machine.id);
    assert.deepEqual(fileTicket.intake, { issue: "skips" });
    assert.equal(fileTicket.status, "ON_BENCH");
    assert.equal(typeof fileTicket.intakeAt, "string");
    assert.equal(new Date(fileTicket.intakeAt as string).toISOString(), ticket.intakeAt.toISOString(), "DateTime as ISO, to the millisecond");
    const filePhoto = rows.find((r) => r.t === "MachinePhoto" && r.id === photo.id);
    assert.ok(filePhoto && typeof filePhoto.data === "string");
    assert.ok(Buffer.from(filePhoto.data as string, "base64").equals(photoBytes), "Bytes as base64, the same bytes");
    assert.equal(filePhoto.ticketId, ticket.id);
    const fileSale = rows.find((r) => r.t === "Sale" && r.id === sale.id)!;
    assert.deepEqual(fileSale.tenders, [{ method: "CASH", cents: 4500 }]);
    assert.equal(fileSale.taxRatePct, 0);
    for (const r of rows) {
      if (r.t === "Shop") assert.equal(r.id, a.shopId, "the Shop row is A's");
      else if ("shopId" in r) assert.equal(r.shopId, a.shopId, `${r.t} ${r.id ?? ""}: another company's row`);
    }
    assert.equal(rows.filter((r) => r.t === "Customer").length, 1, "one customer: Mona, not Bea");
    assert.ok(!rows.some((r) => r.t === "Customer" && r.id === bCust.id));
    assert.ok(!rows.some((r) => r.t === "PartnerLink" && r.shopId === b.shopId), "B's side of the partner link stays with B");
    assert.equal(rows.filter((r) => r.t === "PartnerLink").length, 1);
    const fileShop = rows.find((r) => r.t === "Shop")!;
    assert.equal(fileShop.stripeKeySealed, null);
    assert.equal(fileShop.stripeWebhookSealed, null);
    assert.equal(fileShop.movingAt, null);
    assert.equal(fileShop.name, a.name);
    assert.equal(fileShop.timeZone, "America/New_York");
    const fileMs = rows.find((r) => r.t === "MessagingSettings")!;
    assert.equal(fileMs.smtpPassSealed, null);
    assert.equal(fileMs.smtpPassSavedAt, null);
    assert.equal(fileMs.smtpHost, "127.0.0.1", "the rest of the mail settings travel");
    assert.equal(fileMs.emailOn, true, "the import switches the channels off, not the export");
    const dbMs = await db.messagingSettings.findUniqueOrThrow({ where: { shopId: a.shopId } });
    assert.ok(dbMs.smtpPassSealed, "the database still holds the sealed password");
    const fileEl = rows.find((r) => r.t === "EstimateLink")!;
    assert.equal(fileEl.tokenSealed, null);
    assert.ok(typeof fileEl.tokenHash === "string" && fileEl.tokenHash.length === 32);
    const fileUser = rows.find((r) => r.t === "User" && r.id === a.user.id)!;
    assert.ok(typeof fileUser.passwordHash === "string" && (fileUser.passwordHash as string).startsWith("$2"), "the bcrypt hash travels");
    const fileSeen = rows.find((r) => r.t === "PartnerSeen")!;
    assert.equal(fileSeen.key, `${linkId}:1`);
    assert.equal(fileSeen.shopId, a.shopId);
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).movingAt, null, "no freeze asked for: the company carries on");
    ok("ids kept, Bytes as base64 and back, Dates ISO, Json as is, the sealed secrets null in the file and still in the database, nothing of B's");

    // ---------- 4. the freeze ----------
    assert.equal(await baseWritable(a.shopId), true);
    const moveId = await startMove(user(a), a.shopId, { to: "the shop PC", agreed: true });
    const frozen = await db.shop.findUniqueOrThrow({ where: { id: a.shopId } });
    assert.ok(frozen.movingAt, "Shop.movingAt set");
    assert.equal(frozen.movedTo, "the shop PC");
    assert.equal(await baseWritable(a.shopId), false);
    const re = /This company is moving to the shop PC; it is read-only here since \w+ \d+, \d{4}\. You can look at and export everything.*Cancel the move in Settings → Company/;
    await expectError("requireBaseWritable", () => requireBaseWritable(user(a)), re);
    await expectError("requireBaseWritable (tech)", () => requireBaseWritable({ shopId: a.shopId, role: "TECH" }), /is moving to the shop PC.*Ask the shop owner/);
    const resp = await baseResponse(a.shopId);
    assert.equal(resp?.status, 403);
    assert.match(await resp!.text(), re);
    assert.equal(movingMessage({ at: frozen.movingAt, to: "the shop PC" }, "Oct 2, 2026").startsWith("This company is moving to the shop PC; it is read-only here since Oct 2, 2026."), true);
    assert.match(movingMessage({ at: frozen.movingAt, to: null }, "Oct 2, 2026"), /^This company is moving; it is read-only/);
    who = user(a);
    await expectError("lapseGuard", () => lapseGuard(), re);
    const plainAction = safe(async () => {});
    const r1 = await plainAction();
    assert.ok(r1.error && re.test(r1.error), "a safe() action is refused with the moving message");
    const allowed = safe.whileLapsed("cancelCompanyMove")(async () => {});
    assert.deepEqual(await allowed(), { ok: true }, "an allow-listed action goes through");
    who = null;
    assert.deepEqual(await shopsWithModule("marketing", [a.shopId, b.shopId]), [b.shopId], "the message worker skips the moving company");
    await expectError("requireHubWrites", () => requireHubWrites({ shopId: a.shopId, name: "x" }), /being moved to another install.*nothing is shared to the hub/);
    await expectError("start twice", () => startMove(user(a), a.shopId), /already being moved/);
    await expectError("not agreed", () => startMove(user(b), b.shopId, { agreed: false }), /Tick the box/);
    assert.equal(await baseWritable(b.shopId), true, "B is untouched");
    let view = await moveView(user(a), a.shopId);
    assert.equal(view.move?.id, moveId);
    assert.equal(view.move?.status, "ready");
    assert.equal(view.shop.movingAt?.getTime(), frozen.movingAt.getTime());
    assert.deepEqual(view.needKeys, []);
    ok("the freeze: Shop.movingAt makes the base gate, safe() and lapseGuard refuse with the moving message; workers skip it; hub writes refuse; a second start is refused; B is untouched");

    // The download while frozen: progress and the done mark on the move record; the file's Shop row isn't frozen.
    const ex2 = await exportCompany(user(a), a.shopId, { moveId });
    assert.equal(ex2.moveId, moveId);
    const f2 = await readFile(ex2.stream);
    const shop2 = f2.lines.find((l) => l.t === "Shop") as MoveRow;
    assert.equal(shop2.movingAt, null, "the copy that arrives isn't frozen");
    assert.equal(shop2.movedTo, null);
    const end2 = f2.lines[f2.lines.length - 1] as MoveEnd;
    assert.equal(end2.rows, trailer.rows, "the same rows as before the freeze (nothing was written meanwhile)");
    for (let i = 0; i < 40; i += 1) {
      const row = await db.companyMove.findUniqueOrThrow({ where: { id: moveId } });
      if (row.status === "done") break;
      await sleep(100);
    }
    const doneRow = await db.companyMove.findUniqueOrThrow({ where: { id: moveId } });
    assert.equal(doneRow.status, "done");
    assert.equal(doneRow.rowsDone, end2.rows);
    assert.equal(doneRow.rowsTotal, end2.rows);
    assert.equal(Number(doneRow.bytes), f2.raw.length, "the gzipped bytes sent");
    assert.ok(doneRow.downloadedAt && doneRow.finishedAt);
    view = await moveView(user(a), a.shopId);
    assert.equal(view.move?.status, "done");
    assert.equal(view.move?.bytes, f2.raw.length);
    ok("the download while frozen: the move record shows done, rows and gzipped bytes; the Shop row in the file has no move marks");

    // A download that stops part way: the move record says failed, the transaction is gone (the next query works).
    const ex3 = await exportCompany(user(a), a.shopId, { moveId });
    const reader = ex3.stream.getReader();
    const first = await reader.read();
    assert.ok(!first.done && first.value && first.value.length > 0);
    await reader.cancel();
    for (let i = 0; i < 50; i += 1) {
      const row = await db.companyMove.findUniqueOrThrow({ where: { id: moveId } });
      if (row.status === "failed") break;
      await sleep(100);
    }
    const failedRow = await db.companyMove.findUniqueOrThrow({ where: { id: moveId } });
    assert.equal(failedRow.status, "failed");
    assert.match(failedRow.error ?? "", /stopped before the end/);
    assert.equal(await count("Ticket", a.shopId), 1, "the database answers after the rolled-back snapshot");
    ok("a download that stops part way marks the move failed and lets go of the snapshot");

    // ---------- 5. Cancel ----------
    await cancelMove(user(a), a.shopId);
    const thawed = await db.shop.findUniqueOrThrow({ where: { id: a.shopId } });
    assert.equal(thawed.movingAt, null);
    assert.equal(thawed.movedTo, null);
    assert.equal(await baseWritable(a.shopId), true);
    await requireBaseWritable(user(a));
    assert.equal(await baseResponse(a.shopId), null);
    who = user(a);
    await lapseGuard();
    who = null;
    assert.deepEqual((await shopsWithModule("marketing", [a.shopId, b.shopId])).sort(), [a.shopId, b.shopId].sort());
    assert.equal((await db.companyMove.findUniqueOrThrow({ where: { id: moveId } })).status, "cancelled");
    assert.equal((await moveView(user(a), a.shopId)).move, null);
    await expectError("cancel twice", () => cancelMove(user(a), a.shopId), /isn't being moved/);
    ok("Cancel lifts the freeze: writes go through again, the worker sees the company, the move record is cancelled");

    // ---------- 6. tenant ----------
    const before = await snapshot(a.shopId, ["Shop", "Ticket", "Customer"]);
    await expectNotFound("startMove(B, A)", () => startMove(user(b), a.shopId, { agreed: true }));
    await expectNotFound("exportCompany(B, A)", () => exportCompany(user(b), a.shopId));
    await expectNotFound("moveView(B, A)", () => moveView(user(b), a.shopId));
    await expectNotFound("cancelMove(B, A)", () => cancelMove(user(b), a.shopId));
    // A's own admin and tech can't either: owner only.
    const admin: Mover = { ...a.user, id: "x", role: "ADMIN" };
    await expectNotFound("startMove(A's admin)", () => startMove(admin, a.shopId, { agreed: true }));
    await expectNotFound("exportCompany(A's admin)", () => exportCompany(admin, a.shopId));
    await expectNotFound("exportCompany(A's tech)", () => exportCompany({ ...admin, role: "TECH" }, a.shopId));
    // A move record of A's can't be used by B's owner, and B's owner can't read a move of A's.
    const aMove = await startMove(user(a), a.shopId, { agreed: true });
    await expectNotFound("exportCompany(B, A, A's move)", () => exportCompany(user(b), a.shopId, { moveId: aMove }));
    await expectError("exportCompany(A, A, B's move id)", () => exportCompany(user(a), a.shopId, { moveId: "nosuchmove" }), /isn't one of this company's/);
    await cancelMove(user(a), a.shopId);
    assert.equal((await db.shop.findUniqueOrThrow({ where: { id: a.shopId } })).movingAt, null);
    assertUnchanged("tenant", before, await snapshot(a.shopId, ["Shop", "Ticket", "Customer"]));
    assert.equal(await count("CompanyMove", b.shopId), 0, "nothing of B's was made");
    ok("tenant: B's owner, and A's own admin and tech, can't start, read, export or cancel A's move; A's rows are unchanged");
  } finally {
    await cleanup();
  }
  console.log(`move-export.check: ${steps} groups passed`);
}

main()
  .catch((e) => {
    console.error(e);
    process.exitCode = 1;
  })
  .finally(() => db.$disconnect());
