// Helpers every scheduling / messaging check script shares (scheduling-messaging-design.md section 16.2):
//   checkShop({ retail?, repair?, modules?, tz? })   a throwaway company "Check <run>" with an OWNER login and its modules
//   switchFeatures(shopId, modules, on?, at?)        add-ons switched on (or off) as in Settings → Features
//   linkPair(repairShopId, retailShopId)             a PartnerLink pair with one id
//   withSink() / withMock()                          the SMTP sink and the Twilio mock, in this process, on ephemeral ports
//   messagingFor(shopId, { email?, sms? })           message settings pointing at them, secrets sealed
//   cleanup()                                        stops the servers and deletes everything the helpers made
// The check script loads dotenv first and runs with `npm run check <file>` (tsx --conditions=react-server).
import crypto from "node:crypto";
import type { MessagingSettings } from "@/generated/prisma/client";
import { db } from "@/lib/db";
import { seal } from "@/lib/messaging/secrets";
import { MESSAGING_DEFAULTS } from "@/lib/messaging/settings";
import type { FeatureId } from "@/lib/module-info";
import { startSmtpSink } from "../test-mail/smtp-sink.mjs";
import { startTwilioMock } from "../test-mail/twilio-mock.mjs";
import { makeCompany, removeCompany, RUN, type CheckCompany } from "./tenant";

export type CheckShop = CheckCompany & { name: string };
export type MessagingModule = "scheduling" | "marketing" | "vac";

const made: string[] = [];
let n = 0;

/**
 * Add-ons switched on (or off) for a company, as an owner does in Settings → Features (src/lib/features.ts, whose
 * action needs a request): the rows src/lib/modules.ts reads, written straight. Switched off, a module is read-only from
 * `at` on (default now): work that came in before then can still be finished.
 */
export async function switchFeatures(shopId: string, modules: FeatureId[], on = true, at = new Date()): Promise<void> {
  for (const id of modules) {
    await db.shopFeature.upsert({
      where: { shopId_module: { shopId, module: id } },
      create: { shopId, module: id, enabled: on, changedAt: at, byName: "check" },
      update: { enabled: on, changedAt: at, byName: "check" },
    });
  }
}

/**
 * A throwaway company named "Check <run>" (then "Check <run> B", "C", ...) with an OWNER login (check-<run>-<n>@stitchbench.test).
 * `retail` and `repair` choose what it does (neither: a repair shop; both: both). `modules` are switched on in its
 * Features. `tz` is the shop's time zone (default America/New_York, so a check's clock arithmetic doesn't depend on the
 * machine).
 */
export async function checkShop(o: { retail?: boolean; repair?: boolean; modules?: MessagingModule[]; tz?: string } = {}): Promise<CheckShop> {
  const kind = o.retail && o.repair ? "both" : o.retail ? "retail" : "repair";
  const name = `Check ${RUN}${n === 0 ? "" : ` ${String.fromCharCode(65 + n)}`}`;
  n += 1;
  const c = await makeCompany(name, { kind });
  made.push(c.shopId);
  await db.shop.update({ where: { id: c.shopId }, data: { timeZone: o.tz ?? "America/New_York" } });
  if (o.modules?.length) await switchFeatures(c.shopId, o.modules);
  return { ...c, name };
}

/** A PartnerLink on each side with the same id (repair side and retail side), active. */
export async function linkPair(repairShopId: string, retailShopId: string): Promise<string> {
  const id = `chk${crypto.randomBytes(10).toString("hex")}`;
  const repair = await db.shop.findUniqueOrThrow({ where: { id: repairShopId }, select: { name: true } });
  const retail = await db.shop.findUniqueOrThrow({ where: { id: retailShopId }, select: { name: true } });
  await db.partnerLink.createMany({
    data: [
      { id, shopId: repairShopId, side: "repair", partnerName: retail.name },
      { id, shopId: retailShopId, side: "retail", partnerName: repair.name },
    ],
  });
  return id;
}

type Sink = Awaited<ReturnType<typeof startSmtpSink>>;

