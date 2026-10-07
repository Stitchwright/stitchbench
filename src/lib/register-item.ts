// What the register shows for one sellable thing (a stocked part, or a Vac Shop unit), and how a Part becomes one.
// Pure, so both src/actions/register.ts (a "use server" file, which may export only async functions) and the Vac Shop
// unit hooks (src/lib/units/sale-units.ts) can build items.
import type { PartCondition, PartOrigin } from "@/generated/prisma/enums";
import { disclosure } from "@/lib/part-labels";
import { detailsLine } from "@/lib/item-details";
import { readListed } from "@/lib/listed-math";

export type RegisterItem = {
  id: string;
  partNumber: string;
  description: string;
  priceCents: number | null;
  unit: string | null;
  qtyOnHand: number;
  kind: string;
  consigned: boolean;
  /** "used", "compatible, not genuine Brother"...: what the receipt will say about it, empty for a new, genuine item. */
  disclosure: string;
  /** The item's first picture (a fabric's swatch): served by /api/parts/photo/{photoId}. */
  photoId?: string | null;
  /** A machine for sale: the register sells it as one unit line. */
  stockUnitId?: string | null;
  /** The item's or machine's brand: a promotion may cover a brand. */
  brand?: string | null;
  /** Item details in one line ("Isacord 0015 White · 40 wt polyester") and the swatch color (shop-features-round-2-design.md 2.1, 2.2). */
  details?: string;
  colorHex?: string | null;
  colorNumber?: string | null;
  /** Coming soon (shop-features-round-2-design.md 1.2): the day it's expected, and the day in words ("Nov 1"). */
  comingSoonOn?: string | null;
  comingSoonText?: string;
  /** The wholesale price (a Wholesale price group sells at it, 1.5). */
  wholesaleCents?: number | null;
  /** Its own per-yard break (1.6). */
  breakMinQty?: number | null;
  breakPriceCents?: number | null;
  /** Also listed on eBay, Etsy... (shop-features-round-2-design.md 9.7): the places, to take down before selling it. */
  listedOn?: string[];
};

export const viewItem = (p: {
  id: string;
  partNumber: string;
  description: string;
  priceCents: number | null;
  unit: string | null;
  qtyOnHand: number;
  kind: string;
  consignLinkId: string | null;
  brand: string | null;
  condition: PartCondition;
  origin: PartOrigin;
  photos?: { id: string }[];
  itemType?: string | null;
  colorNumber?: string | null;
  colorName?: string | null;
  colorHex?: string | null;
  material?: string | null;
  specs?: unknown;
  comingSoonOn?: string | null;
  wholesaleCents?: number | null;
  membershipGroupId?: string | null;
  breakMinQty?: number | null;
  breakPriceCents?: number | null;
  listedOn?: unknown;
}): RegisterItem => ({
  id: p.id,
  partNumber: p.partNumber,
  description: p.description,
  priceCents: p.priceCents,
  unit: p.unit,
  qtyOnHand: p.qtyOnHand,
  consigned: Boolean(p.consignLinkId),
  disclosure: disclosure(p),
  photoId: p.photos?.[0]?.id ?? null,
  brand: p.brand,
  details: detailsLine(p) || undefined,
  colorHex: p.colorHex ?? null,
  colorNumber: p.colorNumber ?? null,
  comingSoonOn: p.comingSoonOn ?? null,
  wholesaleCents: p.wholesaleCents ?? null,
  breakMinQty: p.breakMinQty ?? null,
  breakPriceCents: p.breakPriceCents ?? null,
  // A membership item is reported (and priced) as a membership (1.5).
  kind: p.membershipGroupId ? "MEMBERSHIP" : p.kind,
  comingSoonText: p.comingSoonOn ? new Date(`${p.comingSoonOn}T12:00:00Z`).toLocaleDateString("en-US", { timeZone: "UTC", month: "short", day: "numeric" }) : undefined,
  listedOn: readListed(p.listedOn).map((x) => x.where),
});

/** What to include with a part so its picture reaches the register: the first photo's id, never the picture itself. */
export const FIRST_PHOTO = { photos: { select: { id: true }, orderBy: { sortOrder: "asc" as const }, take: 1 } };
