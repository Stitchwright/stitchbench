// What the add-on modules are called and how their state is shown (pure: safe in client components and checks). The
// state itself is worked out by src/lib/modules.ts (server). modules-design.md section 5.3; since 1.8 the five trade
// modules are free and switched on in Settings → Features (free-software-design.md section 7, decision 6).
import { MODULE_IDS, type ModuleId, type ModuleStatus } from "./license";

export { MODULE_IDS };
export type { ModuleId, ModuleStatus };

export type ModuleState = {
  id: ModuleId;
  label: string; // "Vac Shop"
  status: ModuleStatus;
  active: boolean; // on | renew | grace: new work allowed
  lastDay: string | null; // a key's: "2027-09-30" of the best window
  graceLastDay: string | null; // "2027-10-14"
  startsOn: string | null; // a later key that hasn't started: "2026-10-01"
  endedAt: Date | null; // lapsed: when new work stopped (section 5.2), or when the feature was switched off
  /** feature: Settings → Features decides (the five trade modules); key: a license key (the Assistant, the program itself). */
  source: "feature" | "key" | null;
  keyId: string | null;
  switchedOff: boolean; // a feature switched off in Settings → Features (lapsed: work already in can be finished)
};

export type Modules = {
  shopId: string;
  now: Date;
  states: Record<ModuleId, ModuleState>;
  /**
   * The company is being moved to another install (company-move-design.md section 7): Shop.movingAt is set, and this copy
   * is read-only through the same gate as a lapsed program key, whatever the key says. Null when not moving.
   */
  moving: Moving | null;
};

/** at: the owner confirmed the move (Shop.movingAt); to: where it is going, then where it went; outAt: the hub (or the owner) said it moved. */
export type Moving = { at: Date; to: string | null; outAt: Date | null };

/**
 * Which program this is, by the same variables src/lib/shops.ts appName() reads (this file stays pure, so it reads them
 * itself). In the browser neither is set, so a client component says StitchBench; the pages are rendered on the server.
 */
export function programName(): "StitchShop" | "StitchBench" {
  return process.env.APP_NAME === "StitchShop" || (!process.env.APP_NAME && process.env.DEFAULT_SHOP_KIND === "retail") ? "StitchShop" : "StitchBench";
}

export const SETTINGS_ACCOUNT_HREF = "/settings/account";

export const MODULES: Record<ModuleId, { label: string; blurb: string; href: string }> = {
  // The program itself (hub-accounts-billing-design.md 3.5): its key comes from StitchHub with the sync, and only counts
  // where the owner's hosting is billed (HOSTING_BILLING=on, src/lib/modules.ts).
  base: {
    label: programName(),
    href: SETTINGS_ACCOUNT_HREF,
    blurb: "The program itself.",
  },
  vac: {
    label: "Vac Shop",
    href: "/vac",
    blurb: "Vacuum repairs, a bag, belt and filter finder, vacuums for sale with warranties and trade-ins, bags-due reminders and central vac installs.",
  },
  appliance: {
    label: "Small Appliance Repair",
    href: "/tickets/new?kind=stand-mixer",
    blurb: "Repair tickets for stand mixers, 3D printers and other small appliances, each with its own check-in questions, checklist and service menu.",
  },
  scheduling: {
    label: "Scheduling",
    href: "/calendar",
    blurb: "Classes and workshops, appointments, repair pickup runs with partner shops, and staff shifts.",
  },
  marketing: {
    label: "Marketing",
    href: "/messages",
    // Ready-for-pickup and parts-in notices and estimate links are in the base since 7 Oct 2026 (pricing-review-2026-10.md).
    blurb: "Email and text marketing: campaigns, service reminders, review requests, not-picked-up notices, class and appointment reminders, and customer import.",
  },
  maker: {
    label: "Maker Shop",
    href: "/maker",
    blurb: "For shops that sell 3D printers, cutters and lasers: running-low reminders for printer and cutter owners, maker-space time on your own printer or laser, and print and cut jobs from quote to pickup.",
  },
  assistant: {
    label: "Assistant",
    href: "/settings/assistant",
    blurb: "Drafts the invoice and customer messages from a tech's notes, suggests likely causes from your own tickets and the community's gotchas, and reads a rating plate from a photo.",
  },
};

export const isModuleId = (s: unknown): s is ModuleId => typeof s === "string" && (MODULE_IDS as readonly string[]).includes(s);

