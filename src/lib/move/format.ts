// The move file (company-move-design.md section 3): one gzipped file of JSON lines. Line 1 is the meta header, then one
// line per row of every table that goes with the company, parents first, then the end trailer with the counts. Pure:
// no "server-only", no database, so the Settings page, the CLI, the check script and (package move-import) the importer
// share one description of the format. The export itself is src/lib/move/export.ts.

export const MOVE_FORMAT = "stitchbench-company";
export const MOVE_VERSION = 1;
export const MOVE_SUFFIX = ".stitchmove.ndjson.gz";

/** Rows a page, as the hub's transfer.mjs: 200, and 20 for the picture tables (a photo is one line of base64). */
export const PAGE = 200;
export const PHOTO_PAGE = 20;

/**
 * Limits the importer holds a file to, as the hub's: a line (one row, a photo as base64) and the whole inflated file.
 */
export const MAX_LINE = 64 * 1024 * 1024;
export const MAX_INFLATED = 8 * 1024 * 1024 * 1024;

/**
 * The hosted Companies page uploads a move file in parts of this size (design section 8 and decision 8): under the
 * 16 MB request limit (next.config), each part one request, so a dropped connection costs one part and the upload
 * carries on from there. The whole file is held to MAX_INFLATED (a packed file is never bigger than what it unpacks to,
 * give or take gzip's few bytes).
 */
export const UPLOAD_CHUNK = 8 * 1024 * 1024;
export const MAX_UPLOAD = MAX_INFLATED;

export type MoveTable = {
  /** The Prisma model and Postgres table name ("MachinePhoto"). */
  t: string;
  /**
   * The SQL expression the export pages by within the company (every row of a table has shopId = the company's, so the
   * page key is the rest of the primary key): "id" for nearly every table, the primary key column for the one-row-per-
   * parent tables, and a joined text for a multi-column key. Must be text, unique within the company, and never null.
   */
  key: string;
  /** Bytes columns, base64 in the file. */
  bytes?: string[];
  /** The columns set to null in the file (sealed secrets and what goes with them), named in the header's leftOut list. */
  leftOut?: string[];
  /** Columns set to null in the file because they describe this copy, not the company (the Shop's own move marks). */
  cleared?: string[];
  /** A table without a shopId of its own: the company's rows are the ones whose `column` names a row of `parent` (which has one). */
  via?: { column: string; parent: string };
  /** Rows a page. */
  page?: number;
};

/**
 * Every model that goes with the company (design section 2, first table), in dependency order: parents before children,
 * so an import can insert in file order with every foreign key already there. Models with a shopId of their own and no
 * relation (PartnerSeen, PartnerFailure) are here too. Not here: per-install tables (HubState, the hub's cached copies
 * ManualLink / HubPost / HubPhoto / HubFigure / XPart / RemovedXPart / Listing / ListingPhoto / MarketOrder, LibraryDoc,
 * ManualDownload, JobLease, CompanyMove) and the shipped reference sets (TensionSpec, FactorySetting, ServiceMode,
 * ModelImage, FigureImage). The check script holds this list against the schema: every model with a shopId is here or in
 * PER_INSTALL, so a new table can't be forgotten.
 */