/** The SMTP sink as a handle that survives stop() / start() on the same SMTP port (a mail server going away and coming back). */
export type SinkHandle = {
  smtpPort: number;
  readonly httpPort: number;
  /** What the sink holds now: { from, to[], user, raw, at } */
  readonly messages: Sink["messages"];
  clear(): void;
  /** Stops listening and drops every connection. */
  stop(): Promise<void>;
  /** Listens again on the same SMTP port with an empty inbox. */
  start(): Promise<void>;
  close(): Promise<void>;
};

let activeSink: SinkHandle | null = null;
let activeMock: MockHandle | null = null;
const servers: { close(): Promise<void> }[] = [];

/** Starts the sink on ephemeral ports and adds `127.0.0.1:<port>` to SMTP_ALLOW_HOSTS (plain, private address allowed for the check). */
export async function withSink(): Promise<SinkHandle> {
  let current: Sink | null = await startSmtpSink({ smtpPort: 0, httpPort: 0 });
  const smtpPort = current.smtpPort;
  const allow = `127.0.0.1:${smtpPort}`;
  const list = (process.env.SMTP_ALLOW_HOSTS ?? "").split(",").map((s) => s.trim()).filter(Boolean);
  if (!list.includes(allow)) process.env.SMTP_ALLOW_HOSTS = [...list, allow].join(",");
  const handle: SinkHandle = {
    smtpPort,
    get httpPort() {
      return current?.httpPort ?? 0;
    },
    get messages() {
      return current?.messages ?? [];
    },
    clear() {
      current?.clear();
    },
    async stop() {
      const c = current;
      current = null;
      await c?.close();
    },
    async start() {
      if (current) return;
      current = await startSmtpSink({ smtpPort, httpPort: 0 });
    },
    async close() {
      await handle.stop();
    },
  };
  servers.push(handle);
  activeSink = handle;
  return handle;
}

type Mock = Awaited<ReturnType<typeof startTwilioMock>>;
export type MockHandle = {
  port: number;
  /** What the mock was asked to send: { sid, to, from, body, at } */
  readonly sent: Mock["sent"];
  clear(): void;
  /** A customer's text to the shop's number (`at` = when it arrived, default now). */
  inbound(from: string, to: string, body: string, at?: Date): Promise<void>;
  close(): Promise<void>;
};

/** Starts the Twilio mock on an ephemeral port and points TWILIO_API_BASE at it. */
export async function withMock(): Promise<MockHandle> {
  const mock = await startTwilioMock({ port: 0 });
  process.env.TWILIO_API_BASE = `http://127.0.0.1:${mock.port}`;
  const handle: MockHandle = {
    port: mock.port,
    sent: mock.sent,
    clear: () => mock.clear(),
    async inbound(from, to, body, at) {
      const res = await fetch(`http://127.0.0.1:${mock.port}/__inbound`, {
        method: "POST",
        headers: { "content-type": "application/json" },
        body: JSON.stringify({ From: from, To: to, Body: body, at: at?.toISOString() }),
      });
      if (!res.ok) throw new Error(`twilio mock /__inbound answered ${res.status}`);
    },
    close: () => mock.close(),
  };
  servers.push(handle);
  activeMock = handle;
  return handle;
}

export type EmailOpts = {
  /** The sink to point at (default: the last withSink()). */
  sink?: { smtpPort: number };
  user?: string;
  pass?: string;
  from?: string;
  replyTo?: string | null;
  /** The admin said someone reads the reply-to mailbox (default true when replyTo is set). */
  watched?: boolean;
  on?: boolean;
};
export type SmsOpts = {
  /** Account SID (AC + 32 hex). */
  sid?: string;
  /** The auth secret saved (default "secret", which the mock accepts). */
  token?: string;
  /** The shop's Twilio number (default +12125550100). */
  from?: string;
  on?: boolean;
};

/** Any MessagingSettings column, written last. */
export type MessagingOverrides = Partial<Omit<MessagingSettings, "shopId" | "updatedAt">>;

const hex32 = () => crypto.randomBytes(16).toString("hex");

