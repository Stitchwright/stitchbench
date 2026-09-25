// The terms two partner shops agree to (repair commission, consignment split, statements), shared by the settings
// form, the printable agreement and the statements. Safe on server and client.

export type PartnerTerms = {
  /** The sewing shop's share of each repair it takes in. */
  repairCommissionPct: number;
  /** service = service and labor lines (not parts); total = the whole bill before tax */
  commissionOn: "service" | "total";
  /** Where customers pay for repairs. */
  customersPay: "shop" | "repair" | "either";
  pickupDay: string | null;
  turnaroundDays: number | null;
  /** The sewing shop keeps this share of what consigned stock sells for. */
  consignSharePct: number;
  /** The sewing shop answers for consigned stock lost or damaged while in its care. */
  shopCoversLoss: boolean;
  /** The repair shop sets up and supports StitchShop for the sewing shop at no charge, while the partnership lasts. */
  softwareByRepairShop: boolean;
  payWithinDays: number;
  abandonedAfterDays: number;
  noticeDays: number;
  otherTerms: string | null;
};

export const DEFAULT_TERMS: PartnerTerms = {
  repairCommissionPct: 15,
  commissionOn: "service",
  customersPay: "shop",
  pickupDay: null,
  turnaroundDays: 14,
  consignSharePct: 30,
  shopCoversLoss: true,
  softwareByRepairShop: true,
  payWithinDays: 15,
  abandonedAfterDays: 60,
  noticeDays: 30,
  otherTerms: null,
};

const num = (v: unknown, min: number, max: number, dflt: number) => {
  const n = typeof v === "number" ? v : Number(String(v ?? "").trim());
  return Number.isFinite(n) && String(v ?? "").toString().trim() !== "" ? Math.min(max, Math.max(min, n)) : dflt;
};
const text = (v: unknown, max: number) => {
  const s = String(v ?? "").trim();
  return s ? s.slice(0, max) : null;
};

/** Terms from anywhere (the hub, a form, an older version), with defaults for anything missing or out of range. */
export function normalizeTerms(raw: unknown): PartnerTerms {
  const r = (raw && typeof raw === "object" ? raw : {}) as Record<string, unknown>;
  return {
    repairCommissionPct: num(r.repairCommissionPct, 0, 50, DEFAULT_TERMS.repairCommissionPct),
    commissionOn: r.commissionOn === "total" ? "total" : "service",
    customersPay: r.customersPay === "repair" || r.customersPay === "either" ? r.customersPay : "shop",
    pickupDay: text(r.pickupDay, 40),
    turnaroundDays: r.turnaroundDays == null || r.turnaroundDays === "" ? null : num(r.turnaroundDays, 1, 120, 14),
    consignSharePct: num(r.consignSharePct, 0, 90, DEFAULT_TERMS.consignSharePct),
    shopCoversLoss: r.shopCoversLoss === undefined ? true : r.shopCoversLoss === true || r.shopCoversLoss === "on" || r.shopCoversLoss === "true",
    softwareByRepairShop:
      r.softwareByRepairShop === undefined ? true : r.softwareByRepairShop === true || r.softwareByRepairShop === "on" || r.softwareByRepairShop === "true",
    payWithinDays: num(r.payWithinDays, 1, 90, DEFAULT_TERMS.payWithinDays),
    abandonedAfterDays: num(r.abandonedAfterDays, 14, 365, DEFAULT_TERMS.abandonedAfterDays),
    noticeDays: num(r.noticeDays, 0, 180, DEFAULT_TERMS.noticeDays),
    otherTerms: text(r.otherTerms, 4000),
  };
}

export function termsFromForm(fd: FormData): PartnerTerms {
  const o: Record<string, unknown> = {};
  for (const k of Object.keys(DEFAULT_TERMS)) o[k] = fd.get(k);
  o.shopCoversLoss = fd.get("shopCoversLoss") === "on";
  o.softwareByRepairShop = fd.get("softwareByRepairShop") === "on";
  return normalizeTerms(o);
}

/** The same terms always give the same string, so both sides can tell they accepted the same thing. */
export function termsKey(t: PartnerTerms): string {
  const n = normalizeTerms(t);
  return JSON.stringify(Object.keys(DEFAULT_TERMS).sort().map((k) => [k, n[k as keyof PartnerTerms]]));
}

export const CUSTOMERS_PAY_LABEL: Record<PartnerTerms["customersPay"], string> = {
  shop: "at the sewing shop's counter",
  repair: "to the repair shop",
  either: "at either shop",
};

export const COMMISSION_ON_LABEL: Record<PartnerTerms["commissionOn"], string> = {
  service: "the service and labor on the bill (not parts)",
  total: "the whole bill before sales tax",
};

/** The sewing shop's commission on one repair, from the repair shop's bill lines. */
export function repairCommission(lines: { kind: string; amountCents: number }[], terms: Pick<PartnerTerms, "repairCommissionPct" | "commissionOn">) {
  // A discount on the bill comes off the base either way.
  const base = lines
    .filter((l) => terms.commissionOn === "total" || l.kind === "SERVICE" || l.kind === "LABOR" || l.kind === "DISCOUNT")
    .reduce((s, l) => s + l.amountCents, 0);
  return Math.max(0, Math.round((base * terms.repairCommissionPct) / 100));
}

export type Acceptance = { name: string; at: string; version: number };
export type Accepted = { repair?: Acceptance; retail?: Acceptance };

export function acceptedBoth(accepted: Accepted, version: number) {
  return accepted.repair?.version === version && accepted.retail?.version === version;
}
