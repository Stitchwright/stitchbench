// What the register shows for one sellable thing (a stocked part, or a Vac Shop unit), and how a Part becomes one.
// Pure, so both src/actions/register.ts (a "use server" file, which may export only async functions) and the Vac Shop
// unit hooks (src/lib/vac/sale-units.ts) can build items.
import type { PartCondition, PartOrigin } from "@/generated/prisma/enums";
import { disclosure } from "@/lib/part-labels";

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
  /** A vacuum in stock (Vac Shop): the register sells it as one unit line. */
  stockUnitId?: string | null;
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
}): RegisterItem => ({
  id: p.id,
  partNumber: p.partNumber,
  description: p.description,
  priceCents: p.priceCents,
  unit: p.unit,
  qtyOnHand: p.qtyOnHand,
  kind: p.kind,
  consigned: Boolean(p.consignLinkId),
  disclosure: disclosure(p),
});