/**
 * Writes the company's MessagingSettings: `email` points at the SMTP sink (host 127.0.0.1, security none, the password
 * sealed), `sms` at the Twilio mock (SID, sealed token, number), the time zone confirmed, a postal address and, with a
 * reply-to, "someone reads it" ticked. `settings` overrides any column last (quiet hours, caps, inboundAt, ...).
 * Asking for neither leaves both channels off.
 */
export async function messagingFor(shopId: string, o: { email?: EmailOpts | true; sms?: SmsOpts | true; settings?: MessagingOverrides } = {}): Promise<void> {
  const now = new Date();
  const data: Omit<MessagingSettings, "shopId" | "updatedAt"> = { ...MESSAGING_DEFAULTS, tzConfirmedAt: now, tzConfirmedBy: "check", postalAddress: "1 Main St, Springfield" };
  if (o.email) {
    const e: EmailOpts = o.email === true ? {} : o.email;
    const sink = e.sink ?? activeSink;
    if (!sink) throw new Error("messagingFor: call withSink() first (or pass email.sink)");
    const replyTo = e.replyTo === undefined ? "replies@stitchbench.test" : e.replyTo;
    Object.assign(data, {
      emailOn: e.on ?? true,
      smtpPreset: "other",
      smtpHost: "127.0.0.1",
      smtpPort: sink.smtpPort,
      smtpSecurity: "none",
      smtpUser: e.user ?? "check-user",
      smtpPassSealed: seal(e.pass ?? "check-pass", shopId, "smtpPass"),
      smtpPassSavedAt: now,
      fromName: "Check Shop",
      fromEmail: e.from ?? "shop@stitchbench.test",
      replyTo,
      replyWatchedAt: replyTo && (e.watched ?? true) ? now : null,
      replyWatchedBy: replyTo && (e.watched ?? true) ? "check" : null,
    });
  }
  if (o.sms) {
    if (!activeMock && !process.env.TWILIO_API_BASE) throw new Error("messagingFor: call withMock() first");
    const s: SmsOpts = o.sms === true ? {} : o.sms;
    Object.assign(data, {
      smsOn: s.on ?? true,
      twilioSid: s.sid ?? `AC${hex32()}`,
      twilioTokenSealed: seal(s.token ?? "secret", shopId, "twilioToken"),
      twilioTokenSavedAt: now,
      twilioFrom: s.from ?? "+12125550100",
    });
  }
  Object.assign(data, o.settings ?? {});
  const { templates, abandonDays, consentTexts, testPhones, ...rest } = data;
  // Json / array columns need Prisma's own input types; the defaults are plain values already.
  const create = { shopId, ...rest, templates: templates ?? {}, abandonDays, consentTexts, testPhones } as Parameters<typeof db.messagingSettings.create>[0]["data"];
  const { shopId: _ignored, ...update } = create as { shopId: string } & Record<string, unknown>;
  void _ignored;
  await db.messagingSettings.upsert({ where: { shopId }, create, update: update as Parameters<typeof db.messagingSettings.update>[0]["data"] });
}

/** Stops the kick timer queue.ts starts after an insert (it would run the worker for every shop 2 s later). */
export function clearKick(): void {
  const g = globalThis as unknown as { __messageKick?: NodeJS.Timeout | null };
  if (g.__messageKick) clearTimeout(g.__messageKick);
  g.__messageKick = null;
}

/** Stops the servers and deletes the companies the helpers made (cascade) and any "Check <run>" company still around. */
export async function cleanup(): Promise<void> {
  clearKick();
  for (const s of servers.splice(0)) await s.close().catch(() => {});
  activeSink = null;
  activeMock = null;
  for (const id of made.splice(0)) await removeCompany(id).catch((e) => console.error(`cleanup: ${id}:`, e instanceof Error ? e.message : e));
  const left = await db.shop.findMany({ where: { name: { startsWith: `Check ${RUN}` } }, select: { id: true } });
  for (const s of left) await removeCompany(s.id).catch((e) => console.error(`cleanup: ${s.id}:`, e instanceof Error ? e.message : e));
  clearKick();
}