/**
 * The add-ons every company may switch on or off in Settings → Features, free (free-software-design.md section 7,
 * decision 6): off until the shop chooses one, so its screens stay simple. Not the program itself, and not the
 * Assistant, which a key from StitchHub still decides (it is bought on the StitchHub account).
 */
export const FEATURE_IDS = ["vac", "appliance", "scheduling", "marketing", "maker"] as const satisfies readonly ModuleId[];
export type FeatureId = (typeof FEATURE_IDS)[number];
export const isFeatureId = (s: unknown): s is FeatureId => typeof s === "string" && (FEATURE_IDS as readonly string[]).includes(s);

/**
 * What the program's own key allows (hub-accounts-billing-design.md 3.5). "off" (no key, or anywhere hosting isn't
 * billed: the Windows program, a self-hosted server) is fully working; only "lapsed" makes the company read-only.
 */
export function baseWritable(status: ModuleStatus): boolean {
  return status === "off" || canWrite(status);
}

/**
 * The message every refused write carries while the program is read-only: only on the owner's hosted service, when its
 * hosting wasn't paid (HOSTING_BILLING=on). The company can always leave for the free Windows program.
 */
export function readOnlyMessage(s: ModuleState, admin = true): string {
  return `${programName()} for this company is read-only since ${endedDay(s)}. You can look at and export everything, finish open work and take payments.${admin ? " Pay for the hosting on your StitchHub account (Settings → Account), or move the company to the free Windows program (Settings → Company)." : " Ask the shop owner."}`;
}

export type NavGate = "on" | "readonly" | "hidden";

/** active -> on, lapsed -> readonly, off -> hidden (pure). */
export function toNavGates(m: Modules): Record<ModuleId, NavGate> {
  const out = {} as Record<ModuleId, NavGate>;
  for (const id of MODULE_IDS) {
    const s = m.states[id];
    out[id] = s.active ? "on" : s.status === "lapsed" ? "readonly" : "hidden";
  }
  return out;
}

export const SETTINGS_FEATURES_HREF = "/settings/features";

export function canWrite(status: ModuleStatus): boolean {
  return status === "on" || status === "renew" || status === "grace";
}

/** "2027-09-30" -> "Sep 30, 2027" (no time zone involved). */
export function fmtYmd(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

/** The day a lapsed module ended, as shown ("Sep 30, 2027"): the day it was switched off, or the key's last day. */
export function endedDay(s: ModuleState): string {
  if (s.switchedOff && s.endedAt) return s.endedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return s.lastDay ? fmtYmd(s.lastDay) : s.endedAt ? s.endedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "-";
}

/** The message requireModule / requireEquipment throw (modules-design.md section 6.6). */
export function blockedMessage(s: ModuleState, admin: boolean): string {
  const { label } = MODULES[s.id];
  // The program itself: "off" never blocks, so the only refusal is the read-only one.
  if (s.id === "base") return readOnlyMessage(s, admin);
  if (isFeatureId(s.id)) {
    if (s.status === "lapsed") {
      return `${label} was switched off for this company on ${endedDay(s)}. You can still look at and export what's there, and finish work that came in before then.${admin ? " To start new work, switch it on again in Settings → Features." : " Ask the shop owner or an admin to switch it on again."}`;
    }
    return `${label} isn't switched on for this company.${admin ? " It's free: switch it on in Settings → Features." : " Ask the shop owner or an admin to switch it on in Settings → Features."}`;
  }
  // The Assistant, as it always worked: bought on the company's StitchHub account, its key arrives with the sync.
  if (s.status === "lapsed") {
    return `${label} ended on ${endedDay(s)}. You can still look at and export what's there, and finish work that came in before then.${admin ? " To use it again, add it on your StitchHub account (Settings → Account)." : " Ask the shop owner about it."}`;
  }
  if (s.status === "off" && s.startsOn) return `${label} starts on ${fmtYmd(s.startsOn)}.`;
  return `${label} isn't turned on for this company.${admin ? " Add it on your StitchHub account (Settings → Account)." : " Ask the shop owner about it."}`;
}

/** write when canWrite; read when lapsed, or off with records; none when off without records. */
export function pageGate(s: ModuleState, hasRecords = false): "write" | "read" | "none" {
  if (canWrite(s.status)) return "write";
  if (s.status === "lapsed" || hasRecords) return "read";
  return "none";
}
