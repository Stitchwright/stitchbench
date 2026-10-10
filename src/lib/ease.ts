import "server-only";
// "What's new" and "Getting started" (docs/plans/ease-of-use-design.md sections 2 and 3). Both only read the person's or
// the shop's own rows (count / exists, filtered by shopId).
import { db } from "@/lib/db";
import { appName, programVersion } from "@/lib/shops";
import { WHATS_NEW } from "@/lib/whats-new";

// ---------- What's new ----------

/** Compares "1.7.10" with "1.7.9" number by number; a text that isn't a version counts as 0.0.0. */
export function compareVersions(a: string, b: string): number {
  const n = (v: string) => (/^\d+(\.\d+){0,2}$/.test(v) ? v.split(".").map(Number) : [0]);
  const x = n(a);
  const y = n(b);
  for (let i = 0; i < 3; i++) {
    const d = (x[i] ?? 0) - (y[i] ?? 0);
    if (d) return d;
  }
  return 0;
}

/** The newest entry that has lines for this program. */
function newestVersion(): string | null {
  return WHATS_NEW.find((e) => linesFor(e).length)?.version ?? null;
}

const linesFor = (e: (typeof WHATS_NEW)[number]) => (appName() === "StitchShop" ? e.stitchshop : e.stitchbench);

/**
 * The version this copy is at, for "What's new": the program's own version when it is one (the Windows program, or a
 * hosted service given STITCH_VERSION); a hosted build's short commit isn't, and a developer's copy has none, so the
 * newest entry stands in.
 */
export function currentWhatsNewVersion(): string | null {
  const v = programVersion();
  return v && /^\d+\.\d+\.\d+$/.test(v) ? v : newestVersion();
}

/** Shops and people created before this day have seen the program as of 1.7.0 (the card first shipped with 1.7.1). */
const CARD_STARTS = new Date("2026-10-10T00:00:00Z");
const BEFORE_CARD = "1.7.0";

/** Every entry for this program, newest first (the Settings page). */
export function allWhatsNew() {
  return WHATS_NEW.map((e) => ({ version: e.version, date: e.date, lines: linesFor(e) })).filter((e) => e.lines.length);
}

/**
 * The lines this person hasn't seen yet, or null. A person with nothing recorded who was made after the card shipped is
 * brought up to date silently (new people don't get a card); one made before it last saw 1.7.0.
 */
export async function whatsNewFor(userId: string): Promise<{ version: string; entries: { version: string; date: string; lines: string[] }[] } | null> {
  const current = currentWhatsNewVersion();
  if (!current) return null;
  const u = await db.user.findUnique({ where: { id: userId }, select: { whatsNewSeen: true, createdAt: true } });
  if (!u) return null;
  let seen = u.whatsNewSeen;
  if (seen == null) {
    if (u.createdAt >= CARD_STARTS) {
      await db.user.updateMany({ where: { id: userId, whatsNewSeen: null }, data: { whatsNewSeen: current } });
      return null;
    }
    seen = BEFORE_CARD;
  }
  const entries = allWhatsNew().filter((e) => compareVersions(e.version, seen) > 0 && compareVersions(e.version, current) <= 0);
  return entries.length ? { version: current, entries } : null;
}

// ---------- Getting started ----------

export type StartStep = { key: string; label: string; href: string; done: boolean };

const yes = (n: number) => n > 0;

/**
 * The shop's setup list, worked out from its own rows; null when the owner hid it or everything is done. Different for
 * the repair bench (StitchBench, or any shop that does repairs) and the shop counter (StitchShop).
 */
export async function gettingStarted(shopId: string): Promise<{ steps: StartStep[]; done: number } | null> {
  const shop = await db.shop.findUnique({ where: { id: shopId }, select: { doesRepair: true, gettingStartedHiddenAt: true } });
  if (!shop || shop.gettingStartedHiddenAt) return null;
  const bench = shop.doesRepair;
  const [customers, machines, collected, parts, sales, people, ms, hub, offsite] = await Promise.all([
    db.customer.count({ where: { shopId }, take: 1 }),
    bench ? db.machine.count({ where: { shopId }, take: 1 }) : 0,
    bench ? db.ticket.count({ where: { shopId, status: "COLLECTED" }, take: 1 }) : 0,
    db.part.count({ where: { shopId, kind: { not: "MACHINE" } }, take: 1 }),
    bench ? 0 : db.sale.count({ where: { shopId }, take: 1 }),
    bench ? 0 : db.user.count({ where: { shopId, active: true } }),
    db.messagingSettings.findUnique({ where: { shopId }, select: { smsOn: true, emailOn: true, smsRegisteredAt: true } }),
    db.hubState.count({ where: { id: 1, installKey: { not: null } } }),
    db.offsiteSettings.count({ where: { shopId, on: true } }),
  ]);
  // Texts are set up when texting is on, or the person ticked "We've registered"; email alone also counts as a start.
  const texting = Boolean(ms && (ms.smsOn || ms.smsRegisteredAt || ms.emailOn));
  // A copy of the shop's data somewhere else: off-site backup on, or joined to StitchHub.
  const backup = yes(offsite) || yes(hub);
  const steps: StartStep[] = bench
    ? [
        { key: "customer", label: "Add your first customer", href: "/customers", done: yes(customers) },
        { key: "machine", label: "Check in your first machine", href: "/tickets/new", done: yes(machines) },
        { key: "collected", label: "Finish a repair and hand the machine back", href: "/tickets", done: yes(collected) },
        { key: "part", label: "Add a part to your shelf", href: "/parts", done: yes(parts) },
        { key: "texting", label: "Set up texts and email to customers", href: "/settings/messages", done: texting },
        { key: "backup", label: "Keep a safe copy of your shop's records", href: "/settings/offsite", done: backup },
      ]
    : [
        { key: "customer", label: "Add your first customer", href: "/customers", done: yes(customers) },
        { key: "item", label: "Add something you sell", href: "/parts", done: yes(parts) },
        { key: "sale", label: "Ring up your first sale", href: "/register", done: yes(sales) },
        { key: "people", label: "Add the people who work at the counter", href: "/settings#people", done: people > 1 },
        { key: "texting", label: "Set up texts and email to customers", href: "/settings/messages", done: texting },
        { key: "backup", label: "Keep a safe copy of your shop's records", href: "/settings/offsite", done: backup },
      ];
  const done = steps.filter((s) => s.done).length;
  return done === steps.length ? null : { steps, done };
}
