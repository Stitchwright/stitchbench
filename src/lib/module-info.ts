// What the paid modules are called and how their state is shown (pure: safe in client components, the CLI and checks).
// The state itself is worked out by src/lib/modules.ts (server). modules-design.md section 5.3.
import { MODULE_IDS, type ModuleId, type ModuleStatus } from "./license";

export { MODULE_IDS };
export type { ModuleId, ModuleStatus };

export type ModuleState = {
  id: ModuleId;
  label: string; // "Vac Shop"
  status: ModuleStatus;
  active: boolean; // on | renew | grace: new work allowed
  lastDay: string | null; // "2027-09-30" of the best window (the admin's off day when switched off)
  graceLastDay: string | null; // "2027-10-14"
  startsOn: string | null; // a later key that hasn't started: "2026-10-01"
  endedAt: Date | null; // lapsed: when new work stopped (section 5.2)
  plan: string | null; // m | y | a | t | a newer plan word
  source: "key" | "admin" | null;
  keyId: string | null;
  switchedOff: boolean; // lapsed because of the admin's "off"
};

export type KeyView = {
  rowId: string;
  keyId: string;
  modules: string[];
  plan: string | null;
  from: string | null;
  lastDay: string | null;
  graceLastDay: string | null;
  issuedTo: string | null;
  addedBy: string | null;
  addedAt: Date;
  state: "current" | "future" | "ended" | "not-valid" | "other-company";
  reason: string | null;
};

export type Modules = {
  shopId: string;
  now: Date;
  clockBehind: boolean;
  floor: Date | null;
  states: Record<ModuleId, ModuleState>;
  keys: KeyView[];
  /** devKeysAllowed() in a production build (section 3.3), for the Settings pill. */
  testBuild: boolean;
  /** Module names on verified keys that this version doesn't know ("needs a newer version of StitchBench"). */
  unknownModules: string[];
};

export const MODULES: Record<ModuleId, { label: string; blurb: string; href: string }> = {
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
    blurb: "Email and texts: reminders, ready-for-pickup notices, estimate links, service reminders, review requests and campaigns.",
  },
};

export const isModuleId = (s: unknown): s is ModuleId => typeof s === "string" && (MODULE_IDS as readonly string[]).includes(s);

/** Who sells modules. The owner fills these in before the first release (INSTALL.md, "Paid modules"). */
export const MODULE_SALES = { email: "", url: "" };

/** mailto: link for "Ask about {label}" / "Renew {label}", or null while MODULE_SALES.email is empty. */
export function salesMailto(kind: "ask" | "renew", label: string, shop: { id: string; name: string }): string | null {
  if (!MODULE_SALES.email) return null;
  const subject = `StitchBench ${label} for ${shop.name}`;
  const body = `${kind === "renew" ? "Please send my renewal key.\n\n" : ""}Company ID: ${shop.id}\nCompany: ${shop.name}\nModule: ${label}\nMonthly or yearly: \n`;
  return `mailto:${MODULE_SALES.email}?subject=${encodeURIComponent(subject)}&body=${encodeURIComponent(body)}`;
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

export const SETTINGS_MODULES_HREF = "/settings/modules";
export const MODULE_SALES_NOTE = "Modules are sold by StitchBench, monthly or yearly. After you pay, you get a key by email. Paste it here. It works without the internet.";

export function canWrite(status: ModuleStatus): boolean {
  return status === "on" || status === "renew" || status === "grace";
}

/** "2027-09-30" -> "Sep 30, 2027" (no time zone involved). */
export function fmtYmd(ymd: string): string {
  const m = /^(\d{4})-(\d{2})-(\d{2})$/.exec(ymd);
  if (!m) return ymd;
  return new Date(Date.UTC(Number(m[1]), Number(m[2]) - 1, Number(m[3]))).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric", year: "numeric" });
}

/** The day a lapsed module ended, as shown ("Sep 30, 2027"): the admin's off day or the key's last day. */
export function endedDay(s: ModuleState): string {
  if (s.switchedOff && s.endedAt) return s.endedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" });
  return s.lastDay ? fmtYmd(s.lastDay) : s.endedAt ? s.endedAt.toLocaleDateString("en-US", { month: "short", day: "numeric", year: "numeric" }) : "-";
}

/** The message requireModule / requireEquipment throw (modules-design.md section 6.6). */
export function blockedMessage(s: ModuleState, admin: boolean): string {
  const { label } = MODULES[s.id];
  if (s.status === "lapsed") {
    if (s.switchedOff) return `${label} was switched off for this company on ${endedDay(s)}. You can still look at and export what's there, and finish work that came in before then.`;
    return `${label} ended on ${endedDay(s)}. You can still look at and export what's there, and finish work that came in before then.${admin ? " To start new work, renew it in Settings → Modules." : " Ask the shop owner to renew it."}`;
  }
  if (s.status === "off" && s.startsOn) return `${label} starts on ${fmtYmd(s.startsOn)}.`;
  return `${label} isn't turned on for this company.${admin ? " An owner can add it in Settings → Modules." : " Ask the shop owner about it."}`;
}

/** write when canWrite; read when lapsed, or off with records; none when off without records. */
export function pageGate(s: ModuleState, hasRecords = false): "write" | "read" | "none" {
  if (canWrite(s.status)) return "write";
  if (s.status === "lapsed" || hasRecords) return "read";
  return "none";
}

/** m "monthly", y "yearly", a "switched on by StitchBench", t "trial", other: the word. */
export function planLabel(plan: string | null): string {
  switch (plan) {
    case "m":
      return "monthly";
    case "y":
      return "yearly";
    case "a":
      return "switched on by StitchBench";
    case "t":
      return "trial";
    default:
      return plan ?? "";
  }
}