export const MOVE_TABLES: readonly MoveTable[] = [
  { t: "Shop", key: "id", leftOut: ["stripeKeySealed", "stripeWebhookSealed"], cleared: ["movingAt", "movedOutAt", "movedTo", "movedInAt", "movedFrom"] },
  { t: "User", key: "id" },
  { t: "BooksSettings", key: '"shopId"' }, // the bookkeeping export's names (one row per company)
  { t: "OffsiteSettings", key: '"shopId"', leftOut: ["bucket"] }, // off-site backup: on or off, target, the public key; the own-bucket settings (a secret sealed under the install's key) are left out
  { t: "OffsiteObject", key: "id" }, // the company's index of its off-site store: photos are not sent again after a move
  { t: "AuditEntry", key: "id" }, // no foreign keys: an entry outlives the login or record it names
  { t: "Customer", key: "id" },
  { t: "GiftCard", key: "id" }, // -> Customer
  { t: "Machine", key: "id" }, // -> Customer
  { t: "ModelNote", key: "id" }, // -> User
  { t: "ServiceItem", key: "id" },
  { t: "ShopEquipmentKind", key: "id" },
  { t: "Part", key: "id" },
  { t: "PartSource", key: "id", via: { column: "partId", parent: "Part" } },
  { t: "Ticket", key: "id" }, // -> Machine, Customer
  { t: "TicketLine", key: "id", via: { column: "ticketId", parent: "Ticket" } }, // -> Part too
  { t: "Payment", key: "id", via: { column: "ticketId", parent: "Ticket" } },
  { t: "GiftCardEntry", key: "id" }, // -> GiftCard (its sale, payment and ticket ids are plain)
  { t: "TicketSite", key: '"ticketId"' }, // -> Ticket (one row per ticket)
  { t: "PartWait", key: "id" }, // -> Ticket, Part
  { t: "StockMove", key: "id" }, // -> Part, User
  { t: "MachinePhoto", key: "id", bytes: ["data"], page: PHOTO_PAGE }, // -> Machine, Ticket
  { t: "PartPhoto", key: "id", bytes: ["data"], page: PHOTO_PAGE }, // -> Part
  { t: "SharedPost", key: "id" }, // -> User
  { t: "SharedPhoto", key: "id", bytes: ["data"], page: PHOTO_PAGE, via: { column: "postId", parent: "SharedPost" } },
  { t: "Sale", key: "id" }, // -> Customer, User
  { t: "SaleLine", key: "id", via: { column: "saleId", parent: "Sale" } }, // -> Part too
  { t: "StockUnit", key: "id" }, // -> Machine
  { t: "VacCare", key: '"machineId"' }, // -> Machine (one row per machine)
  { t: "PartnerKey", key: '"shopId"', leftOut: ["privateSealed"] }, // the sealed private key stays behind: the company makes a new key (src/lib/partner-keys.ts)
  { t: "PartnerLink", key: "id" },
  { t: "PartnerOutbox", key: "id" },
  { t: "RepairJob", key: "id" }, // -> Customer, Machine
  { t: "PartnerOrder", key: "id" },
  { t: "ConsignItem", key: "id" },
  { t: "ConsignSale", key: "id" },
  { t: "Settlement", key: "id" },
  { t: "PartnerSeen", key: "key" },
  { t: "PartnerFailure", key: "key" },
  { t: "PartnerRun", key: "id" },
  { t: "License", key: "id" },
  { t: "ModuleGrant", key: "id" },
  {
    t: "MessagingSettings",
    key: '"shopId"',
    leftOut: ["smtpPassSealed", "smtpPassSavedAt", "twilioTokenSealed", "twilioTokenSavedAt", "testCodeHash", "testCodeUntil", "testPhonePending"],
  },
  { t: "Campaign", key: "id" },
  { t: "OutMessage", key: "id" }, // -> Customer, Campaign
  { t: "Suppression", key: "channel || '|' || address" },
  { t: "ConsentEvent", key: "id" }, // -> Customer
  { t: "InboundText", key: "sid" },
  { t: "EstimateLink", key: "id", leftOut: ["tokenSealed"] },
  { t: "ShopClass", key: "id" },
  { t: "ClassMeeting", key: "id" }, // -> ShopClass
  { t: "Enrollment", key: "id" }, // -> ShopClass, Customer
  { t: "AppointmentType", key: "id" },
  { t: "Appointment", key: "id" }, // -> AppointmentType, Customer, User
  { t: "Shift", key: "id" }, // -> User
  { t: "BookingLink", key: "id" },
  { t: "WebOrder", key: "id", leftOut: ["linkSealed"] },
];

/** Models with a shopId column that stay on the install (design section 2, second table), each with why. */
export const PER_INSTALL: Readonly<Record<string, string>> = {
  ManualDownload: "a queue into this PC's manual library: finished rows describe files that stay here, queued ones a library the new install hasn't got",
  Listing: "the hub's copy of this company's marketplace listings; the hub sends them again after the move",
  MarketOrder: "the hub's copy of this company's marketplace orders; the hub sends them again after the move",
  CompanyMove: "this copy's own move record",
  OffsiteRun: "this install's history of off-site backup runs",
};

/** "Table.column" for every column the file sets to null, as the header's leftOut list. */
export const LEFT_OUT: readonly string[] = MOVE_TABLES.flatMap((t) => (t.leftOut ?? []).map((c) => `${t.t}.${c}`));

/** What the owner enters again on the new side, in the words the Settings page uses. */
export const LEFT_OUT_WORDS = ["the mail password", "the Twilio secret", "the Stripe keys and webhook secret", "estimate and online-order links (customers get new ones)", "the partner signing key (the company makes a new one, and each partner trusts it by a new partner code)"];

export const tableNames = (): string[] => MOVE_TABLES.map((t) => t.t);

/**
 * The SQL that picks the company's rows of a table, with $1 the company's id: the Shop row by id, a table with a shopId
 * by it, and a child table (via) through its parent's. The export and the check script build their queries from it.
 */
export function shopFilterSql(t: MoveTable): string {
  if (t.t === "Shop") return `"id" = $1`;
  if (t.via) return `"${t.via.column}" IN (SELECT "id" FROM "${t.via.parent}" WHERE "shopId" = $1)`;
  return `"shopId" = $1`;
}
export const tableByName = (name: string): MoveTable | undefined => MOVE_TABLES.find((t) => t.t === name);

export type MoveMeta = {
  t: "meta";
  format: typeof MOVE_FORMAT;
  version: number;
  /** StitchBench | StitchShop */
  program: string;
  appVersion: string | null;
  /** The newest _prisma_migrations name where the file was taken: the target must be at or past it. */
  lastMigration: string | null;
  exportedAt: string;
  shop: { id: string; name: string; kind: string };
  /**
   * The hub's part (design section 5, package move-hub): the hub this install is on, its id there, the move token the
   * new install redeems (null when the hub couldn't give one, or the file is a copy rather than a move), and the
   * install's places in the hub's feeds (the new install catches up on partner messages from partnerCursor). Null for
   * an install on no hub. src/lib/move/hub-step.ts.
   */
  hub: { url: string; installId: string; moveToken: string | null; cursor: unknown; orderCursor: unknown; partnerCursor: unknown } | null;
  leftOut: string[];
  warnings: string[];
};

export type MoveEnd = { t: "end"; rows: number; tables: Record<string, number> };

/** A row line: the model name under t, then the row's columns as the database holds them (see encodeValue). */
export type MoveRow = { t: string } & Record<string, unknown>;

export type MoveLine = MoveMeta | MoveEnd | MoveRow;

/**
 * A column value as it goes in the file: Bytes as base64, DateTime as ISO (UTC), Json as it is, enums as their names,
 * everything else as JSON has it. Prisma's raw rows give Uint8Array for Bytes and Date for DateTime.
 */
export function encodeValue(v: unknown): unknown {
  if (v instanceof Uint8Array) return Buffer.from(v.buffer, v.byteOffset, v.byteLength).toString("base64");
  if (v instanceof Date) return v.toISOString();
  if (typeof v === "bigint") return Number(v);
  return v;
}

/** One row as its file line (not yet serialised): the left-out columns null, values encoded. */
export function encodeRow(table: MoveTable, row: Record<string, unknown>): MoveRow {
  const out: MoveRow = { t: table.t };
  for (const [k, v] of Object.entries(row)) out[k] = table.leftOut?.includes(k) || table.cleared?.includes(k) ? null : encodeValue(v);
  return out;
}

/** Back from a file line to column values for the model: base64 to Buffer for the Bytes columns (the importer's half; dates stay ISO strings, which Prisma accepts). */
export function decodeRow(table: MoveTable, line: MoveRow): Record<string, unknown> {
  const { t: _t, ...row } = line;
  void _t;
  for (const c of table.bytes ?? []) if (typeof row[c] === "string") row[c] = Buffer.from(row[c] as string, "base64");
  return row;
}

/** "<company>-<yyyy-mm-dd>.stitchmove.ndjson.gz": the company's name as a safe file name. */
export function moveFileName(shopName: string, when: Date = new Date()): string {
  const slug = shopName
    .normalize("NFKD")
    .replace(/[^\w\s-]/g, "")
    .trim()
    .replace(/\s+/g, "-")
    .toLowerCase()
    .slice(0, 60);
  return `${slug || "company"}-${when.toISOString().slice(0, 10)}${MOVE_SUFFIX}`;
}

/** A line of the file parsed, or an explanation of why not (the importer and the check share it). */
export function parseLine(text: string, lineNo: number): MoveLine {
  let j: unknown;
  try {
    j = JSON.parse(text);
  } catch {
    throw new Error(`line ${lineNo} of the file isn't valid JSON`);
  }
  if (!j || typeof j !== "object" || Array.isArray(j) || typeof (j as { t?: unknown }).t !== "string") throw new Error(`line ${lineNo} of the file isn't a move file line`);
  return j as MoveLine;
}

/** The header checked: the right format and a version this program knows, else the reason. */
export function checkMeta(m: MoveLine): m is MoveMeta {
  if (m.t !== "meta") return false;
  const meta = m as MoveMeta;
  return meta.format === MOVE_FORMAT && Number.isInteger(meta.version) && meta.version >= 1 && meta.version <= MOVE_VERSION && !!meta.shop?.id;
}

/**
 * A cancelled move whose token the hub couldn't be told to forget (it was out of reach): kept in CompanyMove.hubError,
 * and the next hub sync tells it (hub.ts claimShops), so a move file made before the cancel can't take the company.
 */
export const MOVE_CANCEL_PENDING = "cancel-not-sent";

/** Days the old copy of a moved company is kept before it may be deleted (design section 7: by hand, never by itself). */
export const KEEP_MOVED_DAYS = 30;

/** The first day the old copy may be deleted: KEEP_MOVED_DAYS after the hub said the company moved. */
export function deleteFrom(movedOutAt: Date): Date {
  return new Date(movedOutAt.getTime() + KEEP_MOVED_DAYS * 86_400_000);
}

/** The read-only message on the old copy once the company has moved (design section 7): where, when, and when it may go. */
export function movedOutMessage(to: string | null, on: string, deleteOn: string): string {
  return `This company moved${to ? ` to ${to}` : ""} on ${on}. This copy is read-only; delete it after ${deleteOn}.`;
}

/**
 * The read-only message while a company is being moved (design section 7, the freeze), the one every refused write and
 * the banner carry: "This company is moving to <where>; it is read-only here since <date>."
 */
export function movingMessage(moving: { at: Date; to: string | null }, since: string, admin = true): string {
  const where = moving.to ? ` to ${moving.to}` : "";
  return `This company is moving${where}; it is read-only here since ${since}. You can look at and export everything, finish open work and take payments.${admin ? " Cancel the move in Settings → Company to carry on here." : " Ask the shop owner."}`;
}
